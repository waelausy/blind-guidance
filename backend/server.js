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

function resolveLengthProfile(clipDurationSecRaw) {
    const clipDurationSec = Number.parseInt(String(clipDurationSecRaw ?? ''), 10);
    if (clipDurationSec <= 2) {
        return {
            sentenceCount: 1,
            maxWordsPerSentence: 9,
            styleEn: 'ultra-brief',
            styleFr: 'ultra-court',
            styleAr: 'قصير جداً',
        };
    }
    if (clipDurationSec <= 4) {
        return {
            sentenceCount: 2,
            maxWordsPerSentence: 13,
            styleEn: 'brief',
            styleFr: 'court',
            styleAr: 'قصير',
        };
    }
    return {
        sentenceCount: 2,
        maxWordsPerSentence: 18,
        styleEn: 'detailed but concise',
        styleFr: 'détaillé mais concis',
        styleAr: 'مفصل لكن مختصر',
    };
}

// --- System Prompts per Language ---
function getSystemPrompt(lang, contextStr, clipDurationSecRaw) {
    const lengthProfile = resolveLengthProfile(clipDurationSecRaw);
    const { sentenceCount, maxWordsPerSentence, styleEn, styleFr, styleAr } = lengthProfile;

    const prompts = {
        en: `You are a navigation safety assistant for a BLIND person. Analyze this short video clip.

OUTPUT FORMAT:
- ${sentenceCount} ${sentenceCount > 1 ? 'short sentences' : 'short sentence'} (max ${maxWordsPerSentence} words each)
- ${styleEn}, calm, clear, actionable; not dramatic
- Prioritize what the user must do now

RULES:
- ALWAYS respond, even when the path is safe
- Mention exact obstacle POSITION with clock direction when possible (12 o'clock ahead, 3 right, 9 left)
- Estimate DISTANCE in meters (or "very close" if < 1 meter)
- Mention movement direction of risks when visible (approaching/leaving/crossing)
- DANGER FIRST: obstacles, stairs, cars, bikes, people, curbs, holes, uneven ground
- Use one warning word only for immediate danger: "STOP" or "CAREFUL" (no repetition)
- If no immediate danger: confirm safe path and give the best direction
- Never say "I can see" or "I notice"
- Respond in ENGLISH only

PREVIOUS CONTEXT:
${contextStr}

Compare with context, mention important changes, then respond now:`,

        fr: `Tu es un assistant de sécurité et d'orientation pour une personne AVEUGLE. Analyse ce court clip vidéo.

FORMAT DE SORTIE :
- ${sentenceCount} ${sentenceCount > 1 ? 'phrases courtes' : 'phrase courte'} (max ${maxWordsPerSentence} mots par phrase)
- Ton ${styleFr}, calme, clair, actionnable; pas alarmiste
- Priorité à l'action immédiate utile

RÈGLES :
- TOUJOURS répondre, même si le passage est sûr
- Donner la POSITION précise des obstacles, idéalement en "heures" (12h devant, 3h droite, 9h gauche)
- Estimer la DISTANCE en mètres (ou "très proche" si < 1 mètre)
- Indiquer le mouvement des risques si visible (approche, s'éloigne, traverse)
- DANGER EN PREMIER : obstacles, escaliers, voitures, vélos, personnes, trottoir, trous, sol irrégulier
- Un seul mot d'alerte pour danger immédiat: "STOP" ou "ATTENTION" (sans répétition)
- S'il n'y a pas de danger immédiat : confirmer que c'est dégagé et donner la meilleure direction
- Ne jamais dire "Je vois" ou "Je remarque"
- Répondre en FRANÇAIS uniquement

CONTEXTE PRÉCÉDENT :
${contextStr}

Compare avec le contexte, signale les changements importants, puis réponds maintenant :`,

        ar: `أنت مساعد أمان وتوجيه لشخص كفيف. حلّل هذا المقطع القصير.

صيغة الإخراج:
- ${sentenceCount === 1 ? 'جملة قصيرة واحدة' : 'جملتان قصيرتان'} (حد أقصى ${maxWordsPerSentence} كلمة لكل جملة)
- أسلوب ${styleAr} بنبرة هادئة وواضحة وعملية، بدون تهويل
- ركّز على الإجراء المطلوب الآن

القواعد:
- أجب دائماً حتى لو كان الطريق آمناً
- اذكر الموقع الدقيق للعائق ويفضّل بطريقة الساعة (12 أمام، 3 يمين، 9 يسار)
- قدّر المسافة بالمتر (أو "قريب جداً" إذا أقل من متر)
- اذكر حركة الخطر إن ظهرت (يقترب/يبتعد/يعبر)
- الخطر أولاً: عوائق، سلالم، سيارات، دراجات، أشخاص، أرصفة، حفر، أرض غير مستوية
- استخدم كلمة تحذير واحدة فقط للخطر الفوري: "قف" أو "انتبه" (بدون تكرار)
- إذا لا يوجد خطر فوري: أكّد أن المسار آمن واذكر أفضل اتجاه
- لا تقل "أرى" أو "ألاحظ"
- أجب بالعربية فقط

السياق السابق:
${contextStr}

قارن مع السياق، واذكر أهم التغييرات، ثم أجب الآن:`
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
    const clipDurationSec = req.body?.clipDurationSec;

    try {
        const videoPath = req.file.path;
        const videoBytes = fs.readFileSync(videoPath);
        const base64Video = videoBytes.toString('base64');

        const contextStr = buildContextStr();
        const prompt = getSystemPrompt(lang, contextStr, clipDurationSec);

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
