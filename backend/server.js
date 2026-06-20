import express from 'express';
import cors from 'cors';
import fs from 'fs';
import https from 'https';
import { getLlama, LlamaChatSession } from 'node-llama-cpp';

const app = express();
app.use(cors());
app.use(express.json());

// Model Paths
const LLM_PATH = "./models/qwen2.5-7b-instruct-q4_k_m.gguf";
const TTS_PATH = "./models/supertonic-turbo.gguf";

// Engine instances
let llama = null;
let model = null;
let context = null;
let chatSession = null;

// System State
let systemStatus = 'uninitialized';
let systemErrorMessage = '';

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
    const { llmExists } = checkModelsExist();
    if (!llmExists) {
        systemStatus = 'uninitialized';
        console.log("⚠️ LLM Model not found. Waiting for download via UI...");
        return;
    }

    systemStatus = 'loading';
    systemErrorMessage = '';

    try {
        console.log("🔄 Initializing llama.cpp engine...");
        llama = await getLlama();

        console.log("🔄 Loading Qwen-7B model on CPU (this takes 1-2 min)...");
        model = await llama.loadModel({ modelPath: LLM_PATH });

        console.log("✅ Model loaded! Creating context...");
        context = await model.createContext({ contextSize: 2048 });

        chatSession = new LlamaChatSession({
            contextSequence: context.getSequence(),
            systemPrompt: "You are Jarvis, a highly advanced AI assistant. Keep answers concise, intelligent, and well-formatted. Use markdown for lists and bold text where appropriate."
        });

        systemStatus = 'ready';
        console.log("🚀 Jarvis is fully operational!");
    } catch (error) {
        console.error("❌ Error loading model:", error);
        systemStatus = 'error';
        systemErrorMessage = error.message || "Failed to load model.";
    }
}

// Auto-initialize on startup
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
            downloadStatus[type].percent = totalBytes > 0
                ? Math.round((downloadedBytes / totalBytes) * 100) : 0;
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

    request.on('error', (err) => onError(err));
}

// --- API ENDPOINTS ---

// System status
app.get('/api/system/status', (req, res) => {
    const { llmExists, ttsExists } = checkModelsExist();
    res.json({
        status: systemStatus,
        error: systemErrorMessage,
        llmExists,
        ttsExists
    });
});

// Start model download
app.post('/api/download', (req, res) => {
    const { type, url } = req.body;
    if (type !== 'llm' && type !== 'tts') {
        return res.status(400).json({ error: "Invalid type. Use 'llm' or 'tts'." });
    }
    if (!url) return res.status(400).json({ error: "Download URL required." });
    if (downloadStatus[type].active) return res.status(400).json({ error: "Download already in progress." });

    fs.mkdirSync('./models', { recursive: true });
    const destPath = type === 'llm' ? LLM_PATH : TTS_PATH;

    downloadStatus[type] = { total: 0, downloaded: 0, percent: 0, active: true, error: null };

    console.log(`⬇️ Starting ${type.toUpperCase()} download from: ${url}`);

    followRedirectsAndDownload(url, destPath, type,
        () => {
            downloadStatus[type].active = false;
            downloadStatus[type].percent = 100;
            console.log(`✅ ${type.toUpperCase()} model downloaded!`);
        },
        (err) => {
            downloadStatus[type].active = false;
            downloadStatus[type].error = err.message;
            console.error(`❌ ${type.toUpperCase()} download error:`, err.message);
            if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
        }
    );

    res.json({ message: "Download started." });
});

// Download progress
app.get('/api/download/status', (req, res) => {
    res.json(downloadStatus);
});

// Initialize models
app.post('/api/init-models', async (req, res) => {
    if (systemStatus === 'ready') {
        return res.json({ message: "Already initialized." });
    }
    if (systemStatus === 'loading') {
        return res.json({ message: "Loading in progress..." });
    }
    res.json({ message: "Initialization started." });
    initJarvisMinds(); // Run async in background
});

// Reset chat session
app.post('/api/reset-chat', async (req, res) => {
    try {
        if (model && context) {
            await context.dispose();
            context = await model.createContext({ contextSize: 2048 });
            chatSession = new LlamaChatSession({
                contextSequence: context.getSequence(),
                systemPrompt: "You are Jarvis, a highly advanced AI assistant. Keep answers concise, intelligent, and well-formatted."
            });
        }
        res.json({ message: "Chat reset." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Main Jarvis chat
app.post('/api/jarvis', async (req, res) => {
    const { prompt } = req.body;

    if (systemStatus !== 'ready') {
        return res.status(503).json({
            error: "Jarvis is not ready. Status: " + systemStatus,
            status: systemStatus
        });
    }

    if (!prompt || !prompt.trim()) {
        return res.status(400).json({ error: "Empty prompt." });
    }

    try {
        console.log(`💬 User: ${prompt}`);
        const responseText = await chatSession.prompt(prompt);
        console.log(`🤖 Jarvis: ${responseText.substring(0, 100)}...`);
        res.json({ text: responseText, audio: null });
    } catch (error) {
        console.error("Jarvis inference error:", error);
        res.status(500).json({ error: "Processing error: " + error.message });
    }
});

app.listen(8000, () => console.log('🚀 Jarvis AI Core Backend running on port 8000'));
