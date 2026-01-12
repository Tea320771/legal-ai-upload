// /api/redact-document.js
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createClient } from '@supabase/supabase-js';

// 1. 환경변수 설정
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// 2. Vercel 서버 설정 (10MB 제한)
export const config = {
    api: {
        bodyParser: {
            sizeLimit: '10mb',
        },
    },
};

// analyze.js에서 성공했던 모델 목록 포함
const MODELS_TO_TRY = [
    "gemini-1.5-flash",
    "gemini-1.5-flash-latest", // 추가됨
    "gemini-1.5-flash-001",
    "gemini-1.5-pro",
    "gemini-pro"
];

export default async function handler(req, res) {
    console.log("🚀 API 호출됨: redact-document (Fix Font & Fallback)");

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        let { fileBase64, fileName } = req.body;
        if (!fileBase64) throw new Error("파일 데이터가 없습니다.");

        // (A) Base64 헤더 정제 (확실하게 처리)
        // "data:application/pdf;base64," 같은 헤더가 있으면 제거
        const base64Data = fileBase64.includes("base64,") 
            ? fileBase64.split("base64,")[1] 
            : fileBase64;

        // ============================================================
        // [Task 1] AI 분석 (순차 시도)
        // ============================================================
        const analyzeWithFallback = async () => {
            for (const modelName of MODELS_TO_TRY) {
                try {
                    console.log(`🤖 AI 분석 시도: ${modelName}`);

                    const model = genAI.getGenerativeModel({ 
                        model: modelName,
                        // PDF 처리 시 JSON 모드가 불안정할 수 있어, 일반 텍스트 모드로 시도 후 파싱
                        generationConfig: { temperature: 0.1 } 
                    });

                    const extractPrompt = `
                    이 판결문 문서의 첫 페이지 상단을 읽고 다음 정보를 JSON 포맷으로 추출해.
                    반드시 JSON만 출력해. (Markdown backticks 없이)
                    {
                        "court": "법원명",
                        "caseNo": "사건번호",
                        "parties": "원고 및 피고 이름",
                        "lawyer": "소송대리인"
                    }
                    `;

                    const result = await model.generateContent([
                        { text: extractPrompt },
                        { inlineData: { data: base64Data, mimeType: "application/pdf" } }
                    ]);
                    
                    let text = result.response.text();
                    console.log(`✅ AI 분석 성공 (${modelName})`);

                    // JSON 정제
                    text = text.replace(/```json/g, "").replace(/```/g, "").trim();
                    return JSON.parse(text);

                } catch (error) {
                    console.warn(`⚠️ ${modelName} 실패: ${error.message}`);
                    continue; // 다음 모델 시도
                }
            }
            
            console.error("❌ 모든 AI 모델 실패");
            return { court: "분석실패", caseNo: "정보없음", parties: "", lawyer: "" };
        };

        // ============================================================
        // [Task 2] 폰트 다운로드 (주소 변경!)
        // ============================================================
        // [수정] jsDelivr 대신 GitHub Raw 주소 사용 (더 안정적)
        const fontUrl = 'https://raw.githubusercontent.com/google/fonts/main/ofl/notosanskr/NotoSansKR-Bold.otf';
        
        const fontPromise = fetch(fontUrl)
            .then(res => {
                if (!res.ok) throw new Error(`폰트 다운로드 실패 (${res.status})`);
                return res.arrayBuffer();
            })
            .catch(err => {
                console.error("❌ 폰트 치명적 오류:", err);
                return null; // 폰트 실패해도 죽지 않게 null 반환
            });

        // 두 작업 병렬 실행
        const [metaInfo, fontBytes] = await Promise.all([analyzeWithFallback(), fontPromise]);

        if (!fontBytes) {
            throw new Error("한글 폰트를 불러오지 못해 작업을 중단합니다.");
        }

        // ============================================================
        // [Task 3] PDF 수정
        // ============================================================
        const pdfDoc = await PDFDocument.load(base64Data);
        pdfDoc.registerFontkit(fontkit);
        const koreanFont = await pdfDoc.embedFont(fontBytes);

        const pages = pdfDoc.getPages();
        const firstPage = pages[0];
        const { width, height } = firstPage.getSize();
        
        // 마스킹
        firstPage.drawRectangle({
            x: 0, y: height - 350, width: width, height: 350, color: rgb(1, 1, 1),
        });

        // 텍스트 쓰기
        let textY = height - 50;
        const fontSize = 12;
        
        firstPage.drawText("🔒 [보안 처리된 문서]", { x: 50, y: textY, size: 16, font: koreanFont, color: rgb(0, 0.5, 0) });
        textY -= 40;
        
        const drawLine = (l, v) => {
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