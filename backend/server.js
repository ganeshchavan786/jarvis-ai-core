import express from 'express';
import cors from 'cors';
import fs from 'fs';
import https from 'https';
import os from 'os';
import path from 'path';
import { spawn, exec } from 'child_process';
import util from 'util';
import { getLlama, LlamaChatSession, defineChatSessionFunction } from 'node-llama-cpp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const execPromise = util.promisify(exec);

const app = express();
app.use(cors());
app.use(express.json());

// Model Paths
const LLM_PATH = "./models/qwen2.5-7b-instruct-q4_k_m.gguf";
const TTS_PATH = "./models/supertonic-turbo.gguf";
const PIPER_VOICE_PATH = "./tts_voices/en_US-amy-medium.onnx";

// Engine instances
let llama = null;
let model = null;
let context = null;
let chatSession = null;

// System State
let systemStatus = 'uninitialized';
let systemErrorMessage = '';

// MCP State
let mcpClients = {};
let mcpTools = {};
let allRegisteredTools = {};

// TTS availability
const piperAvailable = fs.existsSync(PIPER_VOICE_PATH);
if (piperAvailable) {
    console.log("🎤 Piper TTS voice model found — real voice enabled!");
} else {
    console.log("⚠️  Piper TTS voice model NOT found at", PIPER_VOICE_PATH, "— browser TTS will be used as fallback.");
}

// Download Status Tracker
const downloadStatus = {
    llm: { total: 0, downloaded: 0, percent: 0, active: false, error: null },
    tts: { total: 0, downloaded: 0, percent: 0, active: false, error: null }
};

function checkModelsExist() {
    return {
        llmExists: fs.existsSync(LLM_PATH),
        ttsExists: fs.existsSync(TTS_PATH),
        piperReady: fs.existsSync(PIPER_VOICE_PATH)
    };
}

