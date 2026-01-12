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
    "gemini-2.0-flash",
    "gemini-2.5-flash",
    "gemini-flash-latest",
    "gemini-pro-latest"
];

// 텍스트 줄바꿈 계산 함수
function wordWrap(text, maxWidth, font, fontSize) {
    if (!text) return [];
    const words = text.replace(/\n/g, ' ').split(' ');
    let lines = [];
    let currentLine = words[0];

    for (let i = 1; i < words.length; i++) {
        const word = words[i];
        const width = font.widthOfTextAtSize(currentLine + " " + word, fontSize);
        if (width < maxWidth) {
            currentLine += " " + word;
        } else {
            lines.push(currentLine);
            currentLine = word;
        }
    }
    lines.push(currentLine);
    return lines;
}

export default async function handler(req, res) {
    console.log("🚀 API 호출됨: redact-document (RealName Lawyer Fix)");

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    try {
        const apiKey = process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.trim() : "";
        const supabaseUrl = process.env.SUPABASE_URL ? process.env.SUPABASE_URL.trim() : "";
        const supabaseKey = process.env.SUPABASE_KEY ? process.env.SUPABASE_KEY.trim() : "";

        if (!apiKey) throw new Error("GEMINI_API_KEY가 없습니다.");

        const genAI = new GoogleGenerativeAI(apiKey);
        const supabase = createClient(supabaseUrl, supabaseKey);

        let { fileBase64, fileName } = req.body;
        if (!fileBase64) throw new Error("파일 데이터가 없습니다.");

        let cleanBase64 = fileBase64;
        if (cleanBase64.includes("base64,")) cleanBase64 = cleanBase64.split("base64,")[1];
        cleanBase64 = cleanBase64.replace(/[\r\n\s]/g, '');

        console.log(`📄 데이터 준비 완료 (${fileName})`);

        // [Task A] 폰트 다운로드
        const loadFont = async () => {
            try {
                const fontUrl = 'https://raw.githubusercontent.com/google/fonts/main/ofl/nanumgothic/NanumGothic-Bold.ttf';
                const response = await fetch(fontUrl);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return { fontData: await response.arrayBuffer(), type: 'custom' };
            } catch (e) {
                console.warn("⚠️ 폰트 다운로드 실패:", e.message);
                return { fontData: null, type: 'standard' };
            }
        };

        // [Task B] AI 분석
        const analyzeDoc = async () => {
            for (const modelName of MODELS_TO_TRY) {
                try {
                    const model = genAI.getGenerativeModel({ 
                        model: modelName,
                        generationConfig: { responseMimeType: "application/json" }
                    });

                    // [수정된 프롬프트] 변호사/법무법인 실명 유지 강조
                    const extractPrompt = `
                    You are a legal document anonymizer. Analyze this judgment PDF.

                    1. **Mapping (Parties)**: 
                       - Identify Plaintiffs, Defendants, Intervenors. 
                       - Assign pseudonyms (e.g., "원고 A", "피고 B").
                    
                    2. **Mapping (Lawyers)**:
                       - Identify Law Firms (법무법인) and Lawyers (변호사).
                       - **CRITICAL**: Do NOT anonymize them. Keep their **REAL NAMES** exactly as they appear.
                       - List who they represent using the party's pseudonym (e.g., "법무법인 태평양 (원고 A 대리)").

                    3. **Rewrite Sections**: 
                       - Rewrite "Order" (주문) and "Claim" (청구취지).
                       - Replace ONLY the names of Plaintiffs/Defendants/Intervenors with pseudonyms.
                       - Keep Law Firms/Lawyers/Dates/Amounts/Court Names as **REAL VALUES**.

                    4. **Masking Range**: Find where the header/body ends. Return "maskEndPage" (1-based) and "maskEndRatio".

                    Output JSON:
                    {
                        "court": "string", "caseNo": "string", 
                        "parties_anonymized": "string (Pseudonyms)", 
                        "lawyer_info": "string (REAL NAMES of firms/lawyers)",
                        "order_anonymized": "string", "claim_anonymized": "string",
                        "maskEndPage": number, "maskEndRatio": number
                    }
                    `;

                    const result = await model.generateContent({
                        contents: [{
                            role: "user",
                            parts: [
                                { text: extractPrompt },
                                { inlineData: { data: cleanBase64, mimeType: "application/pdf" } }
                            ]
                        }]
                    });
                    
                    let text = result.response.text().replace(/```json/g, "").replace(/```/g, "").trim();
                    return JSON.parse(text);
                } catch (e) {
                    continue;
                }
            }
            return { 
                court: "분석실패", caseNo: "정보없음", parties_anonymized: "정보없음", lawyer_info: "정보없음",
                order_anonymized: "내용 없음", claim_anonymized: "내용 없음", maskEndPage: 1, maskEndRatio: 0.5 
            };
        };

        const [fontResult, metaInfo] = await Promise.all([loadFont(), analyzeDoc()]);

        // [Task C] PDF 수정
        const pdfDoc = await PDFDocument.load(cleanBase64);
        pdfDoc.registerFontkit(fontkit);

        let useFont;
        if (fontResult.type === 'custom') {
            useFont = await pdfDoc.embedFont(fontResult.fontData);
        } else {
            useFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
        }

        const pages = pdfDoc.getPages();
        let endPageIdx = (metaInfo.maskEndPage || 1) - 1; 
        let endRatio = metaInfo.maskEndRatio;
        if (typeof endRatio !== 'number') endRatio = 0.6;
        endRatio = Math.min(endRatio + 0.05, 1.0);

        for (let i = 0; i < pages.length; i++) {
            const page = pages[i];
            const { width, height } = page.getSize();
            if (i < endPageIdx) {
                page.drawRectangle({ x: 0, y: 0, width: width, height: height, color: rgb(1, 1, 1) });
            } else if (i === endPageIdx) {
                const maskHeight = height * endRatio;
                page.drawRectangle({ x: 0, y: height - maskHeight, width: width, height: maskHeight, color: rgb(1, 1, 1) });
                break;
            }
        }
        
        const firstPage = pages[0];
        const { width, height } = firstPage.getSize();
        const fontSize = 11;
        const lineHeight = 16;
        let textY = height - 50;

        firstPage.drawText("🔒 [보안 처리된 문서 - 가명 처리]", { x: 50, y: textY, size: 14, font: useFont, color: rgb(0, 0.5, 0) });
        textY -= 30;

        const drawField = (label, content) => {
            const labelWidth = useFont.widthOfTextAtSize(label + ": ", fontSize);
            firstPage.drawText(label + ":", { x: 50, y: textY, size: fontSize, font: useFont, color: rgb(0, 0, 0) });
            const maxContentWidth = width - 100 - labelWidth;
            const lines = wordWrap(content || "정보없음", maxContentWidth, useFont, fontSize);
            if (lines.length > 0) {
                firstPage.drawText(lines[0], { x: 50 + labelWidth, y: textY, size: fontSize, font: useFont, color: rgb(0.2, 0.2, 0.2) });
                textY -= lineHeight;
                for (let i = 1; i < lines.length; i++) {
                    firstPage.drawText(lines[i], { x: 50 + labelWidth, y: textY, size: fontSize, font: useFont, color: rgb(0.2, 0.2, 0.2) });
                    textY -= lineHeight;
                }
            } else { textY -= lineHeight; }
            textY -= 5;
        };

        drawField("법원", metaInfo.court);
        drawField("사건", metaInfo.caseNo);
        drawField("당사자(가명)", metaInfo.parties_anonymized);
        drawField("대리인(실명)", metaInfo.lawyer_info); // 라벨도 명확하게 변경
        textY -= 10;
        firstPage.drawText("[주 문 (가명 처리)]", { x: 50, y: textY, size: 12, font: useFont, color: rgb(0, 0, 0) });
        textY -= 20;
        drawField("", metaInfo.order_anonymized);
        textY -= 10;
        firstPage.drawText("[청구 취지 (가명 처리)]", { x: 50, y: textY, size: 12, font: useFont, color: rgb(0, 0, 0) });
        textY -= 20;
        drawField("", metaInfo.claim_anonymized);

        const pdfBytes = await pdfDoc.save();

        // [Task D] 업로드
        const timestamp = new Date().getTime();
        const safeName = `SECURE_${timestamp}_${fileName.replace(/[^a-zA-Z0-9.]/g, "_")}`;

        const { error: uploadError } = await supabase.storage.from('legal-docs').upload(safeName, pdfBytes, { contentType: 'application/pdf', upsert: true });
        if (uploadError) throw uploadError;

        const publicUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/legal-docs/${safeName}`;
        
        await supabase.from('document_queue').insert({
            filename: safeName, 
            file_url: publicUrl,
            status: 'pending',
            ai_result: {}
        });

        return res.status(200).json({ success: true, message: "완료", fileUrl: publicUrl, extractedMeta: metaInfo });

    } catch (error) {
        console.error("Server Error:", error);
        return res.status(500).json({ error: error.message });
    }
}