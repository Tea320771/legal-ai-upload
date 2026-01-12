// /api/redact-document.js
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createClient } from '@supabase/supabase-js';

// 1. 환경변수 설정
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

export const config = {
    api: {
        bodyParser: {
            sizeLimit: '10mb',
        },
    },
};

// 2. 모델 시도 목록 (순서대로)
const MODELS_TO_TRY = [
    "gemini-1.5-flash",
    "gemini-1.5-flash-001",
    "gemini-1.5-pro",
    "gemini-pro"
];

export default async function handler(req, res) {
    console.log("🚀 API 호출됨: redact-document (Safety Mode)");

    // [디버깅] API 키 로드 여부 확인 (앞 4자리만 출력)
    const keyStatus = process.env.GEMINI_API_KEY ? `Loaded (${process.env.GEMINI_API_KEY.substring(0,4)}...)` : "MISSING";
    console.log(`🔑 API Key Status: ${keyStatus}`);

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    try {
        let { fileBase64, fileName } = req.body;
        if (!fileBase64) throw new Error("파일 데이터가 없습니다.");

        // Base64 헤더 제거
        const base64Data = fileBase64.includes("base64,") ? fileBase64.split("base64,")[1] : fileBase64;

        // ============================================================
        // [Task A] 폰트 준비 (나눔고딕 -> 실패 시 기본폰트)
        // ============================================================
        const loadFont = async () => {
            try {
                // 더 확실한 나눔고딕 주소 사용
                const fontUrl = 'https://raw.githubusercontent.com/google/fonts/main/ofl/nanumgothic/NanumGothic-Bold.ttf';
                console.log("Bg 폰트 다운로드 시작:", fontUrl);
                
                const response = await fetch(fontUrl);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                
                const fontBuffer = await response.arrayBuffer();
                console.log("✅ 한글 폰트(나눔고딕) 다운로드 성공");
                return { fontData: fontBuffer, type: 'custom' };
            } catch (e) {
                console.error("⚠️ 폰트 다운로드 실패 (기본 폰트 사용):", e.message);
                return { fontData: null, type: 'standard' }; // 실패해도 죽지 않고 'standard' 반환
            }
        };

        // ============================================================
        // [Task B] AI 분석 (실패해도 빈 값 반환)
        // ============================================================
        const analyzeDoc = async () => {
            for (const modelName of MODELS_TO_TRY) {
                try {
                    console.log(`🤖 AI 분석 시도: ${modelName}`);
                    const model = genAI.getGenerativeModel({ model: modelName });
                    
                    const result = await model.generateContent([
                        { text: "이 문서의 법원명, 사건번호, 원고/피고, 대리인 이름을 JSON으로 추출해. { \"court\": \"...\", \"caseNo\": \"...\", \"parties\": \"...\", \"lawyer\": \"...\" }" },
                        { inlineData: { data: base64Data, mimeType: "application/pdf" } }
                    ]);
                    
                    let text = result.response.text().replace(/```json/g, "").replace(/```/g, "").trim();
                    console.log(`✅ AI 분석 성공 (${modelName})`);
                    return JSON.parse(text);
                } catch (e) {
                    console.warn(`⚠️ ${modelName} 실패: ${e.message}`);
                    continue;
                }
            }
            console.error("❌ 모든 AI 모델 실패 (기본값 사용)");
            return { court: "분석실패", caseNo: "정보없음", parties: "", lawyer: "" };
        };

        // 병렬 실행 (둘 다 절대 에러를 throw하지 않음)
        const [fontResult, metaInfo] = await Promise.all([loadFont(), analyzeDoc()]);

        // ============================================================
        // [Task C] PDF 생성
        // ============================================================
        const pdfDoc = await PDFDocument.load(base64Data);
        pdfDoc.registerFontkit(fontkit);

        let useFont;
        if (fontResult.type === 'custom') {
            useFont = await pdfDoc.embedFont(fontResult.fontData);
        } else {
            // 폰트 다운로드 실패 시 영문 기본 폰트 사용 (한글은 깨질 수 있음)
            useFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
        }

        const pages = pdfDoc.getPages();
        const firstPage = pages[0];
        const { width, height } = firstPage.getSize();

        // 마스킹 (흰색 상자)
        firstPage.drawRectangle({ x: 0, y: height - 350, width: width, height: 350, color: rgb(1, 1, 1) });

        // 텍스트 쓰기
        let textY = height - 50;
        const fontSize = 12;

        const safeDraw = (text, y) => {
            try {
                // 한글 폰트가 없으면 영문으로 대체 메시지 출력
                const content = fontResult.type === 'custom' ? text : "[Font Error] Text Hidden";
                firstPage.drawText(content, { x: 50, y: y, size: fontSize, font: useFont, color: rgb(0, 0, 0) });
            } catch (err) { console.error("그리기 실패:", err); }
        };

        firstPage.drawText(fontResult.type === 'custom' ? "🔒 [보안 처리된 문서]" : "SECURE DOCUMENT", {
            x: 50, y: textY, size: 16, font: useFont, color: rgb(0, 0.5, 0)
        });
        textY -= 40;

        safeDraw(`법원: ${metaInfo.court}`, textY); textY -= 20;
        safeDraw(`사건: ${metaInfo.caseNo}`, textY); textY -= 20;
        safeDraw(`당사자: ${metaInfo.parties}`, textY); textY -= 20;
        safeDraw(`대리인: ${metaInfo.lawyer}`, textY);

        const pdfBytes = await pdfDoc.save();

        // ============================================================
        // [Task D] 업로드
        // ============================================================
        const timestamp = new Date().getTime();
        const safeName = `SECURE_${timestamp}_${fileName.replace(/[^a-zA-Z0-9.]/g, "_")}`;

        const { error: uploadError } = await supabase.storage
            .from('legal-docs')
            .upload(safeName, pdfBytes, { contentType: 'application/pdf', upsert: true });

        if (uploadError) throw uploadError;

        const publicUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/legal-docs/${safeName}`;

        await supabase.from('document_queue').insert({
            filename: fileName, file_url: publicUrl, status: 'pending', ai_result: {}
        });

        return res.status(200).json({ success: true, message: "완료", fileUrl: publicUrl, extractedMeta: metaInfo });

    } catch (error) {
        console.error("Final Server Error:", error);
        return res.status(500).json({ error: error.message });
    }
}