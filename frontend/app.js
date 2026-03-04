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

if (passwordScreen) {
    const savedToken = sessionStorage.getItem('blind_auth');
    if (savedToken === 'ok') {
        passwordScreen.classList.add('hidden');
    }

    passwordSubmit.addEventListener('click', async () => {
        const pwd = passwordInput.value.trim();
        if (!pwd) return;
        unlockAudio();
        const ok = await checkPassword(pwd);
        if (ok) {
            sessionStorage.setItem('blind_auth', 'ok');
            passwordScreen.classList.add('hidden');
        } else {
            passwordError.classList.remove('hidden');
            passwordInput.value = '';
        }
    });

    passwordInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') passwordSubmit.click();
    });
}

// --- DOM Elements ---
const langScreen = document.getElementById('lang-screen');
const appScreen = document.getElementById('app');
const langButtons = document.querySelectorAll('.lang-btn');

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

function pickBestVoice(lang) {
    if (ttsVoices.length === 0) ttsVoices = window.speechSynthesis.getVoices();
    const hints = langToGoogleVoiceHint[lang] || langToGoogleVoiceHint.en;
    // Try exact voice name first (Google Neural)
    for (const hint of hints) {
        const v = ttsVoices.find(v => v.name === hint);
        if (v) return v;
    }
    // Try partial name match (e.g. "Google" in name + lang prefix)
    const langPrefix = lang === 'ar' ? 'ar' : lang === 'fr' ? 'fr' : 'en';
    const googleVoice = ttsVoices.find(v =>
        v.name.toLowerCase().includes('google') && v.lang.startsWith(langPrefix)
    );
    if (googleVoice) return googleVoice;
    // Fallback: any voice for that language
    return ttsVoices.find(v => v.lang.startsWith(langPrefix)) || null;
}

function speak(text) {
    if (!voiceEnabled || !text) return;
    stopSpeaking();

    const voice = pickBestVoice(selectedLang);

    // Prefer browser SpeechSynthesis if we found a Google voice (neural)
    if (voice && voice.name.toLowerCase().includes('google')) {
        const utt = new SpeechSynthesisUtterance(text);
        utt.voice = voice;
        utt.rate = 1.05;
        utt.pitch = 1.0;
        utt.volume = 1;
        window.speechSynthesis.speak(utt);
        return;
    }

    // ResponsiveVoice as second option
    if (typeof responsiveVoice !== 'undefined') {
        const rvVoice = langToRVVoice[selectedLang] || 'UK English Female';
        responsiveVoice.speak(text, rvVoice, { rate: 1, pitch: 1, volume: 1 });
        return;
    }

    // Last resort: raw browser voice
    const utt = new SpeechSynthesisUtterance(text);
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

// --- Language Selection ---
langButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        selectedLang = btn.dataset.lang;
        unlockAudio();
        langScreen.classList.add('hidden');
        appScreen.classList.remove('hidden');
        initCamera();
    });
});

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
        const blob = new Blob(recordedChunks, { type: selectedMime });
        recordedChunks = [];
        await analyzeClip(blob);
        if (isRunning) {
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
    processingIndicator.classList.remove('hidden');
    statusDot.className = 'analyzing';
    statusText.textContent = 'Scanning...';

    try {
        const formData = new FormData();
        formData.append('video', blob, 'clip.webm');
        formData.append('lang', selectedLang);

        const response = await fetch(`${API_BASE}/api/analyze`, {
            method: 'POST',
            body: formData,
        });

        if (!response.ok) throw new Error(`Server error: ${response.status}`);

        const data = await response.json();

        updateGuidance(data);
        if (data.stats) updateStats(data.stats);

        // Speak the guidance
        speak(data.guidance);

        scanNumber++;
        scanCount.textContent = scanNumber;
        statusDot.className = 'active';
        statusText.textContent = `Active — scan #${scanNumber}`;
    } catch (err) {
        console.error('Analysis error:', err);
        statusDot.className = 'error';
        statusText.textContent = 'Connection error';
        guidanceText.textContent = selectedLang === 'fr' ? 'Connexion perdue. Restez vigilant. Nouvelle tentative...' :
            selectedLang === 'ar' ? 'فقد الاتصال. ابقَ حذرًا. إعادة المحاولة...' :
                'Connection lost. Stay alert. Retrying...';
        guidanceTextWrapper.className = 'warning';
    } finally {
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

    // 1. Immediately stop any TTS speaking
    stopSpeaking();

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
        console.error('Talk error:', err);
        const errMsg = selectedLang === 'fr' ? 'Désolé, je n\'ai pas compris.' :
            selectedLang === 'ar' ? 'عذرًا، لم أفهم.' :
                'Sorry, I could not understand.';
        guidanceText.textContent = errMsg;
        speak(errMsg);
    } finally {
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

    guidanceText.textContent = selectedLang === 'fr' ? 'Analyse de l\'environnement...' :
        selectedLang === 'ar' ? 'جاري تحليل البيئة...' :
            'Scanning environment...';
    guidanceTextWrapper.className = 'info';
    showAlert('info', '👁️', 'SCANNING STARTED');

    startRecording();
}

function stop() {
    isRunning = false;

    if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
    if (loopTimeout) { clearTimeout(loopTimeout); loopTimeout = null; }
    if (elapsedInterval) { clearInterval(elapsedInterval); elapsedInterval = null; }

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

// --- Event Listeners ---
startBtn.addEventListener('click', () => { unlockAudio(); toggleRunning(); });
clearHistoryBtn.addEventListener('click', clearHistory);
setupTalkButton();

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
