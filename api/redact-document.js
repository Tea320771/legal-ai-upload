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

// 3. 메인 API 핸들러
export default async function handler(req, res) {
    console.log("🚀 API 호출됨: redact-document");

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        // let으로 선언 (내용을 수정해야 하므로)
        let { fileBase64, fileName } = req.body;
        
        if (!fileBase64) throw new Error("파일 데이터가 없습니다.");

        // ============================================================
        // [핵심 수정] Base64 헤더 제거 (Gemini 에러 방지)
        // 브라우저는 "data:application/pdf;base64,JVBER..." 형태로 보내는데,
        // Gemini는 앞의 "data:...base64," 부분을 싫어합니다.
        // ============================================================
        if (fileBase64.includes("base64,")) {
            fileBase64 = fileBase64.split("base64,")[1];
        }

        // ============================================================
        // [병렬 처리] Gemini 분석 & 폰트 다운로드
        // ============================================================
        
        // Task A: Gemini 분석
        const analysisPromise = (async () => {
            const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-001" });
            const extractPrompt = `
            이 판결문 문서의 첫 페이지 상단을 읽고 다음 정보를 JSON으로 추출해.
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
            
            let metaInfo = { court: "", caseNo: "", parties: "", lawyer: "" };
            try {
                let text = result.response.text().replace(/```json/g, "").replace(/```/g, "").trim();
                metaInfo = JSON.parse(text);
            } catch (e) { console.warn("AI 추출 실패:", e); }
            return metaInfo;
        })();

        // Task B: 한글 폰트 다운로드
        const fontPromise = fetch('https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/notosanskr/NotoSansKR-Bold.otf')
            .then(res => {
                if (!res.ok) throw new Error("폰트 다운로드 실패");
                return res.arrayBuffer();
            });

        // 두 작업 동시 대기
        const [metaInfo, fontBytes] = await Promise.all([analysisPromise, fontPromise]);

        // ============================================================
        // [PDF 수정]
        // ============================================================
        const pdfDoc = await PDFDocument.load(fileBase64);
        pdfDoc.registerFontkit(fontkit);
        const koreanFont = await pdfDoc.embedFont(fontBytes);

        const pages = pdfDoc.getPages();
        const firstPage = pages[0];
        const { width, height } = firstPage.getSize();
        
        // 마스킹
        firstPage.drawRectangle({
            x: 0, y: height - 350, width: width, height: 350, color: rgb(1, 1, 1),
        });

        // 텍스트 다시 쓰기
        let textY = height - 50;
        const fontSize = 12;
        
        firstPage.drawText("🔒 [보안 처리된 문서]", { x: 50, y: textY, size: 16, font: koreanFont, color: rgb(0, 0.5, 0) });
        textY -= 40;
        
        const drawLine = (l, v) => {
            if(!v) return;
            firstPage.drawText(`${l}: ${v}`, { x: 50, y: textY, size: fontSize, font: koreanFont, color: rgb(0, 0, 0) });
            textY -= 20;
        };

        drawLine("법원", metaInfo.court);
        drawLine("사건", metaInfo.caseNo);
        drawLine("당사자", metaInfo.parties);
        drawLine("대리인", metaInfo.lawyer);

        const pdfBytes = await pdfDoc.save();

        // ============================================================
        // [Supabase 업로드]
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