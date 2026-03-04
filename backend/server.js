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

// Load prompts
const promptsData = JSON.parse(fs.readFileSync(path.join(__dirname, 'prompts.json'), 'utf8'));

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

function normalizeMode(modeRaw) {
    const mode = String(modeRaw || 'navigation').trim().toLowerCase();
    if (mode === 'reading' || mode === 'focus' || mode === 'custom') return mode;
    return 'navigation';
}

function normalizeCustomInstruction(customInstructionRaw) {
    const clean = String(customInstructionRaw || '')
        .replace(/\s+/g, ' ')
        .trim();
    return clean.slice(0, 700);
}

// --- System Prompts per Language ---
function getSystemPrompt(lang, contextStr, clipDurationSecRaw, modeRaw, customInstructionRaw) {
    const lengthProfile = resolveLengthProfile(clipDurationSecRaw);
    const { sentenceCount, maxWordsPerSentence, styleEn, styleFr, styleAr } = lengthProfile;
    const mode = normalizeMode(modeRaw);
    const customInstruction = normalizeCustomInstruction(customInstructionRaw);
    
    const style = lang === 'fr' ? styleFr : (lang === 'ar' ? styleAr : styleEn);
    
    let sentenceCountStr = '';
    if (lang === 'en') sentenceCountStr = `${sentenceCount} ${sentenceCount > 1 ? 'short sentences' : 'short sentence'}`;
    else if (lang === 'fr') sentenceCountStr = `${sentenceCount} ${sentenceCount > 1 ? 'phrases courtes' : 'phrase courte'}`;
    else if (lang === 'ar') sentenceCountStr = sentenceCount === 1 ? 'جملة قصيرة واحدة' : 'جملتان قصيرتان';
    
    const modeTemplates = promptsData.systemPrompts[mode];
    if (!modeTemplates) {
        console.error(`Unknown mode: ${mode}, falling back to navigation`);
        return promptsData.systemPrompts.navigation[lang] || promptsData.systemPrompts.navigation.en;
    }
    
    let template = modeTemplates[lang] || modeTemplates.en;
    
    let customInstructionText = '';
    if (mode === 'custom') {
        if (customInstruction) {
            customInstructionText = `USER CUSTOM OBJECTIVE (highest priority after immediate safety):\n${customInstruction}`;
        } else {
            const fallback = {
                en: 'USER CUSTOM OBJECTIVE: not provided yet. Ask concise clarifying guidance when useful.',
                fr: 'OBJECTIF PERSONNALISÉ : non fourni pour le moment. Donne des indications de clarification concises si utile.',
                ar: 'الهدف المخصص غير متوفر حالياً. قدّم إرشاداً توضيحياً مختصراً عند الحاجة.'
            };
            customInstructionText = fallback[lang] || fallback.en;
        }
    }
    
    template = template.replace(/\{\{sentenceCountStr\}\}/g, sentenceCountStr)
                       .replace(/\{\{maxWordsPerSentence\}\}/g, maxWordsPerSentence)
                       .replace(/\{\{style\}\}/g, style)
                       .replace(/\{\{customInstruction\}\}/g, customInstructionText)
                       .replace(/\{\{contextStr\}\}/g, contextStr);
                       
    return template;
}

function getAnalyzeSchema() {
    return promptsData.analyzeSchema;
}

function getTalkPrompt(lang, modeRaw, customInstructionRaw) {
    const mode = normalizeMode(modeRaw);
    const customInstruction = normalizeCustomInstruction(customInstructionRaw);
    
    const talkPrompts = promptsData.talkPrompts;
    
    const transcriptInstruction = talkPrompts.transcriptLine[lang] || talkPrompts.transcriptLine.en;
    const contextInstruction = talkPrompts.contextLine[lang] || talkPrompts.contextLine.en;
    const modeInstruction = talkPrompts.modeLine[mode]?.[lang] || talkPrompts.modeLine.navigation.en;
    
    let customModeInstruction = '';
    if (mode === 'custom') {
        if (customInstruction) {
            customModeInstruction = talkPrompts.customModeLine.withUser[lang].replace('{{customInstruction}}', customInstruction);
        } else {
            customModeInstruction = talkPrompts.customModeLine.withoutUser[lang];
        }
    }
    
    return {
        transcriptInstruction,
        contextInstruction,
        modeInstruction,
        customModeInstruction,
        mode,
    };
}

