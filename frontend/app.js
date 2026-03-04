/**
 * Blind Guide AI — Frontend Application
 * 
 * - Language selection (AR/FR/EN)
 * - Configurable capture duration (2s/4s/8s)
 * - Continuous video analysis with Gemini
 * - Push-to-talk audio interaction
 * - Live token/cost stats with $/min and $/hr
 * - Natural TTS via ResponsiveVoice (Google voices)
 */

const API_BASE = window.location.origin;
const MAX_HISTORY_DISPLAY = 8;
const LONG_PRESS_HINT_MS = 650;

// --- DOM Elements ---
const langScreen = document.getElementById('lang-screen');
const modeScreen = document.getElementById('mode-screen');
const modeButtons = document.querySelectorAll('.mode-btn');
const modeContinueBtn = document.getElementById('mode-continue-btn');
const modeBadge = document.getElementById('mode-badge');
const customModeConfig = document.getElementById('custom-mode-config');
const customModeRecordBtn = document.getElementById('custom-mode-record-btn');
const customModeStatus = document.getElementById('custom-mode-status');
const customModePreview = document.getElementById('custom-mode-preview');
const navBackBtn = document.getElementById('nav-back-btn');
const appScreen = document.getElementById('app');
const langButtons = document.querySelectorAll('.lang-btn');

// --- Password Gate ---
const passwordScreen = document.getElementById('password-screen');
const passwordInput = document.getElementById('password-input');
const passwordSubmit = document.getElementById('password-submit');
const passwordError = document.getElementById('password-error');

async function checkPassword(pwd) {
    try {
        const res = await fetch(`${API_BASE}/api/auth`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: pwd }),
        });
        return res.ok;
    } catch (e) {
        return false;
    }
}

const cameraPreview = document.getElementById('camera-preview');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const scanCount = document.getElementById('scan-count');
const alertBanner = document.getElementById('alert-banner');
const alertIcon = document.getElementById('alert-icon');
const alertTextEl = document.getElementById('alert-text');
const guidanceTextWrapper = document.getElementById('guidance-text-wrapper');
const guidanceText = document.getElementById('guidance-text');
const processingIndicator = document.getElementById('processing-indicator');
const historyList = document.getElementById('history-list');
const startBtn = document.getElementById('start-btn');
const talkBtn = document.getElementById('talk-btn');
const voiceToggleBtn = document.getElementById('voice-toggle-btn');
const clearHistoryBtn = document.getElementById('clear-history-btn');

const durButtons = document.querySelectorAll('.dur-btn');

const statTokens = document.getElementById('stat-tokens');
const statCost = document.getElementById('stat-cost');
const statPerMin = document.getElementById('stat-per-min');
const statPerHour = document.getElementById('stat-per-hour');
const statElapsed = document.getElementById('stat-elapsed');

// --- State ---
let selectedLang = 'en';
let selectedMode = 'navigation';
let clipDurationMs = 4000;
let isRunning = false;
let mediaStream = null;
let mediaRecorder = null;
let recordedChunks = [];
let scanNumber = 0;
let loopTimeout = null;
let sessionStartTime = null;
let elapsedInterval = null;

// Push-to-talk
let audioRecorder = null;
let audioChunks = [];
let isTalking = false;
let isTalkFlowActive = false;
let currentAnalyzeController = null;
let customModeInstruction = '';
let customModeShortLabel = '';
let customModeRawIntent = '';
let customModeRecorder = null;
let customModeChunks = [];
let customModeRecording = false;
let customModeAudioStream = null;
let currentScreen = 'password';
const routeStack = [];

const modeLabels = {
    navigation: 'NAVIGATION',
    reading: 'READING',
    focus: 'FOCUS',
    custom: 'CUSTOM',
};

// --- Voice Engine ---
// Strategy: prefer Chrome/Android Google Neural voices (WaveNet quality)
// They are named "Google français", "Google UK English Female", etc.
// Fallback to ResponsiveVoice, then raw SpeechSynthesis.

const langToGoogleVoiceHint = {
    fr: ['Google français', 'Google French', 'fr-FR'],
    en: ['Google UK English Female', 'Google US English', 'en-GB', 'en-US'],
    ar: ['Google \u0639\u0631\u0628\u064a', 'Google Arabic', 'ar-SA', 'ar-XA'],
};

const langToRVVoice = {
    en: 'UK English Female',
    fr: 'French Female',
    ar: 'Arabic Female',
};

