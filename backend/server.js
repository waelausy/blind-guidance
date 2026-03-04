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

function getModePromptByLang(mode, lang) {
    const modePrompts = {
        navigation: {
            en: '- MODE: Navigation while moving. Prioritize immediate path safety and step-by-step movement guidance.',
            fr: '- MODE : Navigation en déplacement. Priorise la sécurité immédiate du trajet et les actions de déplacement.',
            ar: '- الوضع: تنقل أثناء الحركة. أعطِ أولوية للسلامة الفورية وإرشادات الحركة خطوة بخطوة.',
        },
        reading: {
            en: '- MODE: Reading. Prioritize text extraction (signs, labels, pages), then concise explanation. Do not repeat the same page text when unchanged.',
            fr: '- MODE : Lecture. Priorise la lecture du texte (panneaux, étiquettes, pages), puis une explication concise. Ne répète pas la même page si elle n\'a pas changé.',
            ar: '- الوضع: قراءة. أعطِ أولوية لاستخراج النص (لوحات، ملصقات، صفحات) ثم شرح مختصر. لا تكرر نص الصفحة نفسها إذا لم يتغير.',
        },
        focus: {
            en: '- MODE: Focus (static scene). User may be seated or still. Give a structured, detailed nearby-scene description and key object relations.',
            fr: '- MODE : Focus (scène statique). L\'utilisateur peut être assis ou immobile. Donne une description structurée et détaillée de la scène proche et des relations entre objets.',
            ar: '- الوضع: تركيز (مشهد ثابت). قد يكون المستخدم جالساً أو ثابتاً. قدّم وصفاً منظماً ومفصلاً للمشهد القريب وعلاقات العناصر المهمة.',
        },
        custom: {
            en: '- MODE: Custom personalized mode. Follow user-defined objective while keeping responses safe and actionable.',
            fr: '- MODE : Personnalisé. Suis l\'objectif défini par l\'utilisateur tout en gardant des réponses sûres et actionnables.',
            ar: '- الوضع: مخصص. اتبع هدف المستخدم المخصص مع الحفاظ على الأمان ووضوح التوجيه.',
        },
    };
    return modePrompts[mode]?.[lang] || modePrompts.navigation.en;
}

