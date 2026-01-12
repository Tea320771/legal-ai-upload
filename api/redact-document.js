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

const MODELS_TO_TRY = [
    "gemini-1.5-flash",
    "gemini-1.5-flash-001",
    "gemini-1.5-pro",
    "gemini-pro"
];

export default async function handler(req, res) {
    console.log("🚀 API 호출됨: redact-document (Final Diagnosis)");

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    try {
        let { fileBase64, fileName } = req.body;
        if (!fileBase64) throw new Error("파일 데이터가 없습니다.");

        // [데이터 정제] 헤더 제거 및 공백/줄바꿈 제거 (매우 중요)
        let cleanBase64 = fileBase64;
        if (cleanBase64.includes("base64,")) {
            cleanBase64 = cleanBase64.split("base64,")[1];
        }
        cleanBase64 = cleanBase64.replace(/[\r\n\s]/g, ''); // 줄바꿈/공백 제거

        console.log(`📄 PDF 데이터 준비됨 (길이: ${cleanBase64.length})`);

        // ============================================================
        // [Task A] 폰트 다운로드 (안전 모드 유지)
        // ============================================================
        const loadFont = async () => {
            try {
                const fontUrl = 'https://raw.githubusercontent.com/google/fonts/main/ofl/nanumgothic/NanumGothic-Bold.ttf';
                const response = await fetch(fontUrl);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return { fontData: await response.arrayBuffer(), type: 'custom' };
            } catch (e) {
                console.error("⚠️ 폰트 다운로드 실패:", e.message);
                return { fontData: null, type: 'standard' };
            }
        };

        // ============================================================
        // [Task B] AI 분석 (진단 모드)
        // ============================================================
        const analyzeDoc = async () => {
            // 1. [Sanity Check] 키가 정상인지 텍스트만 보내서 확인
            try {
                const testModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
                await testModel.generateContent("Hello check");
                console.log("✅ API 키 연결 테스트(Ping) 성공");
            } catch (e) {
                console.error("❌ API 키 연결 테스트 실패 (키 문제 또는 서버 오류):", e.message);
                // 여기서 실패하면 뒤에도 실패할 확률이 높음
            }

            // 2. 실제 분석 시도
            for (const modelName of MODELS_TO_TRY) {
                try {
                    console.log(`🤖 AI 분석 시도: ${modelName}`);
                    
                    const model = genAI.getGenerativeModel({ 
                        model: modelName,
                        generationConfig: { temperature: 0.1 }
                    });

                    // analyze.js와 동일한 객체 구조 사용
                    const result = await model.generateContent({
                        contents: [
                            {
                                role: "user",
                                parts: [
                                    { text: "이 문서의 법원명, 사건번호, 원고/피고, 대리인 이름을 JSON으로 추출해. { \"court\": \"...\", \"caseNo\": \"...\", \"parties\": \"...\", \"lawyer\": \"...\" }" },
                                    { inlineData: { data: cleanBase64, mimeType: "application/pdf" } }
                                ]
                            }
                        ]
                    });
                    
                    let text = result.response.text().replace(/```json/g, "").replace(/```/g, "").trim();
                    console.log(`✅ AI 분석 성공 (${modelName})`);
                    return JSON.parse(text);

                } catch (e) {
                    console.warn(`⚠️ ${modelName} 실패: ${e.message}`);
                    continue;
                }
            }
            console.error("❌ 모든 AI 모델 실패");
            return { court: "분석실패", caseNo: "정보없음", parties: "", lawyer: "" };
        };

        // 병렬 실행
        const [fontResult, metaInfo] = await Promise.all([loadFont(), analyzeDoc()]);

        // ============================================================
        // [Task C] PDF 생성 및 저장
        // ============================================================
        const pdfDoc = await PDFDocument.load(cleanBase64);
        pdfDoc.registerFontkit(fontkit);

        let useFont;
        if (fontResult.type === 'custom') {
            useFont = await pdfDoc.embedFont(fontResult.fontData);
        } else {
            useFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
        }

        const pages = pdfDoc.getPages();
        const firstPage = pages[0];
        const { width, height } = firstPage.getSize();

        // 마스킹 & 쓰기
        firstPage.drawRectangle({ x: 0, y: height - 350, width: width, height: 350, color: rgb(1, 1, 1) });
        
        let textY = height - 50;
        const fontSize = 12;
        
        // 타이틀
        const title = fontResult.type === 'custom' ? "🔒 [보안 처리된 문서]" : "SECURE DOCUMENT";
        firstPage.drawText(title, { x: 50, y: textY, size: 16, font: useFont, color: rgb(0, 0.5, 0) });
        textY -= 40;

        const safeDraw = (label, value) => {
            const text = fontResult.type === 'custom' ? `${label}: ${value}` : `${label}: ${value || 'N/A'} (Font Error)`;
            firstPage.drawText(text, { x: 50, y: textY, size: fontSize, font: useFont, color: rgb(0, 0, 0) });
            textY -= 20;
        };

        safeDraw("법원", metaInfo.court);
        safeDraw("사건", metaInfo.caseNo);
        safeDraw("당사자", metaInfo.parties);
        safeDraw("대리인", metaInfo.lawyer);

        const pdfBytes = await pdfDoc.save();

        // 업로드
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