const langToLocale = {
    en: 'en-US',
    fr: 'fr-FR',
    ar: 'ar-SA',
};

// Voice enabled by default
let voiceEnabled = true;
let ttsVoices = [];
let audioCtx = null;

// Unlock AudioContext on first user gesture (required on iOS/Chrome HTTPS)
function unlockAudio() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
    // Silent utterance to unlock SpeechSynthesis on iOS
    const silent = new SpeechSynthesisUtterance(' ');
    silent.volume = 0;
    window.speechSynthesis.speak(silent);
}

// Load voices (they load asynchronously in browsers)
function loadVoices() {
    ttsVoices = window.speechSynthesis.getVoices();
}
window.speechSynthesis.onvoiceschanged = loadVoices;
loadVoices();

// --- Password Gate Init (after unlockAudio is defined) ---
if (passwordScreen) {
    const savedToken = sessionStorage.getItem('blind_auth');
    if (savedToken === 'ok') {
        navigateTo('lang', { push: true, resetStack: true });
    } else {
        navigateTo('password', { push: false, resetStack: true });
    }

    passwordSubmit.addEventListener('click', async () => {
        const pwd = passwordInput.value.trim();
        if (!pwd) return;
        unlockAudio();
        const ok = await checkPassword(pwd);
        if (ok) {
            sessionStorage.setItem('blind_auth', 'ok');
            navigateTo('lang');
        } else {
            passwordError.classList.remove('hidden');
            passwordInput.value = '';
        }
    });

    passwordInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') passwordSubmit.click();
    });
}

function pickBestVoice(lang) {
    if (ttsVoices.length === 0) ttsVoices = window.speechSynthesis.getVoices();
    const hints = langToGoogleVoiceHint[lang] || langToGoogleVoiceHint.en;
    const locale = langToLocale[lang] || langToLocale.en;
    const langPrefix = locale.split('-')[0].toLowerCase();

    const matchesLang = (voice) => {
        const vLang = (voice.lang || '').toLowerCase();
        return vLang === locale.toLowerCase() || vLang.startsWith(`${langPrefix}-`) || vLang === langPrefix;
    };

    // Try exact voice name first (Google Neural)
    for (const hint of hints) {
        const v = ttsVoices.find(v => v.name === hint);
        if (v && matchesLang(v)) return v;
    }

    // Prefer exact locale match first (any provider)
    const exactLocaleVoice = ttsVoices.find(v => (v.lang || '').toLowerCase() === locale.toLowerCase());
    if (exactLocaleVoice) return exactLocaleVoice;

    // Then Google voice in the target language
    const googleVoice = ttsVoices.find(v =>
        v.name.toLowerCase().includes('google') && matchesLang(v)
    );
    if (googleVoice) return googleVoice;

    // Fallback: any voice for that language
    return ttsVoices.find(v => matchesLang(v)) || null;
}

function speak(text) {
    if (!voiceEnabled || !text) return;
    stopSpeaking();

    const locale = langToLocale[selectedLang] || langToLocale.en;
    const voice = pickBestVoice(selectedLang);

    // Prefer browser SpeechSynthesis when a language-matching voice is available
    if (voice) {
        const utt = new SpeechSynthesisUtterance(text);
        utt.voice = voice;
        utt.lang = locale;
        utt.rate = 1.05;
        utt.pitch = 1.0;
        utt.volume = 1;
        window.speechSynthesis.speak(utt);
        return;
    }

    // ResponsiveVoice as second option
    if (typeof responsiveVoice !== 'undefined') {
        const rvVoice = langToRVVoice[selectedLang] || 'UK English Female';
        try {
            responsiveVoice.speak(text, rvVoice, { rate: 1, pitch: 1, volume: 1 });
            return;
        } catch (e) {
            // Continue to browser fallback below
        }
    }

    // Last resort: raw browser voice
    const utt = new SpeechSynthesisUtterance(text);
    utt.lang = locale;
    if (voice) utt.voice = voice;
    utt.rate = 1.05;
    window.speechSynthesis.speak(utt);
}

function stopSpeaking() {
    window.speechSynthesis.cancel();
    if (typeof responsiveVoice !== 'undefined' && responsiveVoice.isPlaying()) {
        responsiveVoice.cancel();
    }
}

function closeCustomModeAudioStream() {
    if (!customModeAudioStream) return;
    customModeAudioStream.getTracks().forEach((track) => track.stop());
    customModeAudioStream = null;
}

