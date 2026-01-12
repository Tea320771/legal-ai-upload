// /api/redact-document.js
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createClient } from '@supabase/supabase-js';

export const config = {
    api: {
        bodyParser: {
            sizeLimit: '10mb',
        },
    },
};

const MODELS_TO_TRY = [
    "gemini-1.5-flash",
    "gemini-1.5-flash-001",
    "gemini-1.5-pro",
    "gemini-pro"
];

export default async function handler(req, res) {
    console.log("🚀 API 호출됨: redact-document (Diagnosis Mode)");

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    try {
        // [중요] 환경변수 로드 및 '공백 제거(.trim())'
        // 키 뒤에 숨어있는 엔터나 띄어쓰기를 없애줍니다.
        const apiKey = process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.trim() : "";
        const supabaseUrl = process.env.SUPABASE_URL ? process.env.SUPABASE_URL.trim() : "";
        const supabaseKey = process.env.SUPABASE_KEY ? process.env.SUPABASE_KEY.trim() : "";

        if (!apiKey) throw new Error("GEMINI_API_KEY가 환경변수에 없습니다.");
        
        // 키가 정상적으로 들어왔는지 길이와 앞/뒤 문자 확인
        console.log(`🔑 API Key 확인: 길이(${apiKey.length}), 시작(${apiKey.substring(0,4)}...), 끝(...${apiKey.substring(apiKey.length-4)})`);

        const genAI = new GoogleGenerativeAI(apiKey);
        const supabase = createClient(supabaseUrl, supabaseKey);

        let { fileBase64, fileName } = req.body;
        if (!fileBase64) throw new Error("파일 데이터가 없습니다.");

        let cleanBase64 = fileBase64;
        if (cleanBase64.includes("base64,")) cleanBase64 = cleanBase64.split("base64,")[1];
        cleanBase64 = cleanBase64.replace(/[\r\n\s]/g, '');

        // ============================================================
        // [진단 Task] 사용 가능한 모델 목록 조회 (List Models)
        // 이 함수가 성공하면 키는 정상입니다. 여기서 실패하면 키/권한 문제입니다.
        // ============================================================
        try {
            console.log("🔍 API 권한 확인 중 (List Models)...");
            // API 키로 접근 가능한 모델 리스트를 요청해봅니다.
            // (SDK 버전에 따라 listModels가 없을 수도 있어 getGenerativeModel로 대체 테스트)
            const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
            await model.generateContent("Test"); 
            console.log("✅ API 키 권한 정상 확인됨 (기본 모델 통신 성공)");
        } catch (e) {
            console.error("❌ API 키 권한 오류 발생!");
            console.error("에러 내용:", e.message);
            console.error("👉 조치 방법: Google Cloud Console에서 'Generative Language API'가 Enable 되어 있는지 확인하세요.");
            // 여기서 에러가 나도 일단 진행해봅니다.
        }

        // ============================================================
        // [Task A] 폰트 다운로드
        // ============================================================
        const loadFont = async () => {
            try {
                const fontUrl = 'https://raw.githubusercontent.com/google/fonts/main/ofl/nanumgothic/NanumGothic-Bold.ttf';
                const response = await fetch(fontUrl);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return { fontData: await response.arrayBuffer(), type: 'custom' };
            } catch (e) {
                console.error("⚠️ 폰트 실패 (기본 폰트 사용):", e.message);
                return { fontData: null, type: 'standard' };
            }
        };

        // ============================================================
        // [Task B] AI 분석
        // ============================================================
        const analyzeDoc = async () => {
            for (const modelName of MODELS_TO_TRY) {
                try {
                    console.log(`🤖 모델 시도: ${modelName}`);
                    
                    const model = genAI.getGenerativeModel({ 
                        model: modelName,
                        generationConfig: { temperature: 0.1 }
                    });

                    const result = await model.generateContent({
                        contents: [{
                            role: "user",
                            parts: [
                                { text: "이 문서의 법원명, 사건번호, 원고/피고, 대리인 이름을 JSON으로 추출해. {\"court\":\"...\", \"caseNo\":\"...\", \"parties\":\"...\", \"lawyer\":\"...\"}" },
                                { inlineData: { data: cleanBase64, mimeType: "application/pdf" } }
                            ]
                        }]
                    });
                    
                    let text = result.response.text().replace(/```json/g, "").replace(/```/g, "").trim();
                    console.log(`✅ 성공 (${modelName})`);
                    return JSON.parse(text);

                } catch (e) {
                    console.warn(`⚠️ ${modelName} 실패: ${e.message}`);
                    continue;
                }
            }
            console.error("❌ 모든 모델 실패");
            return { court: "분석실패", caseNo: "정보없음", parties: "", lawyer: "" };
        };

        const [fontResult, metaInfo] = await Promise.all([loadFont(), analyzeDoc()]);

        // ============================================================
        // [Task C] PDF 생성
        // ============================================================
        const pdfDoc = await PDFDocument.load(cleanBase64);
        pdfDoc.registerFontkit(fontkit);

        let useFont = fontResult.type === 'custom' 
            ? await pdfDoc.embedFont(fontResult.fontData) 
            : await pdfDoc.embedFont(StandardFonts.Helvetica);

        const pages = pdfDoc.getPages();
        const firstPage = pages[0];
        const { width, height } = firstPage.getSize();

        firstPage.drawRectangle({ x: 0, y: height - 350, width: width, height: 350, color: rgb(1, 1, 1) });
        
        let textY = height - 50;
        const fontSize = 12;
        const title = fontResult.type === 'custom' ? "🔒 [보안 처리된 문서]" : "SECURE DOCUMENT";
        
        firstPage.drawText(title, { x: 50, y: textY, size: 16, font: useFont, color: rgb(0, 0.5, 0) });
        textY -= 40;

        const safeDraw = (label, value) => {
            const text = fontResult.type === 'custom' ? `${label}: ${value}` : `${label}: ${value || 'N/A'}`;
            firstPage.drawText(text, { x: 50, y: textY, size: fontSize, font: useFont, color: rgb(0, 0, 0) });
            textY -= 20;
        };

        safeDraw("법원", metaInfo.court);
        safeDraw("사건", metaInfo.caseNo);
        safeDraw("당사자", metaInfo.parties);
        safeDraw("대리인", metaInfo.lawyer);

        const pdfBytes = await pdfDoc.save();

        const timestamp = new Date().getTime();
        const safeName = `SECURE_${timestamp}_${fileName.replace(/[^a-zA-Z0-9.]/g, "_")}`;
        const { error: uploadError } = await supabase.storage.from('legal-docs').upload(safeName, pdfBytes, { contentType: 'application/pdf', upsert: true });

        if (uploadError) throw uploadError;

        const publicUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/legal-docs/${safeName}`;
        await supabase.from('document_queue').insert({ filename: fileName, file_url: publicUrl, status: 'pending', ai_result: {} });

        return res.status(200).json({ success: true, message: "완료", fileUrl: publicUrl, extractedMeta: metaInfo });

    } catch (error) {
        console.error("Server Error:", error);
        return res.status(500).json({ error: error.message });
    }
}