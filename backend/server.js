import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3005;

// --- Gemini AI Setup ---
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = 'gemini-3.1-flash-lite-preview';

// --- Pricing (gemini-3.1-flash-lite-preview) ---
const PRICE_VIDEO_INPUT_PER_TOKEN = 0.25 / 1_000_000;
const PRICE_AUDIO_INPUT_PER_TOKEN = 0.50 / 1_000_000;
const PRICE_OUTPUT_PER_TOKEN = 1.50 / 1_000_000;

// --- Context Memory ---
const MAX_CONTEXT_HISTORY = 12;
let contextHistory = [];
let startTime = null; // When detection started
let totalTokensIn = 0;
let totalTokensOut = 0;
let totalCost = 0;

// --- Multer for file uploads ---
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
        const ext = file.fieldname === 'audio' ? '.webm' : '.webm';
        cb(null, `${file.fieldname}_${Date.now()}${ext}`);
    },
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

// --- Middleware ---
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// --- System Prompts per Language ---
function getSystemPrompt(lang, contextStr) {
    const prompts = {
        en: `You are a safety AI for a BLIND person. Analyze this video clip.

OUTPUT FORMAT: 1-2 SHORT sentences. Max 15 words per sentence. Be direct and punchy.
Like a GPS but for obstacles: "STOP! Wall ahead." or "Clear path. Turn slightly left."

RULES:
- ALWAYS respond, even if safe
- DANGER FIRST: obstacles, stairs, cars, people, curbs, uneven ground
- Use: left/right/ahead/behind + distance if possible
- Start with STOP! or CAREFUL! for immediate danger
- If safe: one short scene description
- Never say "I can see" or "I notice"
- Respond in ENGLISH only

PREVIOUS CONTEXT:
${contextStr}

Note any CHANGES. Respond now:`,

        fr: `Tu es une IA de sécurité pour une personne AVEUGLE. Analyse ce clip vidéo.

FORMAT : 1-2 phrases COURTES. Max 15 mots par phrase. Direct et précis.
Comme un GPS d'obstacles : "STOP ! Mur devant." ou "Chemin libre. Légèrement à gauche."

RÈGLES :
- TOUJOURS répondre, même si c'est sûr
- DANGER EN PREMIER : obstacles, escaliers, voitures, personnes, trottoir, sol inégal
- Utiliser : gauche/droite/devant/derrière + distance si possible
- Commencer par STOP ! ou ATTENTION ! pour danger immédiat
- Si sûr : une courte description de la scène
- Ne jamais dire "Je vois" ou "Je remarque"
- Répondre en FRANÇAIS uniquement

CONTEXTE PRÉCÉDENT :
${contextStr}

Note les CHANGEMENTS. Réponds maintenant :`,

        ar: `أنت ذكاء اصطناعي للسلامة لشخص أعمى. حلل هذا المقطع.

التنسيق: 1-2 جمل قصيرة. 15 كلمة كحد أقصى للجملة. مباشر وواضح.
مثل: "قف! جدار أمامك." أو "الطريق واضح. انعطف يساراً قليلاً."

القواعد:
- أجب دائماً حتى لو كان الطريق آمناً
- الخطر أولاً: عوائق، سلالم، سيارات، أشخاص، أرصفة، أرض غير مستوية
- استخدم: يسار/يمين/أمام/خلف + المسافة إن أمكن
- ابدأ بـ "قف!" أو "انتبه!" للخطر الفوري
- إن كان آمناً: وصف قصير للمشهد
- لا تقل "أرى" أو "ألاحظ"
- أجب بالعربية فقط

السياق السابق:
${contextStr}

لاحظ التغييرات. أجب الآن:`
    };
    return prompts[lang] || prompts.en;
}

function getTalkPrompt(lang) {
    const transcriptLine = {
        en: 'First, transcribe EXACTLY what the user said (field "userText"). Then provide a helpful, SHORT reply (field "reply", max 2 sentences). Return ONLY valid JSON: {"userText": "...", "reply": "..."}. Respond in ENGLISH.',
        fr: 'D\'abord, transcris EXACTEMENT ce que l\'utilisateur a dit (champ "userText"). Ensuite, fournis une réponse utile et COURTE (champ "reply", max 2 phrases). Retourne UNIQUEMENT du JSON valide: {"userText": "...", "reply": "..."}. Réponds en FRANÇAIS.',
        ar: 'أولاً، انسخ بالضبط ما قاله المستخدم (حقل "userText"). ثم قدم رداً مفيداً وقصيراً (حقل "reply"، جملتان كحد أقصى). أعد JSON صالحاً فقط: {"userText": "...", "reply": "..."}. أجب بالعربية.',
    };
    const contextLine = {
        en: 'Context from recent scene detections (use if relevant to user question):',
        fr: 'Contexte des détections récentes (utilise si pertinent pour la question):',
        ar: 'سياق الاكتشافات الأخيرة (استخدمه إن كان ذا صلة بالسؤال):',
    };
    return {
        transcriptInstruction: transcriptLine[lang] || transcriptLine.en,
        contextInstruction: contextLine[lang] || contextLine.en,
    };
}