function getCustomModeBuilderPrompt(lang) {
    const prompts = promptsData.customModeBuilderPrompts;
    return prompts[lang] || prompts.en;
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
    const mode = normalizeMode(req.body?.mode);
    const customInstruction = req.body?.customInstruction || '';

    try {
        const videoPath = req.file.path;
        const videoBytes = fs.readFileSync(videoPath);
        const base64Video = videoBytes.toString('base64');

        const contextStr = buildContextStr();
        const prompt = getSystemPrompt(lang, contextStr, clipDurationSec, mode, customInstruction);

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
            responseMimeType: 'application/json',
            responseJsonSchema: getAnalyzeSchema(),
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
        const thisCost = calcCost(inputTokens, outputTokens, false);
        const stats = getStats(thisCost, inputTokens, outputTokens);

        const processingTime = Date.now() - reqStart;

        // Parse structured JSON response
        let shouldRespond = true;
        let alertLevel = 'info';
        let guidance = '';
        try {
            const parsed = JSON.parse(rawText.trim());
            shouldRespond = parsed.shouldRespond !== false;
            alertLevel = ['danger', 'warning', 'safe', 'info'].includes(parsed.alertLevel) ? parsed.alertLevel : 'info';
            guidance = String(parsed.guidance || '').trim();
        } catch (e) {
            console.error('Failed to parse structured response, using raw:', e.message);
            guidance = rawText.trim();
            shouldRespond = true;
        }

        // Only add to context history when the model decided to respond
        if (shouldRespond && guidance) {
            contextHistory.unshift({
                timestamp: new Date().toLocaleTimeString(),
                guidance,
            });
            if (contextHistory.length > MAX_CONTEXT_HISTORY) {
                contextHistory = contextHistory.slice(0, MAX_CONTEXT_HISTORY);
            }
        }

        // Clean up
        fs.unlink(videoPath, () => { });

        res.json({
            shouldRespond,
            guidance,
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
    const mode = normalizeMode(req.body?.mode);
    const customInstruction = req.body?.customInstruction || '';

    try {
        const audioPath = req.file.path;
        const audioBytes = fs.readFileSync(audioPath);
        const base64Audio = audioBytes.toString('base64');

        const contextStr = buildContextStr();
        const { transcriptInstruction, contextInstruction, modeInstruction, customModeInstruction } = getTalkPrompt(lang, mode, customInstruction);
        const fullPrompt = `${transcriptInstruction}\n\n${modeInstruction}\n${customModeInstruction}\n\n${contextInstruction}\n${contextStr}\n\nNow listen to the audio clip and respond with valid JSON only:`;

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
        const customWantsWebSearch = mode === 'custom' && /internet|web|google|search|recherche|chercher|بحث|ويب/i.test(customInstruction);
        if (mode === 'reading' || customWantsWebSearch) {
            config.tools = [{ googleSearch: {} }];
        }

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

// Build a custom mode from voice (transcribe + optimize instruction)
app.post('/api/customize-mode', upload.single('audio'), async (req, res) => {
    const reqStart = Date.now();
    if (!req.file) {
        return res.status(400).json({ error: 'No audio file received' });
    }

    const lang = req.body?.lang || 'en';

    try {
        const audioPath = req.file.path;
        const audioBytes = fs.readFileSync(audioPath);
        const base64Audio = audioBytes.toString('base64');

        const prompt = getCustomModeBuilderPrompt(lang);
        const contents = [
            {
                inlineData: {
                    mimeType: req.file.mimetype || 'audio/webm',
                    data: base64Audio,
                },
            },
            { text: prompt },
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

        let rawUserIntent = '';
        let optimizedInstruction = '';
        let shortLabel = '';
        try {
            const parsed = JSON.parse(rawText.trim());
            rawUserIntent = String(parsed.rawUserIntent || '').trim();
            optimizedInstruction = normalizeCustomInstruction(parsed.optimizedInstruction || '');
            shortLabel = String(parsed.shortLabel || '').trim().slice(0, 40);
        } catch (e) {
            optimizedInstruction = normalizeCustomInstruction(rawText);
        }

        if (!optimizedInstruction) {
            optimizedInstruction = lang === 'fr'
                ? 'Décrire clairement la scène et donner des actions utiles avec priorité sécurité.'
                : lang === 'ar'
                    ? 'صف المشهد بوضوح وقدم إجراءات مفيدة مع أولوية السلامة.'
                    : 'Describe the scene clearly and provide useful actions with safety priority.';
        }

        fs.unlink(audioPath, () => { });

        res.json({
            rawUserIntent,
            optimizedInstruction,
            shortLabel,
            processingTimeMs: Date.now() - reqStart,
            stats,
        });
    } catch (error) {
        console.error('Customize mode API error:', error);
        if (req.file?.path) fs.unlink(req.file.path, () => { });
        res.status(500).json({
            error: 'Customize mode failed',
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
