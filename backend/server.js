import express from 'express';
import cors from 'cors';
import fs from 'fs';
import https from 'https';
import os from 'os';
import path from 'path';
import { spawn, exec } from 'child_process';
import util from 'util';
import Database from 'better-sqlite3';
import { getLlama, LlamaChatSession, defineChatSessionFunction } from 'node-llama-cpp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const execPromise = util.promisify(exec);

// --- SQLite Chat History DB Setup ---
const db = new Database('./chat_history.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    sender TEXT NOT NULL,
    text TEXT NOT NULL,
    audio_url TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_messages_text ON messages(text);
`);
console.log("✅ SQLite chat history DB initialized.");

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

        // ═══════════════════════════════════════════════════════════════
        // 💻 CODING AGENT v2 — Level 1 + 2 + 3 Improvements
        // ═══════════════════════════════════════════════════════════════

        // ── LEVEL 1: Safe file path helper ──────────────────────────────
        // (internal, not a tool — used by all file tools below)

        // ── LEVEL 1: write_code_file (subfolder support) ─────────────────
        write_code_file: defineChatSessionFunction({
            description: "Write or overwrite a code file in the workspace. Supports subdirectories (e.g. 'src/utils/helper.py'). Use this to create new files.",
            params: {
                type: "object",
                properties: {
                    filename: { type: "string", description: "Relative file path inside workspace (e.g. 'index.js', 'src/app.py')" },
                    code: { type: "string", description: "Full file contents to write." }
                },
                required: ["filename", "code"]
            },
            handler: async ({ filename, code }) => {
                const WORKSPACE_DIR = "./workspace";
                try {
                    // Level 2: Subfolder support — allow paths like src/utils/helper.js
                    const safePath = filename.replace(/\.\./g, '').replace(/^\//, '');
                    const destPath = path.join(WORKSPACE_DIR, safePath);
                    await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
                    await fs.promises.writeFile(destPath, code, 'utf8');
                    const lines = code.split('\n').length;
                    console.log(`📝 Written: ${safePath} (${lines} lines)`);
                    return { status: "success", message: `Written ${safePath} (${lines} lines).` };
                } catch (err) {
                    return { error: err.message };
                }
            }
        }),

        // ── LEVEL 1: patch_code_file — edit specific lines only ──────────
        patch_code_file: defineChatSessionFunction({
            description: "Edit a specific part of an existing file by replacing old_str with new_str. Use this instead of rewriting the whole file when making small changes.",
            params: {
                type: "object",
                properties: {
                    filename: { type: "string", description: "Relative file path inside workspace." },
                    old_str: { type: "string", description: "The exact string to find and replace." },
                    new_str: { type: "string", description: "The replacement string." }
                },
                required: ["filename", "old_str", "new_str"]
            },
            handler: async ({ filename, old_str, new_str }) => {
                const WORKSPACE_DIR = "./workspace";
                try {
                    const safePath = filename.replace(/\.\./g, '').replace(/^\//, '');
                    const filePath = path.join(WORKSPACE_DIR, safePath);
                    if (!fs.existsSync(filePath)) return { error: `File not found: ${safePath}` };
                    const content = await fs.promises.readFile(filePath, 'utf8');
                    if (!content.includes(old_str)) return { error: `old_str not found in ${safePath}. Read the file first to get exact content.` };
                    const patched = content.replace(old_str, new_str);
                    await fs.promises.writeFile(filePath, patched, 'utf8');
                    return { status: "success", message: `Patched ${safePath} successfully.` };
                } catch (err) {
                    return { error: err.message };
                }
            }
        }),

        // ── LEVEL 1: read_code_file (with line numbers) ──────────────────
        read_code_file: defineChatSessionFunction({
            description: "Read a file from the workspace. Returns content with line numbers for easy reference. Supports subdirectory paths.",
            params: {
                type: "object",
                properties: {
                    filename: { type: "string", description: "Relative file path inside workspace." }
                },
                required: ["filename"]
            },
            handler: async ({ filename }) => {
                const WORKSPACE_DIR = "./workspace";
                try {
                    const safePath = filename.replace(/\.\./g, '').replace(/^\//, '');
                    const filePath = path.join(WORKSPACE_DIR, safePath);
                    if (!fs.existsSync(filePath)) return { error: `File not found: ${safePath}` };
                    const content = await fs.promises.readFile(filePath, 'utf8');
                    // Level 1: Add line numbers for easy patching reference
                    const numbered = content.split('\n')
                        .map((line, i) => `${String(i + 1).padStart(4, ' ')} | ${line}`)
                        .join('\n');
                    // Level 1: Truncate large files to avoid context overflow
                    const MAX_CHARS = 8000;
                    const truncated = numbered.length > MAX_CHARS;
                    return {
                        filename: safePath,
                        content: truncated ? numbered.substring(0, MAX_CHARS) + '\n... [truncated]' : numbered,
                        total_lines: content.split('\n').length,
                        truncated
                    };
                } catch (err) {
                    return { error: err.message };
                }
            }
        }),

        // ── LEVEL 1: delete_file ─────────────────────────────────────────
        delete_file: defineChatSessionFunction({
            description: "Delete a file from the workspace. Use to clean up temp files or remove incorrect code.",
            params: {
                type: "object",
                properties: {
                    filename: { type: "string", description: "Relative file path inside workspace to delete." }
                },
                required: ["filename"]
            },
            handler: async ({ filename }) => {
                const WORKSPACE_DIR = "./workspace";
                try {
                    const safePath = filename.replace(/\.\./g, '').replace(/^\//, '');
                    const filePath = path.join(WORKSPACE_DIR, safePath);
                    if (!fs.existsSync(filePath)) return { error: `File not found: ${safePath}` };
                    await fs.promises.unlink(filePath);
                    return { status: "success", message: `Deleted ${safePath}.` };
                } catch (err) {
                    return { error: err.message };
                }
            }
        }),

        // ── LEVEL 2: list_workspace_files (recursive with metadata) ──────
        list_workspace_files: defineChatSessionFunction({
            description: "List all files in the workspace, including subdirectories, with file sizes and last modified times.",
            handler: async () => {
                const WORKSPACE_DIR = "./workspace";
                try {
                    if (!fs.existsSync(WORKSPACE_DIR)) return { files: [], total: 0 };

                    async function listRecursive(dir, base = '') {
                        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
                        let results = [];
                        for (const entry of entries) {
                            const relPath = base ? `${base}/${entry.name}` : entry.name;
                            if (entry.isDirectory()) {
                                const sub = await listRecursive(path.join(dir, entry.name), relPath);
                                results = results.concat(sub);
                            } else {
                                const stat = await fs.promises.stat(path.join(dir, entry.name));
                                results.push({
                                    path: relPath,
                                    size: `${(stat.size / 1024).toFixed(1)} KB`,
                                    modified: new Date(stat.mtime).toLocaleString()
                                });
                            }
                        }
                        return results;
                    }

                    const files = await listRecursive(WORKSPACE_DIR);
                    return { files, total: files.length };
                } catch (err) {
                    return { error: err.message };
                }
            }
        }),

        // ── LEVEL 2: search_in_files ─────────────────────────────────────
        search_in_files: defineChatSessionFunction({
            description: "Search for a keyword or pattern across all files in the workspace. Returns matching lines with file name and line number.",
            params: {
                type: "object",
                properties: {
                    keyword: { type: "string", description: "Text to search for across all workspace files." }
                },
                required: ["keyword"]
            },
            handler: async ({ keyword }) => {
                const WORKSPACE_DIR = "./workspace";
                try {
                    if (!fs.existsSync(WORKSPACE_DIR)) return { matches: [] };
                    const files = await fs.promises.readdir(WORKSPACE_DIR, { recursive: true });
                    const matches = [];
                    for (const file of files) {
                        const fullPath = path.join(WORKSPACE_DIR, file);
                        try {
                            const stat = await fs.promises.stat(fullPath);
                            if (!stat.isFile()) continue;
                            const content = await fs.promises.readFile(fullPath, 'utf8');
                            content.split('\n').forEach((line, i) => {
                                if (line.toLowerCase().includes(keyword.toLowerCase())) {
                                    matches.push({ file, line: i + 1, content: line.trim() });
                                }
                            });
                        } catch (_) {}
                    }
                    return { matches, total: matches.length };
                } catch (err) {
                    return { error: err.message };
                }
            }
        }),

        // ── LEVEL 2: install_package ─────────────────────────────────────
        install_package: defineChatSessionFunction({
            description: "Install an npm or pip package in the workspace. Use when the code needs a library that is not yet installed.",
            params: {
                type: "object",
                properties: {
                    manager: { type: "string", enum: ["npm", "pip"], description: "Package manager to use." },
                    package: { type: "string", description: "Package name to install (e.g. 'lodash', 'pandas')." }
                },
                required: ["manager", "package"]
            },
            handler: async ({ manager, package: pkg }) => {
                const WORKSPACE_DIR = "./workspace";
                // Basic safety: block suspicious package names
                if (!/^[a-zA-Z0-9@/_\-\.]+$/.test(pkg)) {
                    return { error: "Invalid package name." };
                }
                try {
                    await fs.promises.mkdir(WORKSPACE_DIR, { recursive: true });
                    const cmd = manager === 'npm'
                        ? `npm install ${pkg}`
                        : `pip install ${pkg} --quiet`;
                    const { stdout, stderr } = await execPromise(cmd, { cwd: WORKSPACE_DIR, timeout: 60000 });
                    console.log(`📦 Installed [${manager}] ${pkg}`);
                    return { status: "success", stdout: stdout.substring(0, 500), stderr: stderr.substring(0, 200) };
                } catch (err) {
                    return { error: err.message };
                }
            }
        }),

        // ── LEVEL 1+3: execute_code_command (improved + auto-debug loop) ─
        execute_code_command: defineChatSessionFunction({
            description: "Run a terminal command in the workspace (python3, node, bash scripts, etc.). If the command fails, Jarvis will automatically try to fix and retry once. Timeout is 60 seconds.",
            params: {
                type: "object",
                properties: {
                    command: { type: "string", description: "Terminal command to run (e.g. 'python3 app.py', 'node index.js', 'bash run.sh')" },
                    auto_fix: { type: "boolean", description: "If true and command fails, Jarvis will attempt to auto-fix the error and retry. Default: true." }
                },
                required: ["command"]
            },
            handler: async ({ command, auto_fix = true }) => {
                const WORKSPACE_DIR = "./workspace";

                // Level 1: Enhanced blocked keywords
                const blockedKeywords = [
                    "rm -rf", "rm -r", "mkfs", "dd if=", "shutdown", "reboot",
                    ":(){", "wget http", "curl http", "nc -", ">/dev/sd",
                    "chmod 777 /", "chown root"
                ];
                for (const word of blockedKeywords) {
                    if (command.toLowerCase().includes(word)) {
                        return { error: `⛔ Command blocked (safety): '${word}'` };
                    }
                }

                // Level 2: Auto-detect runtime from file extension
                const fileMatch = command.match(/\S+\.(py|js|ts|sh|rb|go)$/);
                let finalCommand = command;
                if (fileMatch && !command.startsWith('python') && !command.startsWith('node') && !command.startsWith('bash')) {
                    const ext = fileMatch[1];
                    const runtimeMap = { py: 'python3', js: 'node', sh: 'bash', rb: 'ruby', go: 'go run' };
                    if (runtimeMap[ext]) finalCommand = `${runtimeMap[ext]} ${command}`;
                }

                const runCommand = async (cmd) => {
                    await fs.promises.mkdir(WORKSPACE_DIR, { recursive: true });
                    // Level 1: Increased timeout 15s → 60s
                    const { stdout, stderr } = await execPromise(cmd, { cwd: WORKSPACE_DIR, timeout: 60000 });

                    // Level 1: Truncate large outputs
                    const MAX_OUT = 5000;
                    return {
                        stdout: stdout.length > MAX_OUT ? stdout.substring(0, MAX_OUT) + '\n...[output truncated]' : stdout,
                        stderr: stderr.length > MAX_OUT ? stderr.substring(0, MAX_OUT) + '\n...[truncated]' : stderr,
                        command: cmd
                    };
                };

                try {
                    const result = await runCommand(finalCommand);
                    // Level 3: Log execution history
                    const logEntry = `[${new Date().toISOString()}] CMD: ${finalCommand} | exit: 0\n`;
                    await fs.promises.appendFile(path.join(WORKSPACE_DIR, '.execution_log'), logEntry, 'utf8').catch(() => {});
                    return result;
                } catch (err) {
                    // Level 3: Auto-debug loop — if error, log it and return structured error for Jarvis to analyze
                    const logEntry = `[${new Date().toISOString()}] CMD: ${finalCommand} | exit: ERROR | ${err.message}\n`;
                    await fs.promises.appendFile(path.join(WORKSPACE_DIR, '.execution_log'), logEntry, 'utf8').catch(() => {});

                    return {
                        error: err.message,
                        stderr: err.stderr ? err.stderr.substring(0, 2000) : '',
                        command: finalCommand,
                        auto_fix_hint: auto_fix
                            ? `❗ Command failed. Read the error above, fix the code using patch_code_file or write_code_file, then run execute_code_command again.`
                            : null
                    };
                }
            }
        }),

        // ── LEVEL 3: get_execution_log ───────────────────────────────────
        get_execution_log: defineChatSessionFunction({
            description: "Read the execution history log of all commands run in the workspace session.",
            handler: async () => {
                const logPath = "./workspace/.execution_log";
                try {
                    if (!fs.existsSync(logPath)) return { log: "No commands executed yet." };
                    const content = await fs.promises.readFile(logPath, 'utf8');
                    const lines = content.trim().split('\n');
                    // Return last 30 entries
                    return { log: lines.slice(-30).join('\n'), total_entries: lines.length };
                } catch (err) {
                    return { error: err.message };
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
        context = await model.createContext({ contextSize: 4096 });

        chatSession = new LlamaChatSession({
            contextSequence: context.getSequence(),
            systemPrompt: `You are Jarvis, a highly advanced AI coding assistant and system agent. You have a full coding workspace at your disposal.

CODING AGENT TOOLS (use in this order for coding tasks):
1. list_workspace_files — see what files exist (includes subdirs + sizes)
2. write_code_file — create new files (supports subdirs like 'src/app.py')
3. patch_code_file — edit specific parts of a file without rewriting it all
4. read_code_file — read files with line numbers (always do this before patching)
5. execute_code_command — run code (python3, node, bash). Auto-detects runtime.
6. install_package — install npm or pip packages when needed
7. search_in_files — search keyword across all workspace files
8. delete_file — remove files
9. get_execution_log — see history of all commands run

AUTO-DEBUG RULE: If execute_code_command returns an error, you MUST:
  a) Read the error carefully
  b) Read the failing file with read_code_file
  c) Fix it using patch_code_file
  d) Run execute_code_command again (up to 3 retries before asking user)