// --- Helper: build context string ---
function buildContextStr() {
    if (contextHistory.length === 0) return 'No previous detections yet. This is the first scan.';
    return contextHistory.map((c, i) => `[${i + 1}] ${c.timestamp}: ${c.guidance}`).join('\n');
}

// --- Helper: calculate costs ---
function calcCost(inputTokens, outputTokens, isAudio = false) {
    const costIn = inputTokens * (isAudio ? PRICE_AUDIO_INPUT_PER_TOKEN : PRICE_VIDEO_INPUT_PER_TOKEN);
    const costOut = outputTokens * PRICE_OUTPUT_PER_TOKEN;
    return costIn + costOut;
}

// --- Helper: get elapsed time and rate estimates ---
function getStats(additionalCost, additionalIn, additionalOut) {
    totalTokensIn += additionalIn;
    totalTokensOut += additionalOut;
    totalCost += additionalCost;

    const elapsedMs = startTime ? (Date.now() - startTime) : 1000;
    const elapsedMin = elapsedMs / 60000;
    const costPerMin = elapsedMin > 0 ? totalCost / elapsedMin : 0;
    const costPerHour = costPerMin * 60;

    return {
        inputTokens: additionalIn,
        outputTokens: additionalOut,
        totalInputTokens: totalTokensIn,
        totalOutputTokens: totalTokensOut,
        totalTokens: totalTokensIn + totalTokensOut,
        thisCost: additionalCost,
        totalCost,
        costPerMin,
        costPerHour,
        elapsedMs,
    };
}

// --- API Routes ---

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', model: MODEL });
});

// Analyze video clip (continuous loop)
app.post('/api/analyze', upload.single('video'), async (req, res) => {
    const reqStart = Date.now();
    if (!startTime) startTime = Date.now();

    if (!req.file) {
        return res.status(400).json({ error: 'No video file received' });
    }

    const lang = req.body?.lang || 'en';

    try {
        const videoPath = req.file.path;
        const videoBytes = fs.readFileSync(videoPath);
        const base64Video = videoBytes.toString('base64');

        const contextStr = buildContextStr();
        const prompt = getSystemPrompt(lang, contextStr);

        const contents = [
            {
                inlineData: {
                    mimeType: req.file.mimetype || 'video/webm',
                    data: base64Video,
                },
            },
            { text: prompt }
        ];

        const config = {
            thinkingConfig: { thinkingLevel: 'MINIMAL' },
        };

        const response = await ai.models.generateContent({
            model: MODEL,
            config,
            contents,
        });

        const guidance = response.text || 'Unable to analyze scene.';
        const usage = response.usageMetadata || {};
        const inputTokens = usage.promptTokenCount || 0;
        const outputTokens = usage.candidatesTokenCount || 0;
        const thisCost = calcCost(inputTokens, outputTokens, false);
        const stats = getStats(thisCost, inputTokens, outputTokens);

        const processingTime = Date.now() - reqStart;

        // Add to context history
        contextHistory.unshift({
            timestamp: new Date().toLocaleTimeString(),
            guidance: guidance.trim(),
        });
        if (contextHistory.length > MAX_CONTEXT_HISTORY) {
            contextHistory = contextHistory.slice(0, MAX_CONTEXT_HISTORY);
        }

        // Clean up
        fs.unlink(videoPath, () => { });

        // Determine alert level
        const upper = guidance.toUpperCase();
        let alertLevel = 'info';
        if (upper.includes('STOP') || upper.includes('DANGER') || upper.includes('قف') || upper.includes('خطر')) {
            alertLevel = 'danger';
        } else if (upper.includes('CAREFUL') || upper.includes('CAUTION') || upper.includes('WATCH') || upper.includes('WARNING') || upper.includes('ATTENTION') || upper.includes('انتبه')) {
            alertLevel = 'warning';
        } else if (upper.includes('CLEAR') || upper.includes('SAFE') || upper.includes('DÉGAGÉ') || upper.includes('واضح') || upper.includes('آمن')) {
            alertLevel = 'safe';
        }

        res.json({
            guidance: guidance.trim(),
            alertLevel,
            processingTimeMs: processingTime,
            contextSize: contextHistory.length,
            stats,
        });
    } catch (error) {
        console.error('Gemini API error:', error);
        if (req.file?.path) fs.unlink(req.file.path, () => { });
        res.status(500).json({
            error: 'Analysis failed',
            details: error.message,
            guidance: lang === 'fr' ? 'Erreur système. Restez vigilant.' : lang === 'ar' ? 'خطأ في النظام. ابقَ حذرًا.' : 'System error. Stay alert.',
            alertLevel: 'warning',
        });
    }
});

