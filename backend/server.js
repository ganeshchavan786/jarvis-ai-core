import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import https from 'https';
import { loadModel, completion, QvacSDK } from '@qvac/sdk';

const app = express();
app.use(cors());
app.use(express.json());

const qvac = new QvacSDK();
let llmModelId = null;
let ttsModelInstance = null;

// System state
let systemStatus = 'uninitialized'; // 'uninitialized' | 'loading' | 'ready' | 'error'
let systemErrorMessage = '';

// Conversion memory
let conversationHistory = [
    { role: "system", content: "You are Jarvis, a highly advanced AI assistant. Keep answers concise, short, intelligent and well-formatted using markdown lists or bold text where appropriate." }
];

// Audio Cache
const ttsAudioCache = new Map();

// Download Status Tracker
const downloadStatus = {
    llm: { total: 0, downloaded: 0, percent: 0, active: false, error: null },
    tts: { total: 0, downloaded: 0, percent: 0, active: false, error: null }
};

// Check if models exist on disk
const LLM_PATH = "./models/qwen2.5-7b-instruct-q4_k_m.gguf";
const TTS_PATH = "./models/supertonic-turbo.gguf";

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
        console.log("⚠️ Models not found. System waiting for model downloads...");
        return;
    }

    systemStatus = 'loading';
    systemErrorMessage = '';
    console.log("🔄 Initializing Jarvis Core Protocols...");
    
    try {
        console.log("🔄 Loading Qwen-7B-Instruct LLM Model on CPU...");
        llmModelId = await loadModel({
            modelSrc: LLM_PATH, 
            modelType: "llm",
            modelConfig: { ctx_size: 2048 }
        });
        console.log(`✅ Qwen-7B Connected. ID: ${llmModelId}`);

        console.log("🔄 Loading QVAC Supertonic TTS Model on CPU...");
        ttsModelInstance = await qvac.models.load({
            modelType: "tts",
            modelPath: TTS_PATH
        });
        console.log("✅ QVAC TTS Engine Armed.");
        
        systemStatus = 'ready';
    } catch (error) {
        console.error("❌ Error loading system components:", error);
        systemStatus = 'error';
        systemErrorMessage = error.message || "Failed to load GGUF models on CPU.";
    }
}

// Auto-run init on startup in case models are already present
initJarvisMinds();

// Download helper with redirect tracking and stream piping
function followRedirectsAndDownload(url, dest, type, onSuccess, onError) {
    const request = https.get(url, (response) => {
        // Follow Redirects (301, 302, 307, 308)
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            return followRedirectsAndDownload(response.headers.location, dest, type, onSuccess, onError);
        }
        
        if (response.statusCode !== 200) {
            onError(new Error(`Server responded with status code ${response.statusCode}`));
            return;
        }

        const totalBytes = parseInt(response.headers['content-length'], 10) || 0;
        downloadStatus[type].total = totalBytes;
        
        let downloadedBytes = 0;
        const fileStream = fs.createWriteStream(dest);

        response.on('data', (chunk) => {
            downloadedBytes += chunk.length;
            fileStream.write(chunk);
            
            // Update download progress
            downloadStatus[type].downloaded = downloadedBytes;
            downloadStatus[type].percent = totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0;
        });

        response.on('end', () => {
            fileStream.end();
            onSuccess();
        });

        fileStream.on('error', (err) => {
            fileStream.end();
            fs.unlink(dest, () => {}); // clean up partial file
            onError(err);
        });
    });

    request.on('error', (err) => {
        onError(err);
    });
}

// --- API ENDPOINTS ---

// Check overall system status
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

// Trigger download for a model
app.post('/api/download', (req, res) => {
    const { type, url } = req.body; // type: 'llm' | 'tts'

    if (type !== 'llm' && type !== 'tts') {
        return res.status(400).json({ error: "Invalid model type. Use 'llm' or 'tts'." });
    }
    if (!url) {
        return res.status(400).json({ error: "Download URL is required." });
    }
    if (downloadStatus[type].active) {
        return res.status(400).json({ error: "Download is already in progress for this model." });
    }

    // Ensure models directory exists
    fs.mkdirSync('./models', { recursive: true });

    const destPath = type === 'llm' ? LLM_PATH : TTS_PATH;

    // Reset status
    downloadStatus[type] = {
        total: 0,
        downloaded: 0,
        percent: 0,
        active: true,
        error: null
    };

    console.log(`⚡ Started downloading ${type} model from ${url}...`);

    // Download in background (do not block Express response)
    followRedirectsAndDownload(
        url,
        destPath,
        type,
        () => {
            downloadStatus[type].active = false;
            downloadStatus[type].percent = 100;
            console.log(`✅ ${type} model downloaded successfully!`);
        },
        (err) => {
            downloadStatus[type].active = false;
            downloadStatus[type].error = err.message;
            console.error(`❌ Error downloading ${type} model:`, err);
            // Clean up file if exists
            if (fs.existsSync(destPath)) {
                fs.unlinkSync(destPath);
            }
        }
    );

    res.json({ message: "Download started in background." });
});

// Get download progress status
app.get('/api/download/status', (req, res) => {
    res.json(downloadStatus);
});

// Initialize models once downloaded
app.post('/api/init-models', async (req, res) => {
    if (systemStatus === 'ready') {
        return res.json({ message: "System is already initialized." });
    }
    
    // Run async so we don't timeout the HTTP response
    initJarvisMinds();
    res.json({ message: "Initialization protocol started." });
});

// Main chatbot query endpoint
app.post('/api/jarvis', async (req, res) => {
    const { prompt } = req.body;

    if (systemStatus !== 'ready') {
        return res.status(503).json({ 
            error: "सिस्टम अद्याप लोड होत आहे किंवा मॉडेल इन्स्टॉल केलेले नाही.",
            status: systemStatus
        });
    }

    try {
        conversationHistory.push({ role: "user", content: prompt });

        // Keep memory under control (system prompt + last 10 messages)
        if (conversationHistory.length > 12) {
            conversationHistory = [conversationHistory[0], ...conversationHistory.slice(-10)];
        }

        // LLM Completion
        const llmResponse = await completion({
            model: llmModelId,
            prompt: conversationHistory,
            temperature: 0.6
        });

        const jarvisTextReply = llmResponse.text || "Execution failed.";
        conversationHistory.push({ role: "assistant", content: jarvisTextReply });

        // Audio Caching
        const textHash = crypto.createHash('md5').update(jarvisTextReply).digest('hex');
        let audioBase64 = "";

        if (ttsAudioCache.has(textHash)) {
            console.log("🎯 TTS Cache Hit! Reusing cached audio.");
            audioBase64 = ttsAudioCache.get(textHash);
        } else {
            console.log("⚡ Generating fresh QVAC TTS audio...");
            const ttsResponse = await qvac.ai.textToSpeech({
                model: ttsModelInstance,
                inputType: "text",
                input: jarvisTextReply,
                streaming: false
            });

            audioBase64 = ttsResponse.buffer.toString('base64');
            ttsAudioCache.set(textHash, audioBase64);
        }

        res.json({
            text: jarvisTextReply,
            audio: `data:audio/wav;base64,${audioBase64}`
        });

    } catch (error) {
        console.error("Jarvis Core Error:", error);
        res.status(500).json({ error: "सिस्टम प्रोसेसिंगमध्ये एरर आला आहे." });
    }
});

app.listen(8000, () => console.log('🚀 Jarvis AI Core Backend running on port 8000'));