function releaseCameraStream() {
    if (!mediaStream) return;
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
    if (cameraPreview) cameraPreview.srcObject = null;
}

function setScreen(screen) {
    const screens = {
        password: passwordScreen,
        lang: langScreen,
        mode: modeScreen,
        app: appScreen,
    };
    Object.values(screens).forEach((node) => {
        if (!node) return;
        node.classList.add('hidden');
    });
    const target = screens[screen] || screens.password;
    target.classList.remove('hidden');
    currentScreen = screen;
    updateCustomModeUI();
    updateModeBadge();
    updateBackButtonUI();
}

function updateBackButtonUI() {
    if (!navBackBtn) return;
    const hasBack = routeStack.length > 0;
    navBackBtn.classList.toggle('hidden', !hasBack);
    navBackBtn.disabled = !hasBack;
}

function navigateTo(screen, options = {}) {
    const { push = true, resetStack = false } = options;
    if (resetStack) routeStack.length = 0;
    if (push && currentScreen !== screen) {
        routeStack.push(currentScreen);
    }
    setScreen(screen);
}

function navigateBack() {
    if (routeStack.length === 0) return;
    const previous = routeStack.pop();
    if (currentScreen === 'app') {
        stop();
        releaseCameraStream();
    }
    if (currentScreen === 'mode') {
        stopCustomModeRecording();
        closeCustomModeAudioStream();
    }
    setScreen(previous);
}

function tByLang(texts) {
    if (selectedLang === 'fr') return texts.fr;
    if (selectedLang === 'ar') return texts.ar;
    return texts.en;
}

function getCustomRecordButtonIdleText() {
    return tByLang({
        en: 'Hold To Record Goal',
        fr: 'Maintenir pour enregistrer l\'objectif',
        ar: 'اضغط مطولاً لتسجيل الهدف',
    });
}

function updateCustomModeUI() {
    if (!customModeConfig || !customModeStatus || !customModePreview) return;
    const isCustom = selectedMode === 'custom';
    customModeConfig.classList.toggle('hidden', !isCustom);
    if (!isCustom) return;
    if (customModeRecordBtn && !customModeRecording) {
        customModeRecordBtn.textContent = getCustomRecordButtonIdleText();
    }

    if (customModeInstruction) {
        customModeStatus.textContent = tByLang({
            en: 'Custom objective ready. You can record again anytime.',
            fr: 'Objectif personnalisé prêt. Vous pouvez réenregistrer à tout moment.',
            ar: 'الهدف المخصص جاهز. يمكنك التسجيل مرة أخرى في أي وقت.',
        });
        customModePreview.classList.remove('hidden');
        customModePreview.textContent = customModeInstruction;
    } else {
        customModeStatus.textContent = tByLang({
            en: 'Hold the button and describe exactly what you want.',
            fr: 'Maintenez le bouton et décrivez exactement ce que vous voulez.',
            ar: 'اضغط مطولاً على الزر واشرح بالضبط ما تريده.',
        });
        customModePreview.classList.add('hidden');
        customModePreview.textContent = '';
    }
}

function updateModeBadge() {
    if (!modeBadge) return;
    const customLabel = customModeShortLabel ? customModeShortLabel.toUpperCase().slice(0, 18) : modeLabels.custom;
    const label = selectedMode === 'custom'
        ? customLabel
        : (modeLabels[selectedMode] || modeLabels.navigation);
    modeBadge.textContent = `MODE: ${label}`;
}

function startAppFlow() {
    closeCustomModeAudioStream();
    navigateTo('app');
    updateModeBadge();
    initCamera();
}

// --- Language Selection ---
langButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        selectedLang = btn.dataset.lang;
        unlockAudio();
        navigateTo('mode');
        updateCustomModeUI();
    });
});

modeButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        modeButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedMode = btn.dataset.mode || 'navigation';
        updateCustomModeUI();
        updateModeBadge();
    });
});

if (modeContinueBtn) {
    modeContinueBtn.addEventListener('click', () => {
        unlockAudio();
        startAppFlow();
    });
}

function getSupportedAudioMime() {
    const audioMimeTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
    for (const mime of audioMimeTypes) {
        if (MediaRecorder.isTypeSupported(mime)) return mime;
    }
    return '';
}

async function ensureCustomAudioStream() {
    if (customModeAudioStream) return customModeAudioStream;
    customModeAudioStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    return customModeAudioStream;
}