// Talk endpoint — push-to-talk audio interaction
app.post('/api/talk', upload.single('audio'), async (req, res) => {
    const reqStart = Date.now();

    if (!req.file) {
        return res.status(400).json({ error: 'No audio file received' });
    }

    const lang = req.body?.lang || 'en';

    try {
        const audioPath = req.file.path;
        const audioBytes = fs.readFileSync(audioPath);
        const base64Audio = audioBytes.toString('base64');

        const contextStr = buildContextStr();
        const { transcriptInstruction, contextInstruction } = getTalkPrompt(lang);
        const fullPrompt = `${transcriptInstruction}\n\n${contextInstruction}\n${contextStr}\n\nNow listen to the audio clip and respond with valid JSON only:`;

        const contents = [
            {
                inlineData: {
                    mimeType: req.file.mimetype || 'audio/webm',
                    data: base64Audio,
                },
            },
            { text: fullPrompt }
        ];

        const config = {
            thinkingConfig: { thinkingLevel: 'MINIMAL' },
            responseMimeType: 'application/json',
        };

        const response = await ai.models.generateContent({
            model: MODEL,
            config,
            contents,
        });

        const rawText = response.text || '{}';
        const usage = response.usageMetadata || {};
        const inputTokens = usage.promptTokenCount || 0;
        const outputTokens = usage.candidatesTokenCount || 0;
        const thisCost = calcCost(inputTokens, outputTokens, true);
        const stats = getStats(thisCost, inputTokens, outputTokens);

        // Parse JSON response from model
        let userText = null;
        let reply = lang === 'fr' ? 'Désolé, je n\'ai pas compris.' :
            lang === 'ar' ? 'عذرًا، لم أفهم.' :
                'Sorry, I could not understand.';
        try {
            const parsed = JSON.parse(rawText.trim());
            userText = parsed.userText || null;
            reply = parsed.reply || reply;
        } catch (e) {
            // If model didn't return JSON, use raw text as reply
            reply = rawText.trim() || reply;
        }

        // Clean up
        fs.unlink(audioPath, () => { });

        res.json({
            userText,
            reply,
            processingTimeMs: Date.now() - reqStart,
            stats,
        });
    } catch (error) {
        console.error('Talk API error:', error);
        if (req.file?.path) fs.unlink(req.file.path, () => { });
        res.status(500).json({
            error: 'Talk failed',
            details: error.message,
        });
    }
});

// Auth — password gate
app.post('/api/auth', (req, res) => {
    const { password } = req.body || {};
    const APP_PASSWORD = process.env.APP_PASSWORD || '';
    if (!APP_PASSWORD) return res.status(200).json({ ok: true }); // no password set = open
    if (password === APP_PASSWORD) return res.status(200).json({ ok: true });
    return res.status(401).json({ ok: false });
});

// Reset context
app.post('/api/reset', (req, res) => {
    contextHistory = [];
    startTime = null;
    totalTokensIn = 0;
    totalTokensOut = 0;
    totalCost = 0;
    res.json({ status: 'ok' });
});

// --- Start Server ---
app.listen(PORT, () => {
    console.log(`\n🦯 Blind Guidance Server running on http://localhost:${PORT}`);
    console.log(`📡 Model: ${MODEL}`);
    console.log(`🔑 API Key: ${process.env.GEMINI_API_KEY ? '✅ Configured' : '❌ MISSING'}`);
    console.log(`💰 Pricing (Video): $0.25/1M in, $1.50/1M out | (Audio): $0.50/1M in, $1.50/1M out`);
    console.log(`\n   Open http://localhost:${PORT} in your phone browser\n`);
});
