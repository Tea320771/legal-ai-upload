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

// 최신 모델 목록 유지
const MODELS_TO_TRY = [
    "gemini-2.0-flash",
    "gemini-2.5-flash",
    "gemini-flash-latest",
    "gemini-pro-latest"
];

export default async function handler(req, res) {
    console.log("🚀 API 호출됨: redact-document (Multi-page Masking)");

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
        // [Task B] AI 분석 (페이지 넘김 추적)
        // ============================================================
        const analyzeDoc = async () => {
            for (const modelName of MODELS_TO_TRY) {
                try {
                    console.log(`🤖 AI 분석 시도: ${modelName}`);
                    
                    const model = genAI.getGenerativeModel({ 
                        model: modelName,
                        generationConfig: { responseMimeType: "application/json" }
                    });

                    // [핵심] 페이지 번호(bodyStartPage)까지 요구하는 프롬프트
                    const extractPrompt = `
                    You are a legal document redactor. The document contains personal information (Parties) at the beginning, followed by the main judgment body.
                    
                    1. **Extract Meta Info**:
                       - "court": Court name.
                       - "caseNo": Case number.
                       - "parties": Names of Plaintiffs(원고), Defendants(피고), AND Intervenors(보조참가인, 독립당사자참가인). Combine them into a single string.
                       - "lawyer": Legal representatives.

                    2. **Locate Body Start**:
                       - Find where the header ends and the body begins. Look for keywords: "변론 종결", "판결 선고", "주 문", "청구 취지".
                       - Identify the **Page Number** (1-based) where this keyword first appears. -> "bodyStartPage"
                       - Identify the **Vertical Position** (ratio 0.0 to 1.0) on that specific page. -> "bodyStartRatio"
                       - (Example: If "변론 종결" is at the top of Page 2, bodyStartPage=2, bodyStartRatio=0.1)

                    Output JSON only:
                    {
                        "court": "string",
                        "caseNo": "string",
                        "parties": "string",
                        "lawyer": "string",
                        "bodyStartPage": number,
                        "bodyStartRatio": number
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
            // 실패 시 안전하게 1페이지의 절반만 가림 (Fallback)
            return { court: "분석실패", caseNo: "정보없음", parties: "", lawyer: "", bodyStartPage: 1, bodyStartRatio: 0.5 };
        };

        const [fontResult, metaInfo] = await Promise.all([loadFont(), analyzeDoc()]);

        // ============================================================
        // [Task C] PDF 수정 (다중 페이지 마스킹)
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
        
        // 1. 마스킹 위치 계산
        // AI가 페이지를 못 찾았거나 이상한 값이면 안전하게 1페이지로 설정
        let startPageIdx = (metaInfo.bodyStartPage || 1) - 1; 
        let startRatio = metaInfo.bodyStartRatio;
        
        if (startPageIdx < 0) startPageIdx = 0;
        if (typeof startRatio !== 'number') startRatio = 0.5;

        // 약간의 여유(Margin)를 둬서 글자가 잘리지 않게 함
        // 비율이 0.1(상단)이면 -> 0.15까지 가림
        // 비율이 0.9(하단)이면 -> 0.95까지 가림
        startRatio = Math.min(startRatio + 0.05, 1.0);

        console.log(`📏 마스킹 범위: ${startPageIdx + 1}페이지의 ${Math.round(startRatio * 100)}% 지점까지`);

        // 2. 페이지 순회하며 마스킹
        for (let i = 0; i < pages.length; i++) {
            const page = pages[i];
            const { width, height } = page.getSize();

            if (i < startPageIdx) {
                // [이전 페이지] 본문 시작 전 페이지이므로 "전체 마스킹"
                // 예: 2페이지가 본문 시작이면, 1페이지는 싹 다 가림
                page.drawRectangle({
                    x: 0, y: 0, width: width, height: height,
                    color: rgb(1, 1, 1),
                });
                console.log(`   -> Page ${i + 1}: 전체 마스킹 (헤더가 넘어감)`);
            } 
            else if (i === startPageIdx) {
                // [타겟 페이지] 본문이 시작되는 페이지이므로 "비율만큼 마스킹"
                const maskHeight = height * startRatio;
                page.drawRectangle({
                    x: 0,
                    y: height - maskHeight,
                    width: width,
                    height: maskHeight,
                    color: rgb(1, 1, 1),
                });
                console.log(`   -> Page ${i + 1}: 상단 ${Math.round(startRatio * 100)}% 마스킹`);
                
                // 마스킹이 끝나는 페이지에서 루프 종료 (뒤쪽 본문은 건드리지 않음)
                break;
            }
        }
        
        // ============================================================
        // 3. 추출 정보 기재 (첫 페이지에만 작성)
        // ============================================================
        const firstPage = pages[0];
        const { width: p1Width, height: p1Height } = firstPage.getSize();
        
        let textY = p1Height - 50;
        const fontSize = 12;
        
        const title = fontResult.type === 'custom' ? "🔒 [보안 처리된 문서]" : "SECURE DOCUMENT";
        firstPage.drawText(title, { x: 50, y: textY, size: 16, font: useFont, color: rgb(0, 0.5, 0) });
        textY -= 40;

        const safeDraw = (label, value) => {
            const valStr = value || '정보없음';
            // 줄바꿈 제거 (한 줄로 출력하기 위해)
            const cleanVal = valStr.replace(/[\r\n]+/g, " "); 
            const text = fontResult.type === 'custom' ? `${label}: ${cleanVal}` : `${label}: ${cleanVal}`;
            
            // 너무 길면 자르기
            const maxLength = 70;
            const displayStr = text.length > maxLength ? text.substring(0, maxLength) + "..." : text;
            
            firstPage.drawText(displayStr, { x: 50, y: textY, size: fontSize, font: useFont, color: rgb(0, 0, 0) });
            textY -= 20;
        };

        safeDraw("법원", metaInfo.court);
        safeDraw("사건", metaInfo.caseNo);
        // 여기에 모든 당사자(참가인 포함)가 출력됨
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