import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import fs from 'fs';
import https from 'https';
import { loadModel, completion } from '@qvac/sdk';

const app = express();
app.use(cors());
app.use(express.json());

// System state
let llmModelId = null;
let ttsModelId = null;
let systemStatus = 'uninitialized'; // 'uninitialized' | 'loading' | 'ready' | 'error'
let systemErrorMessage = '';

// Conversation Memory
let conversationHistory = [
    { role: "system", content: "You are Jarvis, a highly advanced AI assistant. Keep answers concise, short, intelligent and well-formatted using markdown lists or bold text where appropriate." }
];

// Audio Cache
const ttsAudioCache = new Map();

// Model file paths
const LLM_PATH = "./models/qwen2.5-7b-instruct-q4_k_m.gguf";
const TTS_PATH = "./models/supertonic-turbo.gguf";

// Download Status Tracker
const downloadStatus = {
    llm: { total: 0, downloaded: 0, percent: 0, active: false, error: null },
    tts: { total: 0, downloaded: 0, percent: 0, active: false, error: null }
};

function checkModelsExist() {
    return {
        llmExists: fs.existsSync(LLM_PATH),
        ttsExists: fs.existsSync(TTS_PATH)
    };
}

async function initJarvisMinds() {
    const { llmExists, ttsExists } = checkModelsExist();
    if (!llmExists || !ttsExists) {
        systemStatus = 'uninitialized';
        console.log("⚠️ Models not found. Waiting for downloads via UI...");
        return;
    }

    systemStatus = 'loading';
    systemErrorMessage = '';
    llmModelId = null;
    ttsModelId = null;

    try {
        console.log("🔄 Loading Qwen-7B LLM Model on CPU...");
        llmModelId = await loadModel({
            modelSrc: LLM_PATH,
            modelType: "llm",
            modelConfig: { ctx_size: 2048 }
        });
        console.log(`✅ LLM Connected. ID: ${llmModelId}`);

        // Load TTS model (if supertonic GGUF is available)
        if (fs.existsSync(TTS_PATH)) {
            console.log("🔄 Loading TTS Model on CPU...");
            ttsModelId = await loadModel({
                modelSrc: TTS_PATH,
                modelType: "tts"
            });
            console.log(`✅ TTS Engine Armed. ID: ${ttsModelId}`);
        }

        systemStatus = 'ready';
        console.log("🚀 Jarvis is fully operational!");
    } catch (error) {
        console.error("❌ Error loading models:", error);
        systemStatus = 'error';
        systemErrorMessage = error.message || "Failed to load models.";
    }
}

// Auto-initialize if models already exist
initJarvisMinds();

// --- Download helpers with redirect support ---
function followRedirectsAndDownload(url, dest, type, onSuccess, onError) {
    const request = https.get(url, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            return followRedirectsAndDownload(response.headers.location, dest, type, onSuccess, onError);
        }
        if (response.statusCode !== 200) {
            onError(new Error(`Server responded with status ${response.statusCode}`));
            return;
        }

        const totalBytes = parseInt(response.headers['content-length'], 10) || 0;
        downloadStatus[type].total = totalBytes;

        let downloadedBytes = 0;
        const fileStream = fs.createWriteStream(dest);

        response.on('data', (chunk) => {
            downloadedBytes += chunk.length;
            fileStream.write(chunk);
            downloadStatus[type].downloaded = downloadedBytes;
            downloadStatus[type].percent = totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0;
        });

        response.on('end', () => {
            fileStream.end();
            onSuccess();
        });

        fileStream.on('error', (err) => {
            fileStream.end();
            fs.unlink(dest, () => {});
            onError(err);
        });
    });

    request.on('error', (err) => {
        onError(err);
    });
}

// --- API ENDPOINTS ---

// System status
app.get('/api/system/status', (req, res) => {
    const { llmExists, ttsExists } = checkModelsExist();
    res.json({
        status: systemStatus,
        error: systemErrorMessage,
        llmExists,
        ttsExists,
        historyCount: conversationHistory.length - 1
    });
});

// Start model download
app.post('/api/download', (req, res) => {
    const { type, url } = req.body;

    if (type !== 'llm' && type !== 'tts') {
        return res.status(400).json({ error: "Invalid model type. Use 'llm' or 'tts'." });
    }
    if (!url) {
        return res.status(400).json({ error: "Download URL is required." });
    }
    if (downloadStatus[type].active) {
        return res.status(400).json({ error: "Download already in progress." });
    }

    fs.mkdirSync('./models', { recursive: true });
    const destPath = type === 'llm' ? LLM_PATH : TTS_PATH;

    downloadStatus[type] = { total: 0, downloaded: 0, percent: 0, active: true, error: null };

    console.log(`⬇️ Starting ${type} model download from ${url}...`);

    followRedirectsAndDownload(
        url,
        destPath,
        type,
        () => {
            downloadStatus[type].active = false;
            downloadStatus[type].percent = 100;
            console.log(`✅ ${type} model downloaded!`);
        },
        (err) => {
            downloadStatus[type].active = false;
            downloadStatus[type].error = err.message;
            console.error(`❌ ${type} download error:`, err);
            if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
        }
    );

    res.json({ message: "Download started." });
});

// Download progress
app.get('/api/download/status', (req, res) => {
    res.json(downloadStatus);
});

// Initialize models after download
app.post('/api/init-models', async (req, res) => {
    if (systemStatus === 'ready') {
        return res.json({ message: "System already initialized." });
    }
    initJarvisMinds();
    res.json({ message: "Initialization started." });
});

// Main Jarvis chat endpoint
app.post('/api/jarvis', async (req, res) => {
    const { prompt } = req.body;

    if (systemStatus !== 'ready') {
        return res.status(503).json({
            error: "Jarvis is not ready yet. Please wait for models to load.",
            status: systemStatus
        });
    }

    try {
        conversationHistory.push({ role: "user", content: prompt });

        // Keep only last 10 messages + system prompt
        if (conversationHistory.length > 12) {
            conversationHistory = [conversationHistory[0], ...conversationHistory.slice(-10)];
        }

        // LLM inference
        const llmResponse = await completion({
            model: llmModelId,
            prompt: conversationHistory,
            temperature: 0.6
        });

        const jarvisTextReply = llmResponse.text || "Execution failed.";
        conversationHistory.push({ role: "assistant", content: jarvisTextReply });

        // TTS with caching
        const textHash = crypto.createHash('md5').update(jarvisTextReply).digest('hex');
        let audioBase64 = "";

        if (ttsModelId) {
            if (ttsAudioCache.has(textHash)) {
                console.log("🎯 TTS Cache Hit!");
                audioBase64 = ttsAudioCache.get(textHash);
            } else {
                console.log("⚡ Generating TTS audio...");
                const ttsResponse = await completion({
                    model: ttsModelId,
                    prompt: jarvisTextReply
                });
                if (ttsResponse.audio) {
                    audioBase64 = Buffer.from(ttsResponse.audio).toString('base64');
                    ttsAudioCache.set(textHash, audioBase64);
                }
            }
        }

        res.json({
            text: jarvisTextReply,
            audio: audioBase64 ? `data:audio/wav;base64,${audioBase64}` : null
        });

    } catch (error) {
        console.error("Jarvis Core Error:", error);
        res.status(500).json({ error: "Processing error occurred." });
    }
});

app.listen(8000, () => console.log('🚀 Jarvis AI Core Backend running on port 8000'));