function startCustomModeRecording(e) {
    if (e) e.preventDefault();
    if (!customModeRecordBtn || selectedMode !== 'custom' || customModeRecording) return;
    stopSpeaking();
    unlockAudio();

    (async () => {
        try {
            const stream = await ensureCustomAudioStream();
            const selectedAudioMime = getSupportedAudioMime();
            if (!selectedAudioMime) {
                customModeStatus.textContent = tByLang({
                    en: 'Audio recording is not supported on this browser.',
                    fr: 'Enregistrement audio non supporté sur ce navigateur.',
                    ar: 'تسجيل الصوت غير مدعوم في هذا المتصفح.',
                });
                return;
            }

            customModeRecorder = new MediaRecorder(stream, { mimeType: selectedAudioMime });
            customModeChunks = [];
            customModeRecording = true;
            customModeRecordBtn.classList.add('recording');
            customModeRecordBtn.textContent = tByLang({
                en: 'Recording... Release to send',
                fr: 'Enregistrement... Relâchez pour envoyer',
                ar: 'جارٍ التسجيل... حرر للإرسال',
            });
            customModeStatus.textContent = tByLang({
                en: 'Describe your exact goal in one clear sentence.',
                fr: 'Décrivez votre objectif exact en une phrase claire.',
                ar: 'اشرح هدفك بدقة في جملة واضحة واحدة.',
            });

            customModeRecorder.ondataavailable = (evt) => {
                if (evt.data.size > 0) customModeChunks.push(evt.data);
            };
            customModeRecorder.onstop = async () => {
                customModeRecording = false;
                customModeRecordBtn.classList.remove('recording');
                customModeRecordBtn.textContent = getCustomRecordButtonIdleText();
                const audioBlob = new Blob(customModeChunks, { type: selectedAudioMime });
                customModeChunks = [];
                await sendCustomModeAudio(audioBlob);
            };

            customModeRecorder.start();
        } catch (err) {
            console.error('Custom mode record start error:', err);
            customModeRecording = false;
            customModeStatus.textContent = tByLang({
                en: 'Microphone access is required for custom mode.',
                fr: 'Accès micro requis pour le mode personnalisé.',
                ar: 'إذن الميكروفون مطلوب للوضع المخصص.',
            });
        }
    })();
}

function stopCustomModeRecording(e) {
    if (e) e.preventDefault();
    if (!customModeRecording || !customModeRecorder) return;
    if (customModeRecorder.state === 'recording') {
        customModeRecorder.stop();
    }
}

async function sendCustomModeAudio(blob) {
    if (!blob || blob.size === 0) return;
    customModeStatus.textContent = tByLang({
        en: 'Optimizing your custom mode...',
        fr: 'Optimisation de votre mode personnalisé...',
        ar: 'جارٍ تحسين وضعك المخصص...',
    });

    try {
        const formData = new FormData();
        formData.append('audio', blob, 'custom-mode.webm');
        formData.append('lang', selectedLang);

        const response = await fetch(`${API_BASE}/api/customize-mode`, {
            method: 'POST',
            body: formData,
        });

        if (!response.ok) throw new Error(`Server error: ${response.status}`);
        const data = await response.json();

        customModeInstruction = String(data.optimizedInstruction || '').trim();
        customModeRawIntent = String(data.rawUserIntent || '').trim();
        customModeShortLabel = String(data.shortLabel || '').trim();
        if (!customModeInstruction) throw new Error('Empty optimized instruction');

        updateModeBadge();
        updateCustomModeUI();
        speak(tByLang({
            en: 'Custom mode saved.',
            fr: 'Mode personnalisé enregistré.',
            ar: 'تم حفظ الوضع المخصص.',
        }));
    } catch (err) {
        console.error('Custom mode API error:', err);
        customModeStatus.textContent = tByLang({
            en: 'Could not build custom mode. Please try again.',
            fr: 'Impossible de créer le mode personnalisé. Réessayez.',
            ar: 'تعذر إنشاء الوضع المخصص. حاول مرة أخرى.',
        });
    }
}

function setupCustomModeVoiceButton() {
    if (!customModeRecordBtn) return;
    customModeRecordBtn.addEventListener('pointerdown', startCustomModeRecording);
    customModeRecordBtn.addEventListener('pointerup', stopCustomModeRecording);
    customModeRecordBtn.addEventListener('pointerleave', stopCustomModeRecording);
    customModeRecordBtn.addEventListener('pointercancel', stopCustomModeRecording);
    customModeRecordBtn.addEventListener('contextmenu', (e) => e.preventDefault());
}

