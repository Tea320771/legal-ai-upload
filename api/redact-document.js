// /api/redact-document.js
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createClient } from '@supabase/supabase-js';

// 1. 환경변수 설정
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// 2. Vercel 서버 설정 (파일 용량 제한 10MB)
export const config = {
    api: {
        bodyParser: {
            sizeLimit: '10mb',
        },
    },
};

// [핵심] analyze.js에서 가져온 강력한 모델 목록 (순서대로 시도함)
const MODELS_TO_TRY = [
    "gemini-1.5-flash",
    "gemini-1.5-flash-001",
    "gemini-1.5-flash-002",
    "gemini-1.5-pro",
    "gemini-1.0-pro",
    "gemini-pro",
    "gemini-flash-latest"
];

export default async function handler(req, res) {
    console.log("🚀 API 호출됨: redact-document (Sequential Fallback Mode)");

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        let { fileBase64, fileName } = req.body;
        if (!fileBase64) throw new Error("파일 데이터가 없습니다.");

        // (A) Base64 헤더 제거 (안전장치)
        if (fileBase64.includes("base64,")) {
            fileBase64 = fileBase64.split("base64,")[1];
        }

        // ============================================================
        // [Task 1] AI 분석 (순차 시도 로직 적용)
        // ============================================================
        const analyzeWithFallback = async () => {
            let lastError = null;

            for (const modelName of MODELS_TO_TRY) {
                try {
                    console.log(`🤖 모델 시도 중: ${modelName}`);

                    // [설정 분기] 최신 모델은 JSON 모드, 구형은 일반 모드 (analyze.js 로직)
                    const generationConfig = { temperature: 0.1 };
                    if (modelName.includes("1.5") || modelName.includes("flash")) {
                        generationConfig.responseMimeType = "application/json";
                    }

                    const model = genAI.getGenerativeModel({ 
                        model: modelName,
                        generationConfig: generationConfig
                    });

                    const extractPrompt = `
                    이 판결문 문서의 첫 페이지 상단을 읽고 다음 정보를 JSON으로 추출해.
                    JSON 형식으로만 대답해. 마크다운이나 다른 말은 쓰지 마.
                    {
                        "court": "법원명",
                        "caseNo": "사건번호",
                        "parties": "원고 및 피고 이름",
                        "lawyer": "소송대리인"
                    }
                    `;

                    const result = await model.generateContent([
                        { text: extractPrompt },
                        { inlineData: { data: fileBase64, mimeType: "application/pdf" } }
                    ]);
                    
                    let text = result.response.text();
                    console.log(`✅ 성공! (${modelName})`);

                    // 결과 정제 (JSON 파싱)
                    text = text.replace(/```json/g, "").replace(/```/g, "").trim();
                    
                    // 구형 모델(gemini-pro)은 JSON이 아닐 수도 있으므로 예외처리 강화
                    try {
                        return JSON.parse(text);
                    } catch (parseError) {
                        console.warn(`⚠️ JSON 파싱 실패 (${modelName}), 원본: ${text.substring(0, 50)}...`);
                        // 파싱 실패 시에도 다음 모델로 넘어가지 않고, 일단 정보없음 처리하거나 재시도 가능
                        // 여기서는 에러로 처리하여 다음 모델 시도 유도
                        throw new Error("JSON Parsing Failed"); 
                    }

                } catch (error) {
                    console.warn(`❌ 실패 (${modelName}): ${error.message}`);
                    lastError = error;
                    // 다음 모델 시도 (continue)
                    continue;
                }
            }
            
            // 모든 모델 실패 시
            console.error("❌ 모든 AI 모델 시도 실패");
            return { court: "분석실패", caseNo: "정보없음", parties: "", lawyer: "" };
        };

        // ============================================================
        // [Task 2] 폰트 다운로드 & [Task 1] 실행 (병렬 처리)
        // ============================================================
        
        // 한글 폰트 (CDN)
        const fontPromise = fetch('https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/notosanskr/NotoSansKR-Bold.otf')
            .then(res => {
                if (!res.ok) throw new Error("폰트 다운로드 실패");
                return res.arrayBuffer();
            });

        // 두 작업 동시 시작
        const [metaInfo, fontBytes] = await Promise.all([analyzeWithFallback(), fontPromise]);

        // ============================================================
        // [Task 3] PDF 수정 (마스킹 & 다시 쓰기)
        // ============================================================
        const pdfDoc = await PDFDocument.load(fileBase64);
        pdfDoc.registerFontkit(fontkit);
        const koreanFont = await pdfDoc.embedFont(fontBytes);

        const pages = pdfDoc.getPages();
        const firstPage = pages[0];
        const { width, height } = firstPage.getSize();
        
        // 마스킹 (상단 가리기)
        firstPage.drawRectangle({
            x: 0, y: height - 350, width: width, height: 350, color: rgb(1, 1, 1),
        });

        // 정보 다시 쓰기
        let textY = height - 50;
        const fontSize = 12;
        
        firstPage.drawText("🔒 [보안 처리된 문서]", { x: 50, y: textY, size: 16, font: koreanFont, color: rgb(0, 0.5, 0) });
        textY -= 40;
        
        const drawLine = (l, v) => {
            if(!v) return;
            // null 체크 강화
            const val = v || "정보없음"; 
            firstPage.drawText(`${l}: ${val}`, { x: 50, y: textY, size: fontSize, font: koreanFont, color: rgb(0, 0, 0) });
            textY -= 20;
        };

        drawLine("법원", metaInfo.court);
        drawLine("사건", metaInfo.caseNo);
        drawLine("당사자", metaInfo.parties);
        drawLine("대리인", metaInfo.lawyer);

        const pdfBytes = await pdfDoc.save();

        // ============================================================
        // [Task 4] Supabase 업로드
        // ============================================================
        const timestamp = new Date().getTime();
        const safeName = `SECURE_${timestamp}_${fileName.replace(/[^a-zA-Z0-9.]/g, "_")}`;

        const { error: uploadError } = await supabase.storage
            .from('legal-docs')
            .upload(safeName, pdfBytes, {
                contentType: 'application/pdf',
                upsert: true
            });

        if (uploadError) throw uploadError;

        const publicUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/legal-docs/${safeName}`;
        
        // 대기열 등록
        await supabase.from('document_queue').insert({
            filename: fileName,
            file_url: publicUrl,
            status: 'pending',
            ai_result: {}
        });

        return res.status(200).json({ 
            success: true, 
            message: "완료",
            fileUrl: publicUrl,
            extractedMeta: metaInfo
        });

    } catch (error) {
        console.error("Server Error:", error);
        return res.status(500).json({ error: error.message });
    }
}