// --- Piper TTS: Convert text to WAV audio, return base64 data URL ---
function synthesizeSpeech(text) {
    return new Promise((resolve) => {
        if (!fs.existsSync(PIPER_VOICE_PATH)) {
            return resolve(null);
        }

        // Strip markdown characters and limit length for TTS
        const cleanText = text
            .replace(/[*#`_~>]/g, '')
            .replace(/\n+/g, ' ')
            .trim()
            .substring(0, 500);

        if (!cleanText) return resolve(null);

        const tmpFile = path.join(os.tmpdir(), `jarvis_tts_${Date.now()}.wav`);

        const piper = spawn('piper', [
            '--model', PIPER_VOICE_PATH,
            '--output_file', tmpFile
        ]);

        piper.stdin.write(cleanText);
        piper.stdin.end();

        let errorMsg = '';
        piper.stderr.on('data', (data) => {
            errorMsg += data.toString();
        });

        piper.on('close', (code) => {
            if (code === 0 && fs.existsSync(tmpFile)) {
                try {
                    const audioBuffer = fs.readFileSync(tmpFile);
                    fs.unlinkSync(tmpFile);
                    const audioBase64 = 'data:audio/wav;base64,' + audioBuffer.toString('base64');
                    console.log(`🎤 TTS generated: ${audioBuffer.length} bytes`);
                    resolve(audioBase64);
                } catch (err) {
                    console.error('TTS read error:', err.message);
                    resolve(null);
                }
            } else {
                console.error('Piper TTS failed (code', code, '):', errorMsg.substring(0, 200));
                if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
                resolve(null);
            }
        });

        piper.on('error', (err) => {
            console.error('Piper spawn error:', err.message);
            resolve(null);
        });

        // Safety timeout — if piper hangs, return null after 15s
        setTimeout(() => {
            try { piper.kill(); } catch (_) {}
            if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
            resolve(null);
        }, 15000);
    });
}

// --- MCP Servers Initialization ---
async function initMcpServers() {
    const configPath = "./mcp_config.json";
    if (!fs.existsSync(configPath)) {
        console.log("ℹ️ No mcp_config.json found. Skipping MCP initialization.");
        return;
    }

    try {
        const configData = JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
        const servers = configData.mcpServers || {};

        for (const [serverName, serverConfig] of Object.entries(servers)) {
            console.log(`🔌 Connecting to MCP Server: ${serverName}...`);
            try {
                const transport = new StdioClientTransport({
                    command: serverConfig.command,
                    args: serverConfig.args || [],
                    env: { ...process.env, ...(serverConfig.env || {}) }
                });

                const client = new Client(
                    { name: "jarvis-agent", version: "2.5.0" },
                    { capabilities: {} }
                );

                await client.connect(transport);
                mcpClients[serverName] = client;
                console.log(`✅ Connected to MCP Server: ${serverName}`);

                // Fetch tools
                const toolsResponse = await client.listTools();
                console.log(`📦 Loaded ${toolsResponse.tools?.length || 0} tools from MCP Server: ${serverName}`);

                for (const tool of (toolsResponse.tools || [])) {
                    const mappedName = `mcp_${serverName}_${tool.name}`;
                    mcpTools[mappedName] = defineChatSessionFunction({
                        description: `[MCP Server: ${serverName}] ${tool.description || ''}`,
                        params: tool.inputSchema || { type: "object", properties: {} },
                        handler: async (args) => {
                            console.log(`⚙️ Executing MCP Tool [${serverName}]: ${tool.name} with args:`, args);
                            try {
                                const result = await client.callTool({
                                    name: tool.name,
                                    arguments: args
                                });
                                return result;
                            } catch (err) {
                                return { error: err.message };
                            }
                        }
                    });
                }
            } catch (err) {
                console.error(`❌ Failed to connect to MCP Server [${serverName}]:`, err.message);
            }
        }
    } catch (err) {
        console.error("❌ Error parsing mcp_config.json:", err.message);
    }
}

// --- Local Agent and Coding Tools Compilation ---
function compileAllTools() {
    allRegisteredTools = {
        // --- 🛠️ GENERAL TOOLS ---
        get_current_time: defineChatSessionFunction({
            description: "Get the current system date and time. Use this when the user asks for the date or time.",
            handler: () => new Date().toString()
        }),

        get_system_status: defineChatSessionFunction({
            description: "Get VPS server CPU, RAM and Disk usage statistics.",
            handler: async () => {
                try {
                    const freeOutput = await execPromise("free -h").then(r => r.stdout).catch(() => "Memory: N/A");
                    const uptimeOutput = await execPromise("uptime").then(r => r.stdout).catch(() => "Uptime/Load: N/A");
                    const dfOutput = await execPromise("df -h /").then(r => r.stdout).catch(() => "Disk: N/A");
                    return {
                        memory: freeOutput.trim(),
                        cpuLoad: uptimeOutput.trim(),
                        disk: dfOutput.trim()
                    };
                } catch (err) {
                    return { error: err.message };
                }
            }
        }),

        get_live_weather: defineChatSessionFunction({
            description: "Get current temperature and weather conditions for a city.",
            params: {
                type: "object",
                properties: {
                    city: { type: "string", description: "Name of the city (e.g. Pune, London)" }
                },
                required: ["city"]
            },
            handler: async ({ city }) => {
                try {
                    const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`;
                    const geoRes = await fetch(geoUrl).then(r => r.json());
                    if (!geoRes.results || geoRes.results.length === 0) {
                        return { error: `City ${city} not found.` };
                    }
                    const { latitude, longitude, name, country } = geoRes.results[0];
                    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true`;
                    const weatherRes = await fetch(weatherUrl).then(r => r.json());
                    const current = weatherRes.current_weather;
                    return {
                        city: name,
                        country,
                        temperature: `${current.temperature}°C`,
                        windspeed: `${current.windspeed} km/h`,
                        weathercode: current.weathercode,
                        time: current.time
                    };
                } catch (err) {
                    return { error: err.message };
                }
            }
        }),

        manage_notes: defineChatSessionFunction({
            description: "Save a new note/reminder or read all saved notes.",
            params: {
                type: "object",
                properties: {
                    action: { type: "string", enum: ["save", "read"], description: "Action to take: 'save' to add a note, 'read' to view all notes." },
                    content: { type: "string", description: "The content of the note. Required if action is 'save'." }
                },
                required: ["action"]
            },
            handler: async ({ action, content }) => {
                const notesFile = "./notes.txt";
                try {
                    if (action === "save") {
                        if (!content) return { error: "Content is required to save a note." };
                        const timestamp = new Date().toLocaleString();
                        await fs.promises.appendFile(notesFile, `[${timestamp}] ${content}\n`, 'utf8');
                        return { status: "success", message: "Note saved successfully." };
                    } else {
                        if (!fs.existsSync(notesFile)) return { notes: [] };
                        const data = await fs.promises.readFile(notesFile, 'utf8');
                        const notes = data.trim().split("\n").filter(Boolean);
                        return { notes };
                    }
                } catch (err) {
                    return { error: err.message };
                }
            }
        }),

        // --- 💻 CODING AGENT TOOLS ---
        write_code_file: defineChatSessionFunction({
            description: "Write code to a file in the workspace directory. Use this to create new code files or overwrite/edit existing ones.",
            params: {
                type: "object",
                properties: {
                    filename: { type: "string", description: "Name of the file (e.g. index.js, app.py)" },
                    code: { type: "string", description: "Full contents/code of the file." }
                },
                required: ["filename", "code"]
            },
            handler: async ({ filename, code }) => {
                const WORKSPACE_DIR = "./workspace";
                try {
                    const safeName = path.basename(filename);
                    const destPath = path.join(WORKSPACE_DIR, safeName);
                    await fs.promises.mkdir(WORKSPACE_DIR, { recursive: true });
                    await fs.promises.writeFile(destPath, code, 'utf8');
                    return { status: "success", message: `Successfully wrote file ${safeName} inside workspace.` };
                } catch (err) {
                    return { error: err.message };
                }
            }
        }),

        read_code_file: defineChatSessionFunction({
            description: "Read the content of a file in the workspace directory to review or edit its code.",
            params: {
                type: "object",
                properties: {
                    filename: { type: "string", description: "Name of the file to read." }
                },
                required: ["filename"]
            },
            handler: async ({ filename }) => {
                const WORKSPACE_DIR = "./workspace";
                try {
                    const safeName = path.basename(filename);
                    const filePath = path.join(WORKSPACE_DIR, safeName);
                    if (!fs.existsSync(filePath)) {
                        return { error: `File ${safeName} not found in workspace.` };
                    }
                    const content = await fs.promises.readFile(filePath, 'utf8');
                    return { filename: safeName, content };
                } catch (err) {
                    return { error: err.message };
                }
            }
        }),

        list_workspace_files: defineChatSessionFunction({
            description: "List all files and scripts currently in the workspace folder.",
            handler: async () => {
                const WORKSPACE_DIR = "./workspace";
                try {
                    if (!fs.existsSync(WORKSPACE_DIR)) return { files: [] };
                    const files = await fs.promises.readdir(WORKSPACE_DIR);
                    return { files };
                } catch (err) {
                    return { error: err.message };
                }
            }
        }),

        execute_code_command: defineChatSessionFunction({
            description: "Execute a development command (like python3, node, compilation, script execution) inside the workspace.",
            params: {
                type: "object",
                properties: {
                    command: { type: "string", description: "The exact terminal command to run (e.g. 'python3 test.py', 'node index.js')" }
                },
                required: ["command"]
            },
            handler: async ({ command }) => {
                const WORKSPACE_DIR = "./workspace";
                const blockedKeywords = ["rm -rf", "rm ", "mv ", "mkfs", "dd ", "shutdown", "reboot", ":()"];
                for (const word of blockedKeywords) {
                    if (command.toLowerCase().includes(word)) {
                        return { error: `Command blocked for safety reasons: contains '${word}'` };
                    }
                }
                try {
                    await fs.promises.mkdir(WORKSPACE_DIR, { recursive: true });
                    const { stdout, stderr } = await execPromise(command, { cwd: WORKSPACE_DIR, timeout: 15000 });
                    return { stdout, stderr };
                } catch (err) {
                    return { error: err.message, stderr: err.stderr };
                }
            }
        }),

        // Dynamically loaded MCP Tools (spread)
        ...mcpTools
    };
    console.log(`⚙️ Compiled ${Object.keys(allRegisteredTools).length} total tools for Jarvis.`);
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
            systemPrompt: "You are Jarvis, a highly advanced AI assistant. You can perform actions, write/read files, run code and use MCP servers via tools. Keep answers concise, intelligent, and well-formatted. If you run a command or call a tool, briefly explain what you did. Use markdown for lists and bold text."
        });

        systemStatus = 'ready';
        console.log("🚀 Jarvis is fully operational!");
    } catch (error) {
        console.error("❌ Error loading model:", error);
        systemStatus = 'error';
        systemErrorMessage = error.message || "Failed to load model.";
    }
}

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
    const { llmExists, ttsExists, piperReady } = checkModelsExist();
    res.json({
        status: systemStatus,
        error: systemErrorMessage,
        llmExists,
        ttsExists,
        piperReady
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
    initJarvisMinds();
});