// --- Duration Selection ---
durButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        durButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        clipDurationMs = parseInt(btn.dataset.dur) * 1000;
    });
});

// --- Camera Init ---
async function initCamera() {
    try {
        statusText.textContent = 'Requesting camera...';

        mediaStream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: 'environment',
                width: { ideal: 640 },
                height: { ideal: 480 },
                frameRate: { ideal: 15, max: 20 },
            },
            audio: true, // We need audio for push-to-talk
        });

        cameraPreview.srcObject = mediaStream;
        statusText.textContent = 'Camera ready — tap START';
        statusDot.className = '';

        // Request wake lock
        requestWakeLock();
        return true;
    } catch (err) {
        console.error('Camera error:', err);
        statusText.textContent = 'Camera access denied';
        statusDot.className = 'error';
        guidanceText.textContent = 'Please allow camera + microphone access';
        return false;
    }
}

// --- Video Recording ---
function startRecording() {
    recordedChunks = [];

    const mimeTypes = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
    let selectedMime = '';
    for (const mime of mimeTypes) {
        if (MediaRecorder.isTypeSupported(mime)) {
            selectedMime = mime;
            break;
        }
    }

    if (!selectedMime) {
        guidanceText.textContent = 'Video recording not supported';
        return;
    }

    // Use only video tracks for the video recorder
    const videoStream = new MediaStream(mediaStream.getVideoTracks());

    mediaRecorder = new MediaRecorder(videoStream, {
        mimeType: selectedMime,
        videoBitsPerSecond: 500000,
    });

    mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordedChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
        if (!isRunning) return;
        if (isTalkFlowActive || isTalking) return;
        const blob = new Blob(recordedChunks, { type: selectedMime });
        recordedChunks = [];
        await analyzeClip(blob);
        if (isRunning && !isTalkFlowActive && !isTalking) {
            loopTimeout = setTimeout(() => {
                if (isRunning) startRecording();
            }, 300);
        }
    };

    mediaRecorder.start();

    setTimeout(() => {
        if (mediaRecorder && mediaRecorder.state === 'recording') {
            mediaRecorder.stop();
        }
    }, clipDurationMs);
}

// --- Analyze Video Clip ---
async function analyzeClip(blob) {
    if (isTalkFlowActive || isTalking) return;

    processingIndicator.classList.remove('hidden');
    statusDot.className = 'analyzing';
    statusText.textContent = 'Scanning...';

    currentAnalyzeController = new AbortController();
    try {
        const formData = new FormData();
        formData.append('video', blob, 'clip.webm');
        formData.append('lang', selectedLang);
        formData.append('mode', selectedMode);
        formData.append('customInstruction', customModeInstruction);
        formData.append('clipDurationSec', String(Math.round(clipDurationMs / 1000)));

        const response = await fetch(`${API_BASE}/api/analyze`, {
            method: 'POST',
            body: formData,
            signal: currentAnalyzeController.signal,
        });

        if (!response.ok) throw new Error(`Server error: ${response.status}`);

        const data = await response.json();
        if (currentScreen !== 'app') return;

        // If user started talk while analysis was running, ignore this result.
        if (isTalkFlowActive || isTalking) return;

        updateGuidance(data);
        if (data.stats) updateStats(data.stats);

        // Speak the guidance
        speak(data.guidance);

        scanNumber++;
        scanCount.textContent = scanNumber;
        statusDot.className = 'active';
        statusText.textContent = `Active — scan #${scanNumber}`;
    } catch (err) {
        if (err?.name === 'AbortError') return;
        console.error('Analysis error:', err);
        statusDot.className = 'error';
        statusText.textContent = 'Connection error';
        guidanceText.textContent = selectedLang === 'fr' ? 'Connexion perdue. Restez vigilant. Nouvelle tentative...' :
            selectedLang === 'ar' ? 'فقد الاتصال. ابقَ حذرًا. إعادة المحاولة...' :
                'Connection lost. Stay alert. Retrying...';
        guidanceTextWrapper.className = 'warning';
    } finally {
        currentAnalyzeController = null;
        processingIndicator.classList.add('hidden');
    }
}