// --- System Prompts per Language ---
function getSystemPrompt(lang, contextStr, clipDurationSecRaw, modeRaw, customInstructionRaw) {
    const lengthProfile = resolveLengthProfile(clipDurationSecRaw);
    const { sentenceCount, maxWordsPerSentence, styleEn, styleFr, styleAr } = lengthProfile;
    const mode = normalizeMode(modeRaw);
    const customInstruction = normalizeCustomInstruction(customInstructionRaw);
    const modeInstructionEn = getModePromptByLang(mode, 'en');
    const modeInstructionFr = getModePromptByLang(mode, 'fr');
    const modeInstructionAr = getModePromptByLang(mode, 'ar');
    const customInstructionEn = mode === 'custom'
        ? (customInstruction
            ? `- USER CUSTOM OBJECTIVE (highest priority after immediate safety): ${customInstruction}`
            : '- USER CUSTOM OBJECTIVE: not provided yet. Ask concise clarifying guidance when useful.')
        : '';
    const customInstructionFr = mode === 'custom'
        ? (customInstruction
            ? `- OBJECTIF PERSONNALISÉ UTILISATEUR (priorité maximale après sécurité immédiate) : ${customInstruction}`
            : '- OBJECTIF PERSONNALISÉ : non fourni pour le moment. Donne des indications de clarification concises si utile.')
        : '';
    const customInstructionAr = mode === 'custom'
        ? (customInstruction
            ? `- هدف المستخدم المخصص (أولوية قصوى بعد السلامة الفورية): ${customInstruction}`
            : '- الهدف المخصص غير متوفر حالياً. قدّم إرشاداً توضيحياً مختصراً عند الحاجة.')
        : '';
    const isReadingMode = mode === 'reading';
    const positionRuleEn = isReadingMode
        ? '- In reading mode, describe text location simply (top/middle/bottom/left/right). Never use clock-time notation.'
        : '- Mention obstacle position clearly using front/back/left/right (or straight/slight left/slight right). Never use clock-time notation.';
    const positionRuleFr = isReadingMode
        ? '- En mode lecture, indique la position du texte simplement (haut/milieu/bas/gauche/droite). N\'utilise jamais la notation en heures.'
        : '- Donne la position des obstacles clairement avec devant/derrière/gauche/droite (ou tout droit/légèrement gauche/légèrement droite). N\'utilise jamais la notation en heures.';
    const positionRuleAr = isReadingMode
        ? '- في وضع القراءة، اذكر موقع النص بشكل بسيط (أعلى/وسط/أسفل/يسار/يمين). لا تستخدم صيغة الساعة إطلاقاً.'
        : '- اذكر موقع العوائق بوضوح باستخدام أمام/خلف/يسار/يمين (أو مباشرة/يسار قليلاً/يمين قليلاً). لا تستخدم صيغة الساعة إطلاقاً.';
    const readingDeltaEn = isReadingMode
        ? '- If the page/text is unchanged vs previous context, do NOT reread it. Give only delta/new lines or say unchanged briefly.'
        : '';
    const readingDeltaFr = isReadingMode
        ? '- Si la page/le texte est identique au contexte précédent, ne le relis pas. Donne seulement les nouveautés ou dis brièvement que c\'est inchangé.'
        : '';
    const readingDeltaAr = isReadingMode
        ? '- إذا كانت الصفحة/النص كما في السياق السابق فلا تعيد قراءتها. اذكر فقط الجديد أو قل باختصار أنه بدون تغيير.'
        : '';
    const dangerPriorityEn = isReadingMode
        ? '- Mention obstacle danger only if immediate and critical; otherwise prioritize reading content.'
        : '- DANGER FIRST: obstacles, stairs, cars, bikes, people, curbs, holes, uneven ground';
    const dangerPriorityFr = isReadingMode
        ? '- En mode lecture, ne signale les obstacles que s\'ils sont immédiats et critiques; sinon priorise le contenu du texte.'
        : '- DANGER EN PREMIER : obstacles, escaliers, voitures, vélos, personnes, trottoir, trous, sol irrégulier';
    const dangerPriorityAr = isReadingMode
        ? '- لا تذكر المخاطر إلا إذا كانت فورية وخطيرة؛ خلاف ذلك أعطِ أولوية لمحتوى القراءة.'
        : '- الخطر أولاً: عوائق، سلالم، سيارات، دراجات، أشخاص، أرصفة، حفر، أرض غير مستوية';

    const prompts = {
        en: `You are a navigation safety assistant for a BLIND person. Analyze this short video clip.

OUTPUT FORMAT:
- ${sentenceCount} ${sentenceCount > 1 ? 'short sentences' : 'short sentence'} (max ${maxWordsPerSentence} words each)
- ${styleEn}, calm, clear, actionable; not dramatic
- Prioritize what the user must do now
${modeInstructionEn}
${customInstructionEn}

RULES:
- ALWAYS respond, even when the path is safe
${positionRuleEn}
- Estimate DISTANCE in meters (or "very close" if < 1 meter)
- Mention movement direction of risks when visible (approaching/leaving/crossing)
${dangerPriorityEn}
${readingDeltaEn}
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
${modeInstructionFr}
${customInstructionFr}

RÈGLES :
- TOUJOURS répondre, même si le passage est sûr
${positionRuleFr}
- Estimer la DISTANCE en mètres (ou "très proche" si < 1 mètre)
- Indiquer le mouvement des risques si visible (approche, s'éloigne, traverse)
${dangerPriorityFr}
${readingDeltaFr}
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
${modeInstructionAr}
${customInstructionAr}

القواعد:
- أجب دائماً حتى لو كان الطريق آمناً
${positionRuleAr}
- قدّر المسافة بالمتر (أو "قريب جداً" إذا أقل من متر)
- اذكر حركة الخطر إن ظهرت (يقترب/يبتعد/يعبر)
${dangerPriorityAr}
${readingDeltaAr}
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

function getTalkPrompt(lang, modeRaw, customInstructionRaw) {
    const mode = normalizeMode(modeRaw);
    const customInstruction = normalizeCustomInstruction(customInstructionRaw);
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
    const modeLine = {
        navigation: {
            en: 'Current mode: NAVIGATION. Keep reply practical and safety-first for movement.',
            fr: 'Mode actuel : NAVIGATION. Réponse pratique, orientée sécurité de déplacement.',
            ar: 'الوضع الحالي: التنقل. اجعل الرد عملياً ويركّز على السلامة أثناء الحركة.',
        },
        reading: {
            en: 'Current mode: READING. Prioritize text understanding and factual clarification. Do not reread unchanged text; report only new/changed content. You may use web knowledge when needed.',
            fr: 'Mode actuel : LECTURE. Priorise la compréhension du texte et la clarification factuelle. Ne relis pas un contenu inchangé; annonce seulement ce qui est nouveau/modifié. Tu peux utiliser des connaissances web si nécessaire.',
            ar: 'الوضع الحالي: القراءة. أعطِ أولوية لفهم النص والتوضيح المعلوماتي. لا تعِد قراءة النص غير المتغير؛ اذكر فقط الجديد أو المعدّل. يمكنك استخدام معرفة الويب عند الحاجة.',
        },
        focus: {
            en: 'Current mode: FOCUS. Prioritize detailed scene explanation and object relationships.',
            fr: 'Mode actuel : FOCUS. Priorise la description détaillée de la scène et des relations entre objets.',
            ar: 'الوضع الحالي: التركيز. أعطِ أولوية للوصف التفصيلي للمشهد وعلاقات العناصر.',
        },
        custom: {
            en: 'Current mode: CUSTOM. Follow the user objective while remaining clear and safe.',
            fr: 'Mode actuel : PERSONNALISÉ. Suis l\'objectif utilisateur en restant clair et sûr.',
            ar: 'الوضع الحالي: مخصص. اتبع هدف المستخدم مع الحفاظ على الوضوح والأمان.',
        },
    };
    const customModeLine = {
        en: customInstruction
            ? `Custom objective to follow: ${customInstruction}`
            : 'No custom objective provided yet. Ask one concise clarifying question only if needed.',
        fr: customInstruction
            ? `Objectif personnalisé à suivre : ${customInstruction}`
            : 'Aucun objectif personnalisé fourni. Pose une seule question de clarification concise si nécessaire.',
        ar: customInstruction
            ? `الهدف المخصص المطلوب اتباعه: ${customInstruction}`
            : 'لا يوجد هدف مخصص حتى الآن. اطرح سؤال توضيح واحداً فقط عند الضرورة.',
    };
    return {
        transcriptInstruction: transcriptLine[lang] || transcriptLine.en,
        contextInstruction: contextLine[lang] || contextLine.en,
        modeInstruction: modeLine[mode]?.[lang] || modeLine.navigation.en,
        customModeInstruction: mode === 'custom' ? (customModeLine[lang] || customModeLine.en) : '',
        mode,
    };
}

function getCustomModeBuilderPrompt(lang) {
    const prompts = {
        en: `You are building a personalized assistant mode from user's voice.
Tasks:
1) Transcribe exactly what the user asked.
2) Rewrite as a clean, actionable custom instruction for a blind-guidance assistant.
3) Keep safety constraints explicit (no dangerous suggestions).
Return ONLY valid JSON:
{"rawUserIntent":"...","optimizedInstruction":"...","shortLabel":"..."}
Rules:
- optimizedInstruction: 1-3 short sentences, precise, operational
- shortLabel: 2-4 words
- language must be English.`,
        fr: `Tu construis un mode personnalisé à partir de la voix de l'utilisateur.
Tâches :
1) Transcrire exactement ce que l'utilisateur demande.
2) Réécrire en instruction personnalisée claire et actionnable pour un assistant de guidage.
3) Garder des contraintes de sécurité explicites (aucun conseil dangereux).
Retourne UNIQUEMENT du JSON valide :
{"rawUserIntent":"...","optimizedInstruction":"...","shortLabel":"..."}
Règles :
- optimizedInstruction : 1 à 3 phrases courtes, précises, opérationnelles
- shortLabel : 2 à 4 mots
- langue : français.`,
        ar: `أنت تبني وضعاً مخصصاً من صوت المستخدم.
المهام:
1) نسخ ما طلبه المستخدم حرفياً.
2) إعادة صياغته كتعليمات مخصصة واضحة وقابلة للتنفيذ لمساعد إرشاد.
3) إبقاء قيود السلامة واضحة (بدون اقتراحات خطرة).
أعد JSON صالحاً فقط:
{"rawUserIntent":"...","optimizedInstruction":"...","shortLabel":"..."}
القواعد:
- optimizedInstruction من 1 إلى 3 جمل قصيرة دقيقة وعملية
- shortLabel من 2 إلى 4 كلمات
- اللغة: العربية.`,
    };
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
