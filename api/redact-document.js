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

// [업데이트] 로그에서 확인된 사용 가능한 최신 모델 목록
const MODELS_TO_TRY = [
    "gemini-2.0-flash",
    "gemini-2.5-flash",
    "gemini-flash-latest",
    "gemini-2.0-flash-lite",
    "gemini-pro-latest"
];

export default async function handler(req, res) {
    console.log("🚀 API 호출됨: redact-document (Dynamic Masking)");

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

        // ============================================================
        // [Task A] 폰트 다운로드 (나눔고딕)
        // ============================================================
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

        // ============================================================
        // [Task B] AI 분석 (마스킹 위치 자동 감지)
        // ============================================================
        const analyzeDoc = async () => {
            for (const modelName of MODELS_TO_TRY) {
                try {
                    console.log(`🤖 AI 분석 시도: ${modelName}`);
                    
                    const model = genAI.getGenerativeModel({ 
                        model: modelName,
                        generationConfig: { responseMimeType: "application/json" }
                    });

                    // [수정된 프롬프트] 마스킹 비율(maskRatio)을 함께 요청
                    const extractPrompt = `
                    You are a legal document analyzer. Analyze the first page of this PDF.
                    1. Extract: court, caseNo, parties, lawyer.
                    2. Identify the Vertical Position where the main judgment body starts.
                       - Look for keywords like "변론 종결" (Argument Concluded) or "주문" (Order).
                       - Return the 'maskRatio' (0.0 to 1.0) indicating how much of the top page should be masked.
                       - Example: If "변론 종결" is in the middle, maskRatio is 0.5.
                       - If the header section (parties list) is very long and goes to the next page, return 1.0.
                    
                    Output JSON only:
                    {
                        "court": "string",
                        "caseNo": "string",
                        "parties": "string",
                        "lawyer": "string",
                        "maskRatio": number
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
                    console.log(`✅ AI 분석 성공 (${modelName})`);
                    return JSON.parse(text);

                } catch (e) {
                    console.warn(`⚠️ ${modelName} 실패: ${e.message}`);
                    continue;
                }
            }
            console.error("❌ 모든 AI 모델 실패");
            // 실패 시 기본값 (약 45% 지점) 반환
            return { court: "분석실패", caseNo: "정보없음", parties: "", lawyer: "", maskRatio: 0.45 };
        };

        const [fontResult, metaInfo] = await Promise.all([loadFont(), analyzeDoc()]);

        // ============================================================
        // [Task C] PDF 수정 (동적 마스킹)
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

        // [핵심] AI가 알려준 비율로 마스킹 높이 계산
        // 값이 없거나 이상하면 기본값 0.45 사용
        let ratio = metaInfo.maskRatio;
        if (typeof ratio !== 'number' || ratio < 0.1 || ratio > 1.0) {
            ratio = 0.45; 
        }
        
        // 약간의 여유 공간(+2%)을 둬서 글자가 잘리지 않게 함
        const maskHeight = height * ratio;

        console.log(`📏 마스킹 적용: 전체 높이(${height})의 ${Math.round(ratio*100)}% (${maskHeight}px)`);

        // 흰색 사각형 그리기 (위에서부터 maskHeight만큼 덮음)
        firstPage.drawRectangle({
            x: 0,
            y: height - maskHeight, // 바닥 기준 좌표이므로 전체에서 뺌
            width: width,
            height: maskHeight,
            color: rgb(1, 1, 1),
        });
        
        // ============================================================
        // 정보 다시 쓰기
        // ============================================================
        let textY = height - 50;
        const fontSize = 12;
        
        const title = fontResult.type === 'custom' ? "🔒 [보안 처리된 문서]" : "SECURE DOCUMENT";
        firstPage.drawText(title, { x: 50, y: textY, size: 16, font: useFont, color: rgb(0, 0.5, 0) });
        textY -= 40;

        const safeDraw = (label, value) => {
            const valStr = value || '정보없음';
            const text = fontResult.type === 'custom' ? `${label}: ${valStr}` : `${label}: ${valStr}`;
            
            // 내용이 너무 길면 잘라서 표현 (간단한 처리)
            const maxLength = 60;
            const displayStr = text.length > maxLength ? text.substring(0, maxLength) + "..." : text;
            
            firstPage.drawText(displayStr, { x: 50, y: textY, size: fontSize, font: useFont, color: rgb(0, 0, 0) });
            textY -= 20;
        };

        safeDraw("법원", metaInfo.court);
        safeDraw("사건", metaInfo.caseNo);
        safeDraw("당사자", metaInfo.parties);
        safeDraw("대리인", metaInfo.lawyer);

        const pdfBytes = await pdfDoc.save();

        // ============================================================
        // [Task D] 업로드
        // ============================================================
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