// --- Update Guidance Display ---
function updateGuidance(data) {
    const { guidance, alertLevel } = data;

    guidanceTextWrapper.style.animation = 'none';
    guidanceTextWrapper.offsetHeight;
    guidanceTextWrapper.style.animation = 'fade-in 0.4s ease';

    guidanceText.textContent = guidance;
    guidanceTextWrapper.className = alertLevel;

    const alertIcons = { danger: '🚨', warning: '⚠️', safe: '✅', info: '👁️' };
    const alertLabels = { danger: 'DANGER', warning: 'CAUTION', safe: 'ALL CLEAR', info: 'SCANNING' };

    showAlert(alertLevel, alertIcons[alertLevel], alertLabels[alertLevel]);
    addHistoryItem(guidance, alertLevel);
}

function showAlert(level, icon, text) {
    alertBanner.className = level;
    alertIcon.textContent = icon;
    alertTextEl.textContent = text;
    alertBanner.style.animation = 'none';
    alertBanner.offsetHeight;
    alertBanner.style.animation = 'slide-down 0.3s ease';
    if (level === 'danger') alertBanner.style.animation += ', flash-danger 0.5s ease 3';
}

function addHistoryItem(text, level) {
    const item = document.createElement('div');
    item.className = `history-item ${level}`;
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    item.innerHTML = `<span class="history-time">${time}</span><span class="history-msg">${escapeHtml(text)}</span>`;
    historyList.insertBefore(item, historyList.firstChild);
    while (historyList.children.length > MAX_HISTORY_DISPLAY) {
        historyList.removeChild(historyList.lastChild);
    }
}

// --- Update Stats ---
function updateStats(stats) {
    statTokens.innerHTML = `🔢 <b>${stats.totalTokens.toLocaleString()}</b>`;
    statCost.innerHTML = `💰 <b>$${stats.totalCost.toFixed(5)}</b>`;
    statPerMin.textContent = `~$${stats.costPerMin.toFixed(4)}/min`;
    statPerHour.textContent = `~$${stats.costPerHour.toFixed(3)}/hr`;
}

function updateElapsed() {
    if (!sessionStartTime) return;
    const elapsed = Date.now() - sessionStartTime;
    const mins = Math.floor(elapsed / 60000);
    const secs = Math.floor((elapsed % 60000) / 1000);
    statElapsed.textContent = `⏱ ${mins}:${secs.toString().padStart(2, '0')}`;
}

// --- Push-to-Talk ---
function setupTalkButton() {
    // Pointer events for touch and mouse
    talkBtn.addEventListener('pointerdown', startTalking);
    talkBtn.addEventListener('pointerup', stopTalking);
    talkBtn.addEventListener('pointerleave', stopTalking);
    talkBtn.addEventListener('pointercancel', stopTalking);

    // Prevent context menu on long press
    talkBtn.addEventListener('contextmenu', (e) => e.preventDefault());
}

function startTalking(e) {
    e.preventDefault();
    if (!isRunning || isTalking) return;
    isTalkFlowActive = true;

    // 1. Immediately stop any TTS speaking
    stopSpeaking();
    if (currentAnalyzeController) {
        currentAnalyzeController.abort();
        currentAnalyzeController = null;
    }

    // 2. Pause the video recording loop
    if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop(); // onstop will check isTalking and skip next clip
    }
    if (loopTimeout) { clearTimeout(loopTimeout); loopTimeout = null; }

    isTalking = true;
    audioChunks = [];
    talkBtn.classList.add('recording');
    talkBtn.querySelector('.btn-label').textContent = '🔴 REC';

    // Show listening state
    guidanceText.textContent = selectedLang === 'fr' ? '🎤 Je vous écoute...' :
        selectedLang === 'ar' ? '🎤 أستمع إليك...' :
            '🎤 Listening...';
    guidanceTextWrapper.className = 'info';
    showAlert('info', '🎤', 'LISTENING');

    // Create audio-only stream
    const audioTracks = mediaStream.getAudioTracks();
    if (audioTracks.length === 0) {
        console.error('No audio tracks available');
        isTalking = false;
        return;
    }

    const audioStream = new MediaStream(audioTracks);

    const audioMimeTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
    let selectedAudioMime = '';
    for (const mime of audioMimeTypes) {
        if (MediaRecorder.isTypeSupported(mime)) { selectedAudioMime = mime; break; }
    }

    if (!selectedAudioMime) {
        console.error('No audio MIME type supported');
        isTalking = false;
        return;
    }

    audioRecorder = new MediaRecorder(audioStream, { mimeType: selectedAudioMime });

    audioRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunks.push(e.data);
    };

    audioRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunks, { type: selectedAudioMime });
        audioChunks = [];
        await sendTalkAudio(audioBlob);
    };

    audioRecorder.start();
}

