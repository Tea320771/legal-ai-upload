// /api/redact-document.js
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createClient } from '@supabase/supabase-js'; // [추가]

// [보안] 환경변수에서 키를 가져옵니다. (코드에 노출 X)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

export const config = {
    api: {
        bodyParser: {
            sizeLimit: '10mb',
        },
    },
};

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    try {
        const { fileBase64, fileName, fileType } = req.body; // fileName 추가 수신
        if (!fileBase64) throw new Error("파일 데이터가 없습니다.");

        // ---------------------------------------------------------
        // 1. AI 정보 추출 (Gemini)
        // ---------------------------------------------------------
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const extractPrompt = `
        이 판결문 문서의 첫 페이지 상단을 읽고 다음 정보를 JSON으로 추출해.
        {
            "court": "법원명",
            "caseNo": "사건번호",
            "parties": "원고 및 피고 이름",
            "lawyer": "소송대리인"
        }
        `;

        const aiResult = await model.generateContent([
            { text: extractPrompt },
            { inlineData: { data: fileBase64, mimeType: "application/pdf" } }
        ]);
        
        let metaInfo = { court: "", caseNo: "", parties: "", lawyer: "" };
        try {
            let text = aiResult.response.text().replace(/```json/g, "").replace(/```/g, "").trim();
            metaInfo = JSON.parse(text);
        } catch (e) { console.warn("AI 추출 실패:", e); }

        // ---------------------------------------------------------
        // 2. PDF 비식별화 (Masking & Rewriting)
        // ---------------------------------------------------------
        const pdfDoc = await PDFDocument.load(fileBase64);
        pdfDoc.registerFontkit(fontkit);

        const fontUrl = 'https://github.com/google/fonts/raw/main/ofl/notosanskr/NotoSansKR-Bold.otf';
        const fontBytes = await fetch(fontUrl).then(res => res.arrayBuffer());
        const koreanFont = await pdfDoc.embedFont(fontBytes);

        const pages = pdfDoc.getPages();
        const firstPage = pages[0];
        const { width, height } = firstPage.getSize();
        
        // 마스킹 (상단 가리기)
        firstPage.drawRectangle({
            x: 0, y: height - 350, width: width, height: 350, color: rgb(1, 1, 1),
        });

        // 다시 쓰기
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

        const pdfBytes = await pdfDoc.save(); // 수정된 PDF 바이너리 데이터

        // ---------------------------------------------------------
        // 3. [변경점] 서버에서 바로 Supabase 업로드
        // ---------------------------------------------------------
        const timestamp = new Date().getTime();
        // 파일명 안전하게 변경
        const safeName = `SECURE_${timestamp}_${fileName.replace(/[^a-zA-Z0-9.]/g, "_")}`;

        // Supabase Storage 업로드
        const { error: uploadError } = await supabase.storage
            .from('legal-docs')
            .upload(safeName, pdfBytes, {
                contentType: 'application/pdf'
            });

        if (uploadError) throw uploadError;

        // (선택) 대기열 DB 등록도 여기서 처리하면 더 안전함
        const publicUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/legal-docs/${safeName}`;
        await supabase.from('document_queue').insert({
            filename: fileName,
            file_url: publicUrl,
            status: 'pending',
            ai_result: {}
        });

        // 4. 결과 반환 (성공 여부만 프론트로 전달)
        return res.status(200).json({ 
            success: true, 
            message: "비식별화 및 업로드 완료",
            fileUrl: publicUrl,
            extractedMeta: metaInfo
        });

    } catch (error) {
        console.error("Server Error:", error);
        return res.status(500).json({ error: error.message });
    }
}