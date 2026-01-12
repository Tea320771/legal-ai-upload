// /api/redact-document.js
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    // 1. [디버깅] 환경변수 로드 확인 (값 자체는 보안상 출력 X)
    console.log("🔍 API 시작: 환경변수 확인 중...");
    if (!process.env.SUPABASE_URL) console.error("❌ 에러: SUPABASE_URL 없음");
    if (!process.env.SUPABASE_KEY) console.error("❌ 에러: SUPABASE_KEY 없음");
    if (!process.env.GEMINI_API_KEY) console.error("❌ 에러: GEMINI_API_KEY 없음");

    // 2. [디버깅] 모듈 로드 확인
    try {
        const testSupabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
        console.log("✅ Supabase 클라이언트 생성 성공");
    } catch (e) {
        console.error("❌ Supabase 클라이언트 생성 실패:", e);
        return res.status(500).json({ error: "Supabase 초기화 실패: " + e.message });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    try {
        console.log("🚀 메인 로직 진입");

// 환경변수 설정
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// 파일 용량 제한 설정 (10MB)
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
        const { fileBase64, fileName, fileType } = req.body;
        if (!fileBase64) throw new Error("파일 데이터가 없습니다.");

        // ============================================================
        // [핵심 수정] 병렬 처리 (Promise.all)
        // Gemini 분석과 폰트 다운로드를 '동시에' 시작해서 시간을 절약합니다.
        // ============================================================
        
        // 1. Gemini 분석 작업 정의
        const analysisPromise = (async () => {
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

        // 2. 폰트 다운로드 작업 정의
        const fontPromise = fetch('https://github.com/google/fonts/raw/main/ofl/notosanskr/NotoSansKR-Bold.otf')
            .then(res => res.arrayBuffer());

        // 3. 두 작업이 다 끝날 때까지 기다림 (병렬 실행)
        const [metaInfo, fontBytes] = await Promise.all([analysisPromise, fontPromise]);

        // ============================================================
        // 4. PDF 비식별화 (Masking & Rewriting)
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

        const pdfBytes = await pdfDoc.save();

        // ============================================================
        // 5. Supabase 업로드
        // ============================================================
        const timestamp = new Date().getTime();
        const safeName = `SECURE_${timestamp}_${fileName.replace(/[^a-zA-Z0-9.]/g, "_")}`;

        const { error: uploadError } = await supabase.storage
            .from('legal-docs')
            .upload(safeName, pdfBytes, {
                contentType: 'application/pdf'
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