function stopTalking(e) {
    if (!isTalking) return;
    isTalking = false;
    talkBtn.classList.remove('recording');
    talkBtn.querySelector('.btn-label').textContent = 'HOLD';

    if (audioRecorder && audioRecorder.state === 'recording') {
        audioRecorder.stop();
    }
}

async function sendTalkAudio(blob) {
    processingIndicator.classList.remove('hidden');
    statusText.textContent = selectedLang === 'fr' ? 'Analyse audio...' :
        selectedLang === 'ar' ? 'تحليل الصوت...' :
            'Processing audio...';

    try {
        const formData = new FormData();
        formData.append('audio', blob, 'talk.webm');
        formData.append('lang', selectedLang);
        formData.append('mode', selectedMode);
        formData.append('customInstruction', customModeInstruction);

        const response = await fetch(`${API_BASE}/api/talk`, {
            method: 'POST',
            body: formData,
        });

        if (!response.ok) throw new Error(`Server error: ${response.status}`);

        const data = await response.json();

        // Show what user asked (if backend returns transcript) then show reply
        const displayText = data.userText
            ? `❓ ${data.userText}\n\n💬 ${data.reply}`
            : `💬 ${data.reply}`;

        guidanceText.textContent = displayText;
        guidanceTextWrapper.className = 'info';
        guidanceTextWrapper.style.animation = 'none';
        guidanceTextWrapper.offsetHeight;
        guidanceTextWrapper.style.animation = 'fade-in 0.4s ease';
        showAlert('info', '💬', 'RESPONSE');

        // Only speak the reply, not the user's question
        speak(data.reply);

        if (data.stats) updateStats(data.stats);
        addHistoryItem(`🎤 ${data.userText || '...'} → ${data.reply}`, 'info');

    } catch (err) {
        if (currentScreen !== 'app') return;
        console.error('Talk error:', err);
        const errMsg = selectedLang === 'fr' ? 'Désolé, je n\'ai pas compris.' :
            selectedLang === 'ar' ? 'عذرًا، لم أفهم.' :
                'Sorry, I could not understand.';
        guidanceText.textContent = errMsg;
        speak(errMsg);
    } finally {
        isTalkFlowActive = false;
        processingIndicator.classList.add('hidden');
        statusText.textContent = isRunning ? `Active — scan #${scanNumber}` : 'Paused';
        // Resume video scanning loop after talk
        if (isRunning) {
            loopTimeout = setTimeout(() => startRecording(), 800);
        }
    }
}

// --- Start / Stop ---
function toggleRunning() {
    if (isRunning) stop(); else start();
}

async function start() {
    if (!mediaStream) {
        const ok = await initCamera();
        if (!ok) return;
    }

    isRunning = true;
    scanNumber = 0;
    scanCount.textContent = '0';
    sessionStartTime = Date.now();

    // Enable talk button
    talkBtn.disabled = false;

    // Start elapsed timer
    elapsedInterval = setInterval(updateElapsed, 1000);

    startBtn.classList.add('active');
    startBtn.querySelector('.btn-icon').textContent = '⏹';
    startBtn.querySelector('.btn-label').textContent = 'STOP';

    statusDot.className = 'active';
    statusText.textContent = 'Active — starting...';

    if (selectedMode === 'reading') {
        guidanceText.textContent = selectedLang === 'fr' ? 'Mode lecture activé. Montrez le texte à la caméra.' :
            selectedLang === 'ar' ? 'تم تفعيل وضع القراءة. وجّه الكاميرا نحو النص.' :
                'Reading mode enabled. Point camera to text.';
    } else if (selectedMode === 'custom') {
        guidanceText.textContent = selectedLang === 'fr'
            ? `Mode personnalisé activé. ${customModeInstruction || 'Objectif par défaut en cours.'}`
            : selectedLang === 'ar'
                ? `تم تفعيل الوضع المخصص. ${customModeInstruction || 'يتم استخدام الهدف الافتراضي.'}`
                : `Custom mode enabled. ${customModeInstruction || 'Using default custom objective.'}`;
    } else if (selectedMode === 'focus') {
        guidanceText.textContent = selectedLang === 'fr' ? 'Mode focus activé. Description détaillée en cours...' :
            selectedLang === 'ar' ? 'تم تفعيل وضع التركيز. جارٍ وصف تفصيلي...' :
                'Focus mode enabled. Detailed description in progress...';
    } else {
        guidanceText.textContent = selectedLang === 'fr' ? 'Analyse de l\'environnement...' :
            selectedLang === 'ar' ? 'جاري تحليل البيئة...' :
                'Scanning environment...';
    }
    guidanceTextWrapper.className = 'info';
    showAlert('info', '👁️', 'SCANNING STARTED');

    startRecording();
}