// Reset chat session
app.post('/api/reset-chat', async (req, res) => {
    try {
        if (model && context) {
            await context.dispose();
            context = await model.createContext({ contextSize: 2048 });
            chatSession = new LlamaChatSession({
                contextSequence: context.getSequence(),
                systemPrompt: "You are Jarvis, a highly advanced AI assistant. You can perform actions, write/read files, run code and use MCP servers via tools. Keep answers concise, intelligent, and well-formatted."
            });
        }
        res.json({ message: "Chat reset." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Main Jarvis chat — with Piper TTS and Function Calling (AI Agent Tools)
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
        
        // Call the LLM prompt with functions
        const responseText = await chatSession.prompt(prompt, {
            functions: Object.keys(allRegisteredTools).length > 0 ? allRegisteredTools : undefined
        });
        
        console.log(`🤖 Jarvis: ${responseText.substring(0, 100)}...`);

        // Generate audio with Piper TTS (returns null if not available)
        const audioDataUrl = await synthesizeSpeech(responseText);

        res.json({ text: responseText, audio: audioDataUrl });
    } catch (error) {
        console.error("Jarvis inference error:", error);
        res.status(500).json({ error: "Processing error: " + error.message });
    }
});

// --- Bootloader Sequence ---
async function startServer() {
    await initMcpServers();
    compileAllTools();
    await initJarvisMinds();
    
    app.listen(8000, () => console.log('🚀 Jarvis AI Core Backend running on port 8000'));
}

startServer();