Keep answers concise. Use markdown. Always explain what tool you called and why.`
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

        // Fix 1: Retry without tools if LLM returns empty output
        let responseText;
        try {
            responseText = await chatSession.prompt(prompt, {
                functions: Object.keys(allRegisteredTools).length > 0 ? allRegisteredTools : undefined
            });
        } catch (innerErr) {
            if (innerErr.message?.includes('model output must contain')) {
                console.warn('⚠️ Empty model output with tools — retrying without tools...');
                responseText = await chatSession.prompt(prompt);
            } else {
                throw innerErr;
            }
        }

        // Fix 2: Final safety check — never return empty response
        if (!responseText || !responseText.trim()) {
            responseText = "मला नक्की समजले नाही. कृपया वेगळ्या प्रकारे विचारा.";
        }

        // Fix 3: null-safe logging
        console.log(`🤖 Jarvis: ${(responseText || '').substring(0, 100)}...`);

        // Generate audio with Piper TTS (returns null if not available)
        const audioDataUrl = await synthesizeSpeech(responseText);

        res.json({ text: responseText, audio: audioDataUrl });
    } catch (error) {
        console.error("Jarvis inference error:", error);
        res.status(500).json({ error: "Processing error: " + error.message });
    }
});

// ─── HISTORY API ENDPOINTS ────────────────────────────────────────────────────

// GET all sessions (grouped by date, newest first)
app.get('/api/history/sessions', (req, res) => {
    try {
        const sessions = db.prepare(
            'SELECT id, title, created_at, updated_at FROM sessions ORDER BY updated_at DESC'
        ).all();
        res.json({ sessions });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET messages for a specific session
app.get('/api/history/sessions/:sessionId/messages', (req, res) => {
    try {
        const messages = db.prepare(
            'SELECT id, session_id, sender, text, audio_url, created_at FROM messages WHERE session_id = ? ORDER BY created_at ASC'
        ).all(req.params.sessionId);
        res.json({ messages });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST create or update session
app.post('/api/history/sessions', (req, res) => {
    try {
        const { id, title, created_at } = req.body;
        if (!id || !title) return res.status(400).json({ error: 'id and title required' });
        const now = Date.now();
        db.prepare(
            'INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, updated_at=excluded.updated_at'
        ).run(id, title, created_at || now, now);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST save a message
app.post('/api/history/messages', (req, res) => {
    try {
        const { id, session_id, sender, text, audio_url, created_at } = req.body;
        if (!id || !session_id || !sender || !text) return res.status(400).json({ error: 'Missing required fields' });
        const now = created_at || Date.now();
        db.prepare(
            'INSERT OR REPLACE INTO messages (id, session_id, sender, text, audio_url, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(id, session_id, sender, text, audio_url || null, now);
        // Update session updated_at
        db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, session_id);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE a session and all its messages
app.delete('/api/history/sessions/:sessionId', (req, res) => {
    try {
        db.prepare('DELETE FROM messages WHERE session_id = ?').run(req.params.sessionId);
        db.prepare('DELETE FROM sessions WHERE id = ?').run(req.params.sessionId);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET search across all messages
app.get('/api/history/search', (req, res) => {
    try {
        const { q } = req.query;
        if (!q || String(q).trim().length < 2) return res.json({ results: [] });
        const keyword = `%${String(q).trim()}%`;
        const rows = db.prepare(`
            SELECT m.id, m.session_id, m.sender, m.text, m.created_at, s.title as session_title
            FROM messages m
            JOIN sessions s ON s.id = m.session_id
            WHERE m.text LIKE ?
            ORDER BY m.created_at DESC
            LIMIT 50
        `).all(keyword);
        res.json({ results: rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────

// --- Bootloader Sequence ---
async function startServer() {
    await initMcpServers();
    compileAllTools();
    await initJarvisMinds();
    
    app.listen(8000, () => console.log('🚀 Jarvis AI Core Backend running on port 8000'));
}

startServer();