function stop() {
    isRunning = false;

    if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
    if (currentAnalyzeController) {
        currentAnalyzeController.abort();
        currentAnalyzeController = null;
    }
    if (loopTimeout) { clearTimeout(loopTimeout); loopTimeout = null; }
    if (elapsedInterval) { clearInterval(elapsedInterval); elapsedInterval = null; }
    if (audioRecorder && audioRecorder.state === 'recording') {
        audioRecorder.onstop = null;
        audioRecorder.stop();
    }
    isTalking = false;
    isTalkFlowActive = false;
    audioChunks = [];
    talkBtn.classList.remove('recording');
    talkBtn.querySelector('.btn-label').textContent = 'HOLD';
    processingIndicator.classList.add('hidden');

    stopSpeaking();

    talkBtn.disabled = true;

    startBtn.classList.remove('active');
    startBtn.querySelector('.btn-icon').textContent = '▶';
    startBtn.querySelector('.btn-label').textContent = 'START';

    statusDot.className = '';
    statusText.textContent = 'Paused';

    guidanceText.textContent = selectedLang === 'fr' ? 'Guidage en pause — appuyez START pour reprendre' :
        selectedLang === 'ar' ? 'التوجيه متوقف — اضغط START للاستئناف' :
            'Guidance paused — tap START to resume';
    guidanceTextWrapper.className = '';
    alertBanner.className = 'hidden';
}

// --- Clear History ---
async function clearHistory() {
    historyList.innerHTML = '';
    try {
        await fetch(`${API_BASE}/api/reset`, { method: 'POST' });
    } catch (e) { /* ignore */ }
}

// --- Utilities ---
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

let wakeLock = null;
async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
        }
    } catch (err) {
        console.log('Wake lock not available:', err);
    }
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && isRunning) requestWakeLock();
});

function setupLongPressA11yHints() {
    const candidates = document.querySelectorAll('button[data-a11y-hint]');
    candidates.forEach((btn) => {
        if (btn.id === 'talk-btn' || btn.id === 'custom-mode-record-btn') return;
        let hintTimer = null;
        let hintWasSpoken = false;

        const clearHintTimer = () => {
            if (hintTimer) {
                clearTimeout(hintTimer);
                hintTimer = null;
            }
        };

        btn.addEventListener('pointerdown', () => {
            hintWasSpoken = false;
            clearHintTimer();
            hintTimer = setTimeout(() => {
                const hint = btn.dataset.a11yHint || btn.getAttribute('aria-label');
                if (hint) {
                    speak(hint);
                    hintWasSpoken = true;
                }
            }, LONG_PRESS_HINT_MS);
        });

        ['pointerup', 'pointerleave', 'pointercancel'].forEach((eventName) => {
            btn.addEventListener(eventName, clearHintTimer);
        });

        btn.addEventListener('click', (e) => {
            if (hintWasSpoken) {
                e.preventDefault();
                e.stopPropagation();
                hintWasSpoken = false;
            }
        });
    });
}

// --- Event Listeners ---
startBtn.addEventListener('click', () => { unlockAudio(); toggleRunning(); });
clearHistoryBtn.addEventListener('click', clearHistory);
if (navBackBtn) {
    navBackBtn.addEventListener('click', () => {
        stopSpeaking();
        navigateBack();
    });
}
setupTalkButton();
setupCustomModeVoiceButton();
setupLongPressA11yHints();

// --- Voice Toggle ---
function updateVoiceToggleUI() {
    const icon = voiceToggleBtn.querySelector('.btn-icon');
    if (voiceEnabled) {
        icon.textContent = '🔊';
        voiceToggleBtn.classList.remove('muted');
        voiceToggleBtn.title = 'Voice ON — tap to mute';
    } else {
        icon.textContent = '🔇';
        voiceToggleBtn.classList.add('muted');
        voiceToggleBtn.title = 'Voice OFF — tap to enable';
        stopSpeaking();
    }
}

voiceToggleBtn.addEventListener('click', () => {
    voiceEnabled = !voiceEnabled;
    updateVoiceToggleUI();
});

// Init voice toggle UI (default: ON)
updateVoiceToggleUI();
updateModeBadge();
updateCustomModeUI();
