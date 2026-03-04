/**
 * Test script for /api/analyze structured JSON output.
 * Tests that the endpoint returns { shouldRespond, alertLevel, guidance }
 * and validates the schema correctness.
 * 
 * Usage: node test-analyze.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const API_BASE = process.env.API_BASE || 'http://localhost:3005';

const TEST_VIDEO_PATH = path.join(__dirname, 'uploads', '_test_clip.webm');

// Generate a valid 1-second webm video using ffmpeg (black screen)
function ensureTestVideo() {
    if (!fs.existsSync(path.join(__dirname, 'uploads'))) {
        fs.mkdirSync(path.join(__dirname, 'uploads'));
    }
    if (!fs.existsSync(TEST_VIDEO_PATH)) {
        execSync(
            `ffmpeg -y -f lavfi -i color=c=gray:s=320x240:d=1 -c:v libvpx -b:v 100k -an "${TEST_VIDEO_PATH}"`,
            { stdio: 'ignore' }
        );
    }
    return TEST_VIDEO_PATH;
}

const VALID_ALERT_LEVELS = ['danger', 'warning', 'safe', 'info'];

async function testAnalyze(label, formFields) {
    console.log(`\n--- TEST: ${label} ---`);
    const videoPath = ensureTestVideo();

    try {
        const formData = new FormData();
        const videoBlob = new Blob([fs.readFileSync(videoPath)], { type: 'video/webm' });
        formData.append('video', videoBlob, 'clip.webm');
        for (const [key, value] of Object.entries(formFields)) {
            formData.append(key, value);
        }

        const res = await fetch(`${API_BASE}/api/analyze`, {
            method: 'POST',
            body: formData,
        });

        if (!res.ok) {
            const errBody = await res.text();
            console.error(`  ❌ HTTP ${res.status}: ${errBody}`);
            return false;
        }

        const data = await res.json();
        console.log('  Response:', JSON.stringify(data, null, 2).slice(0, 500));

        // Validate schema
        let pass = true;

        if (typeof data.shouldRespond !== 'boolean') {
            console.error(`  ❌ shouldRespond is not boolean: ${typeof data.shouldRespond}`);
            pass = false;
        } else {
            console.log(`  ✅ shouldRespond = ${data.shouldRespond}`);
        }

        if (!VALID_ALERT_LEVELS.includes(data.alertLevel)) {
            console.error(`  ❌ alertLevel invalid: "${data.alertLevel}"`);
            pass = false;
        } else {
            console.log(`  ✅ alertLevel = "${data.alertLevel}"`);
        }

        if (typeof data.guidance !== 'string') {
            console.error(`  ❌ guidance is not string: ${typeof data.guidance}`);
            pass = false;
        } else {
            console.log(`  ✅ guidance = "${data.guidance.slice(0, 100)}${data.guidance.length > 100 ? '...' : ''}"`);
        }

        if (data.shouldRespond === false && data.guidance !== '') {
            console.warn(`  ⚠️  shouldRespond=false but guidance is not empty (model may not perfectly respect this)`);
        }

        if (typeof data.processingTimeMs !== 'number') {
            console.error(`  ❌ processingTimeMs missing`);
            pass = false;
        } else {
            console.log(`  ✅ processingTimeMs = ${data.processingTimeMs}ms`);
        }

        if (!data.stats || typeof data.stats.totalCost !== 'number') {
            console.error(`  ❌ stats missing or malformed`);
            pass = false;
        } else {
            console.log(`  ✅ stats.totalCost = $${data.stats.totalCost.toFixed(6)}`);
        }

        console.log(`  ${pass ? '✅ PASS' : '❌ FAIL'}`);
        return pass;

    } catch (err) {
        console.error(`  ❌ Error: ${err.message}`);
        return false;
    } finally {
        // Keep test video for reuse across tests
    }
}

async function testHealthEndpoint() {
    console.log('\n--- TEST: Health Check ---');
    try {
        const res = await fetch(`${API_BASE}/api/health`);
        const data = await res.json();
        if (data.status === 'ok' && data.model) {
            console.log(`  ✅ Server healthy, model: ${data.model}`);
            return true;
        }
        console.error(`  ❌ Unexpected response:`, data);
        return false;
    } catch (err) {
        console.error(`  ❌ Server not reachable: ${err.message}`);
        return false;
    }
}

async function runAllTests() {
    console.log('=== Blind Guidance - Structured Output Tests ===');
    console.log(`API: ${API_BASE}\n`);

    const results = [];

    // 1. Health check
    results.push(await testHealthEndpoint());

    // 2. Reset context first
    try {
        await fetch(`${API_BASE}/api/reset`, { method: 'POST' });
        console.log('\n  🔄 Context reset');
    } catch (_) {}

    // 3. Navigation mode (first scan - should always respond)
    results.push(await testAnalyze('Navigation EN (first scan)', {
        lang: 'en',
        mode: 'navigation',
        clipDurationSec: '4',
    }));

    // 4. Navigation mode (second scan - may or may not respond)
    results.push(await testAnalyze('Navigation EN (second scan)', {
        lang: 'en',
        mode: 'navigation',
        clipDurationSec: '4',
    }));

    // 5. Reading mode
    await fetch(`${API_BASE}/api/reset`, { method: 'POST' });
    results.push(await testAnalyze('Reading FR (first scan)', {
        lang: 'fr',
        mode: 'reading',
        clipDurationSec: '4',
    }));

    // 6. Focus mode
    await fetch(`${API_BASE}/api/reset`, { method: 'POST' });
    results.push(await testAnalyze('Focus AR (first scan)', {
        lang: 'ar',
        mode: 'focus',
        clipDurationSec: '2',
    }));

    // 7. Custom mode
    await fetch(`${API_BASE}/api/reset`, { method: 'POST' });
    results.push(await testAnalyze('Custom EN (with instruction)', {
        lang: 'en',
        mode: 'custom',
        clipDurationSec: '4',
        customInstruction: 'Tell me if there is a coffee cup on the table',
    }));

    // Summary
    const passed = results.filter(Boolean).length;
    const total = results.length;
    console.log(`\n=== RESULTS: ${passed}/${total} passed ===`);
    if (passed === total) {
        console.log('🎉 All tests passed!');
    } else {
        console.log('⚠️  Some tests failed. Check output above.');
    }

    process.exit(passed === total ? 0 : 1);
}

runAllTests();
