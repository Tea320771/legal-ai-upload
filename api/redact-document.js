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

export default async function handler(req, res) {
    console.log("🚀 API 호출됨: redact-document (RAW Debug Mode)");

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    try {
        const apiKey = process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.trim() : "";
        console.log(`🔑 API Key: ${apiKey.substring(0,5)}...`);

        // ============================================================
        // [핵심 진단] SDK 없이 직접 구글 서버에 물어보기 (List Models)
        // 이 요청의 결과 메시지를 보면 왜 404가 뜨는지 100% 알 수 있습니다.
        // ============================================================
        try {
            console.log("📡 구글 서버에 직접 모델 목록 요청 중...");
            const listUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
            
            const response = await fetch(listUrl);
            const data = await response.json();

            if (!response.ok) {
                console.error("❌ [치명적 오류] 구글 서버 응답 (Raw):");
                console.error(JSON.stringify(data, null, 2)); // 여기에 진짜 원인이 나옵니다.
                throw new Error(`Google API Error: ${data.error?.message || response.statusText}`);
            } else {
                console.log("✅ API 연결 성공! 사용 가능한 모델 목록:");
                // 모델 이름만 뽑아서 출력
                const models = data.models?.map(m => m.name) || [];
                console.log(models.join(", "));
            }
        } catch (e) {
            console.error("🚨 API 진단 실패:", e.message);
            // 진단 실패 시 여기서 멈춤 (로그 확인용)
            return res.status(500).json({ error: "API Key Error: Logs 확인 필요", details: e.message });
        }

        // ... (아래는 기존 로직과 동일하지만, 위에서 에러나면 실행 안 됨) ...
        const genAI = new GoogleGenerativeAI(apiKey);
        const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

        // (이하 생략 - 진단이 우선이므로)
        return res.status(200).json({ message: "진단 완료. Vercel Logs를 확인하세요." });

    } catch (error) {
        console.error("Server Error:", error);
        return res.status(500).json({ error: error.message });
    }
}