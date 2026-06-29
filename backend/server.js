import express from 'express';
import cors from 'cors';
import fs from 'fs';
import https from 'https';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import pdf from 'pdf-parse';
import { spawn, exec } from 'child_process';
import util from 'util';
import Database from 'better-sqlite3';
import { getLlama, LlamaChatSession, defineChatSessionFunction } from 'node-llama-cpp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const execPromise = util.promisify(exec);
const PORT = 8000;

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
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Model Paths
const LLM_PATH = "./models/qwen2.5-7b-instruct-q4_k_m.gguf";
const TTS_PATH = "./models/supertonic-turbo.gguf";
const PIPER_VOICE_PATH = "./tts_voices/en_US-amy-medium.onnx";
const WHISPER_MODEL_PATH = "./models/whisper/ggml-base.bin";

// ── RAG: SQLite Vector Memory (sqlite-vss / simple cosine fallback) ──────────
db.exec(`
  CREATE TABLE IF NOT EXISTS memory_docs (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    embedding TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_memory_source ON memory_docs(source);
  CREATE TABLE IF NOT EXISTS memory_kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);
console.log("✅ RAG memory tables initialized.");

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

// ═══════════════════════════════════════════════════════════════════════════
// 🎤 FEATURE 2: Whisper Local STT — 100% Offline Speech-to-Text
// ═══════════════════════════════════════════════════════════════════════════

// POST /api/stt — receives base64 audio, returns transcribed text via whisper.cpp
app.post('/api/stt', async (req, res) => {
    try {
        const { audio_base64, language = 'auto' } = req.body;
        if (!audio_base64) return res.status(400).json({ error: 'audio_base64 required' });

        // Check if whisper model exists
        if (!fs.existsSync(WHISPER_MODEL_PATH)) {
            return res.status(503).json({
                error: 'Whisper model not found',
                hint: `Download: wget -P ./models/whisper https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin`,
                fallback: true
            });
        }

        // Save incoming audio to temp file
        const tmpAudio = path.join(os.tmpdir(), `jarvis_stt_${Date.now()}.wav`);
        const audioBuffer = Buffer.from(audio_base64.replace(/^data:audio\/\w+;base64,/, ''), 'base64');
        await fs.promises.writeFile(tmpAudio, audioBuffer);

        // Run whisper.cpp — LD_LIBRARY_PATH ensures libwhisper.so.1 is found
        const langFlag = language !== 'auto' ? `-l ${language}` : '';
        const whisperCmd = `whisper-cpp -m ${WHISPER_MODEL_PATH} -f ${tmpAudio} ${langFlag}`;
        const whisperEnv = { ...process.env, LD_LIBRARY_PATH: '/usr/local/lib:/usr/lib:/lib' };

        const { stdout } = await execPromise(whisperCmd, { timeout: 30000, env: whisperEnv });
        await fs.promises.unlink(tmpAudio).catch(() => {});

        // whisper.cpp outputs text with timestamps — extract clean text
        const lines = stdout.split('\n')
            .map(l => l.replace(/\[\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}\]\s*/g, '').trim())
            .filter(Boolean);
        const transcript = lines.join(' ').trim();
        console.log(`🎤 Whisper STT: "${transcript}"`);
        res.json({ text: transcript, language });
    } catch (err) {
        console.error('Whisper STT error:', err.message);
        res.status(500).json({ error: err.message, fallback: true });
    }
});

// GET /api/stt/status — whisper model status check
app.get('/api/stt/status', (req, res) => {
    const modelExists = fs.existsSync(WHISPER_MODEL_PATH);
    res.json({
        whisper_ready: modelExists,
        model_path: WHISPER_MODEL_PATH,
        hint: modelExists ? null : 'Download ggml-base.bin from HuggingFace ggerganov/whisper.cpp'
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 💾 FEATURE 3: RAG — Long-Term Vector Memory
// ═══════════════════════════════════════════════════════════════════════════

// Simple cosine similarity (no external dep needed)
function cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        magA += a[i] * a[i];
        magB += b[i] * b[i];
    }
    return dot / (Math.sqrt(magA) * Math.sqrt(magB) + 1e-10);
}

// Keyword-based TF-IDF style embedding (offline, no model needed)
function simpleEmbed(text, vocabSize = 256) {
    const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/);
    const vec = new Array(vocabSize).fill(0);
    for (const word of words) {
        let hash = 0;
        for (const ch of word) hash = (hash * 31 + ch.charCodeAt(0)) % vocabSize;
        vec[hash] += 1;
    }
    // L2 normalize
    const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) + 1e-10;
    return vec.map(v => v / mag);
}

// POST /api/memory/ingest — add document chunks to memory
app.post('/api/memory/ingest', async (req, res) => {
    try {
        const { source, file_base64, file_type } = req.body;
        let content = req.body.content;

        if (!source) return res.status(400).json({ error: 'source required' });

        if (file_base64 && file_type === 'pdf') {
            try {
                const pdfBuffer = Buffer.from(file_base64.replace(/^data:application\/pdf;base64,/, ''), 'base64');
                const pdfData = await pdf(pdfBuffer);
                content = pdfData.text;
                console.log(`📄 PDF parsed successfully [${source}]: ~${content.length} chars extracted.`);
            } catch (pdfErr) {
                console.error("❌ PDF parse error:", pdfErr.message);
                return res.status(400).json({ error: 'Failed to parse PDF file: ' + pdfErr.message });
            }
        }

        if (!content || !content.trim()) {
            return res.status(400).json({ error: 'Content is empty or failed to extract text.' });
        }

        // Split into ~300 word chunks
        const words = content.split(/\s+/);
        const CHUNK_SIZE = 300;
        const chunks = [];
        for (let i = 0; i < words.length; i += CHUNK_SIZE) {
            chunks.push(words.slice(i, i + CHUNK_SIZE).join(' '));
        }

        const now = Date.now();
        const insertChunk = db.prepare(
            'INSERT OR REPLACE INTO memory_docs (id, source, chunk_index, content, embedding, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        );

        for (let i = 0; i < chunks.length; i++) {
            const embedding = simpleEmbed(chunks[i]);
            insertChunk.run(`${source}_${i}`, source, i, chunks[i], JSON.stringify(embedding), now);
        }

        res.json({ ok: true, source, chunks_stored: chunks.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/memory/search?q=... — semantic search in memory
app.get('/api/memory/search', (req, res) => {
    try {
        const { q, limit = 5 } = req.query;
        if (!q) return res.json({ results: [] });

        const queryEmbed = simpleEmbed(String(q));
        const all = db.prepare('SELECT id, source, chunk_index, content, embedding FROM memory_docs').all();

        const scored = all.map(doc => {
            const docEmbed = doc.embedding ? JSON.parse(doc.embedding) : [];
            return { ...doc, score: cosineSimilarity(queryEmbed, docEmbed) };
        }).sort((a, b) => b.score - a.score).slice(0, Number(limit));

        res.json({ results: scored.map(r => ({ source: r.source, chunk_index: r.chunk_index, content: r.content, score: r.score.toFixed(4) })) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/memory/sources — list all ingested sources
app.get('/api/memory/sources', (req, res) => {
    try {
        const sources = db.prepare(
            'SELECT source, COUNT(*) as chunks, MAX(created_at) as last_updated FROM memory_docs GROUP BY source ORDER BY last_updated DESC'
        ).all();
        res.json({ sources });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/memory/sources/:source — remove a document from memory
app.delete('/api/memory/sources/:source', (req, res) => {
    try {
        db.prepare('DELETE FROM memory_docs WHERE source = ?').run(req.params.source);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// KV Memory — GET/SET key-value pairs for Jarvis long-term facts
app.get('/api/memory/kv/:key', (req, res) => {
    try {
        const row = db.prepare('SELECT value FROM memory_kv WHERE key = ?').get(req.params.key);
        res.json({ key: req.params.key, value: row ? row.value : null });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/memory/kv', (req, res) => {
    try {
        const { key, value } = req.body;
        db.prepare('INSERT OR REPLACE INTO memory_kv (key, value, updated_at) VALUES (?, ?, ?)').run(key, String(value), Date.now());
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// 📊 FEATURE 4: Workspace Visualizer API (Live file tree + content)
// ═══════════════════════════════════════════════════════════════════════════

const WORKSPACE_DIR = "./workspace";

// GET /api/workspace/tree — full file tree with metadata
app.get('/api/workspace/tree', async (req, res) => {
    try {
        await fs.promises.mkdir(WORKSPACE_DIR, { recursive: true });

        async function buildTree(dir, base = '') {
            const entries = await fs.promises.readdir(dir, { withFileTypes: true });
            const nodes = [];
            for (const e of entries) {
                if (e.name.startsWith('.')) continue; // skip hidden files
                const relPath = base ? `${base}/${e.name}` : e.name;
                if (e.isDirectory()) {
                    nodes.push({ name: e.name, path: relPath, type: 'dir', children: await buildTree(path.join(dir, e.name), relPath) });
                } else {
                    const stat = await fs.promises.stat(path.join(dir, e.name));
                    nodes.push({ name: e.name, path: relPath, type: 'file', size: stat.size, modified: stat.mtime.toISOString() });
                }
            }
            return nodes.sort((a, b) => (a.type === 'dir' ? -1 : 1) || a.name.localeCompare(b.name));
        }

        const tree = await buildTree(WORKSPACE_DIR);
        res.json({ tree });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/workspace/file?path=src/app.py — read file content
app.get('/api/workspace/file', async (req, res) => {
    try {
        const filePath = req.query.path;
        if (!filePath) return res.status(400).json({ error: 'path required' });
        const safePath = String(filePath).replace(/\.\./g, '').replace(/^\//, '');
        const fullPath = path.join(WORKSPACE_DIR, safePath);
        if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'File not found' });
        const content = await fs.promises.readFile(fullPath, 'utf8');
        res.json({ path: safePath, content, size: content.length, lines: content.split('\n').length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/workspace/log — execution log
app.get('/api/workspace/log', async (req, res) => {
    try {
        const logPath = path.join(WORKSPACE_DIR, '.execution_log');
        if (!fs.existsSync(logPath)) return res.json({ log: '', entries: 0 });
        const content = await fs.promises.readFile(logPath, 'utf8');
        const lines = content.trim().split('\n').filter(Boolean);
        res.json({ log: lines.slice(-50).join('\n'), entries: lines.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// 🤖 FEATURE 5: Multi-Agent System
// Supervisor Jarvis can spawn sub-agents for parallel tasks
// ═══════════════════════════════════════════════════════════════════════════

// Active sub-agent tasks store (in-memory)
const subAgentTasks = new Map();

// POST /api/agent/spawn — create a sub-agent task
app.post('/api/agent/spawn', async (req, res) => {
    try {
        const { task, agent_type = 'coder', context: ctx = '' } = req.body;
        if (!task) return res.status(400).json({ error: 'task required' });
        if (systemStatus !== 'ready') return res.status(503).json({ error: 'Jarvis not ready' });

        const taskId = `agent_${Date.now()}`;
        subAgentTasks.set(taskId, { id: taskId, task, agent_type, status: 'running', result: null, created_at: Date.now() });

        // Run sub-agent in background
        (async () => {
            try {
                // Each sub-agent gets its own context (lightweight)
                const agentContext = await model.createContext({ contextSize: 1024 });
                const agentPrompts = {
                    coder: `You are a coding sub-agent. Your ONLY job: complete the coding task and return the result concisely. Task: ${task}${ctx ? `\nContext: ${ctx}` : ''}`,
                    reviewer: `You are a code reviewer sub-agent. Review for bugs, security issues, and best practices. Task: ${task}${ctx ? `\nCode to review:\n${ctx}` : ''}`,
                    researcher: `You are a research sub-agent. Summarize facts and key points concisely. Topic: ${task}`,
                    tester: `You are a QA testing sub-agent. Write test cases and identify edge cases. Task: ${task}${ctx ? `\nCode to test:\n${ctx}` : ''}`
                };

                const agentSession = new LlamaChatSession({
                    contextSequence: agentContext.getSequence(),
                    systemPrompt: agentPrompts[agent_type] || agentPrompts.coder
                });

                const result = await agentSession.prompt(task);
                agentContext.dispose();

                subAgentTasks.set(taskId, {
                    ...subAgentTasks.get(taskId),
                    status: 'done',
                    result,
                    completed_at: Date.now()
                });
                console.log(`✅ Sub-agent [${agent_type}] task ${taskId} done.`);
            } catch (err) {
                subAgentTasks.set(taskId, {
                    ...subAgentTasks.get(taskId),
                    status: 'error',
                    result: err.message
                });
            }
        })();

        res.json({ taskId, status: 'running', message: `Sub-agent [${agent_type}] spawned for: "${task.substring(0, 60)}"` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/agent/status/:taskId — poll sub-agent result
app.get('/api/agent/status/:taskId', (req, res) => {
    const task = subAgentTasks.get(req.params.taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(task);
});

// GET /api/agent/tasks — list all sub-agent tasks
app.get('/api/agent/tasks', (req, res) => {
    const tasks = Array.from(subAgentTasks.values())
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, 20);
    res.json({ tasks });
});

// DELETE /api/agent/tasks — clear completed tasks
app.delete('/api/agent/tasks', (req, res) => {
    for (const [id, task] of subAgentTasks.entries()) {
        if (task.status !== 'running') subAgentTasks.delete(id);
    }
    res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// ⚙️  SETTINGS API — read/write API keys & config from UI
// ═══════════════════════════════════════════════════════════════════════════
const SETTINGS_PATH = './settings.json';
const KEY_PATH = './.secrets_key';
const ALGORITHM = 'aes-256-cbc';
let encryptionKey = null;

function getEncryptionKey() {
    if (encryptionKey) return encryptionKey;
    try {
        if (fs.existsSync(KEY_PATH)) {
            const hexKey = fs.readFileSync(KEY_PATH, 'utf8').trim();
            encryptionKey = Buffer.from(hexKey, 'hex');
            if (encryptionKey.length === 32) {
                return encryptionKey;
            }
        }
    } catch (_) {}
    
    // Generate new 32-byte key
    const key = crypto.randomBytes(32);
    try {
        fs.writeFileSync(KEY_PATH, key.toString('hex'), 'utf8');
        console.log("🔑 Generated new local encryption key in .secrets_key");
    } catch (err) {
        console.error("❌ Failed to write encryption key:", err.message);
    }
    encryptionKey = key;
    return encryptionKey;
}

function encrypt(text) {
    const key = getEncryptionKey();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return `${iv.toString('hex')}:${encrypted}`;
}

function decrypt(text) {
    try {
        const parts = text.split(':');
        if (parts.length !== 2) return text; // Not encrypted
        const iv = Buffer.from(parts[0], 'hex');
        const encryptedText = Buffer.from(parts[1], 'hex');
        const key = getEncryptionKey();
        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (err) {
        console.error("❌ Decryption failed:", err.message);
        return '{}';
    }
}

function loadSettings() {
    try {
        if (fs.existsSync(SETTINGS_PATH)) {
            const rawContent = fs.readFileSync(SETTINGS_PATH, 'utf8').trim();
            let jsonString = rawContent;
            if (rawContent && !rawContent.startsWith('{')) {
                jsonString = decrypt(rawContent);
            }
            return JSON.parse(jsonString);
        }
    } catch (_) {}
    return { braveApiKey: '', githubToken: '', whisperLang: 'hi', ragEnabled: true };
}

function saveSettings(data) {
    const jsonString = JSON.stringify(data, null, 2);
    const encryptedContent = encrypt(jsonString);
    fs.writeFileSync(SETTINGS_PATH, encryptedContent, 'utf8');
}

// GET /api/settings — return current settings (keys masked)
app.get('/api/settings', (req, res) => {
    const s = loadSettings();
    res.json({
        braveApiKey:  s.braveApiKey  ? s.braveApiKey.slice(0,6)  + '****' + s.braveApiKey.slice(-4)  : '',
        braveApiKeySet: !!s.braveApiKey,
        githubToken:  s.githubToken  ? s.githubToken.slice(0,6)  + '****' + s.githubToken.slice(-4)  : '',
        githubTokenSet: !!s.githubToken,
        whisperLang:  s.whisperLang  || 'hi',
        ragEnabled:   s.ragEnabled !== false,
    });
});

// POST /api/settings — save new settings & update mcp_config.json
app.post('/api/settings', async (req, res) => {
    try {
        const prev = loadSettings();
        const updated = {
            braveApiKey:  req.body.braveApiKey  !== undefined ? req.body.braveApiKey.trim()  : prev.braveApiKey,
            githubToken:  req.body.githubToken  !== undefined ? req.body.githubToken.trim()  : prev.githubToken,
            whisperLang:  req.body.whisperLang  !== undefined ? req.body.whisperLang         : prev.whisperLang,
            ragEnabled:   req.body.ragEnabled   !== undefined ? !!req.body.ragEnabled        : prev.ragEnabled,
        };
        saveSettings(updated);

        // Update mcp_config.json with real keys
        const mcpConfigPath = './mcp_config.json';
        if (fs.existsSync(mcpConfigPath)) {
            const mcp = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8'));
            if (mcp.mcpServers['brave-search']) {
                mcp.mcpServers['brave-search'].env = { BRAVE_API_KEY: updated.braveApiKey || 'YOUR_BRAVE_API_KEY_HERE' };
            }
            if (mcp.mcpServers['github']) {
                mcp.mcpServers['github'].env = { GITHUB_PERSONAL_ACCESS_TOKEN: updated.githubToken || 'YOUR_GITHUB_TOKEN_HERE' };
            }
            fs.writeFileSync(mcpConfigPath, JSON.stringify(mcp, null, 2), 'utf8');
        }

        // Reload MCP servers dynamically so keys take effect immediately
        await reloadMcpServers();

        res.json({ ok: true, message: 'Settings saved! MCP servers reloaded dynamically.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// Function to reload MCP servers dynamically
async function reloadMcpServers() {
    console.log("🔄 Reloading MCP servers dynamically...");
    
    // Close existing MCP clients
    for (const [serverName, client] of Object.entries(mcpClients)) {
        try {
            console.log(`🔌 Closing client connection for MCP Server: ${serverName}`);
            await client.close();
        } catch (err) {
            console.error(`❌ Error closing MCP client ${serverName}:`, err.message);
        }
    }
    
    // Reset state
    mcpClients = {};
    mcpTools = {};
    
    // Re-initialize MCP servers
    await initMcpServers();
    
    // Re-compile all tools
    compileAllTools();
    
    console.log("✅ MCP servers reloaded and tools compiled dynamically!");
}

// ═══════════════════════════════════════════════════════════════════════════
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

        // ── FEATURE 3: RAG Memory Tools ─────────────────────────────────
        memory_search: defineChatSessionFunction({
            description: "Search Jarvis's long-term document memory for relevant information. Use when user asks about documents they previously uploaded.",
            params: {
                type: "object",
                properties: {
                    query: { type: "string", description: "What to search for in memory." },
                    limit: { type: "number", description: "Max results (default 5)." }
                },
                required: ["query"]
            },
            handler: async ({ query, limit = 5 }) => {
                const queryEmbed = simpleEmbed(query);
                const all = db.prepare('SELECT id, source, content, embedding FROM memory_docs').all();
                const scored = all.map(doc => ({
                    source: doc.source,
                    content: doc.content,
                    score: cosineSimilarity(queryEmbed, doc.embedding ? JSON.parse(doc.embedding) : [])
                })).sort((a, b) => b.score - a.score).slice(0, limit);
                return scored.length > 0 ? { results: scored } : { message: "No relevant memory found." };
            }
        }),

        memory_remember: defineChatSessionFunction({
            description: "Save an important fact or user preference to long-term memory.",
            params: {
                type: "object",
                properties: {
                    key: { type: "string", description: "Unique key (e.g. 'user_name', 'preferred_language')" },
                    value: { type: "string", description: "Value to remember." }
                },
                required: ["key", "value"]
            },
            handler: async ({ key, value }) => {
                db.prepare('INSERT OR REPLACE INTO memory_kv (key, value, updated_at) VALUES (?, ?, ?)').run(key, value, Date.now());
                return { ok: true, message: `Remembered: ${key} = ${value}` };
            }
        }),

        memory_recall: defineChatSessionFunction({
            description: "Recall a fact previously saved to long-term memory by key.",
            params: {
                type: "object",
                properties: {
                    key: { type: "string", description: "Key to recall." }
                },
                required: ["key"]
            },
            handler: async ({ key }) => {
                const row = db.prepare('SELECT value FROM memory_kv WHERE key = ?').get(key);
                return row ? { key, value: row.value } : { message: `No memory found for key: ${key}` };
            }
        }),

        // ── FEATURE 5: Multi-Agent Tools ────────────────────────────────
        spawn_sub_agent: defineChatSessionFunction({
            description: "Spawn a specialized sub-agent to work on a task in parallel. Agent types: 'coder', 'reviewer', 'researcher', 'tester'. Returns a taskId to check results later.",
            params: {
                type: "object",
                properties: {
                    task: { type: "string", description: "What the sub-agent should do." },
                    agent_type: { type: "string", enum: ["coder", "reviewer", "researcher", "tester"], description: "Type of sub-agent." },
                    context: { type: "string", description: "Optional context (e.g. code to review)." }
                },
                required: ["task", "agent_type"]
            },
            handler: async ({ task, agent_type, context: ctx = '' }) => {
                try {
                    const res = await fetch(`http://localhost:${PORT}/api/agent/spawn`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ task, agent_type, context: ctx })
                    });
                    return await res.json();
                } catch (err) {
                    return { error: err.message };
                }
            }
        }),

        check_sub_agent: defineChatSessionFunction({
            description: "Check the status and result of a previously spawned sub-agent task.",
            params: {
                type: "object",
                properties: {
                    taskId: { type: "string", description: "Task ID returned from spawn_sub_agent." }
                },
                required: ["taskId"]
            },
            handler: async ({ taskId }) => {
                try {
                    const res = await fetch(`http://localhost:${PORT}/api/agent/status/${taskId}`);
                    return await res.json();
                } catch (err) {
                    return { error: err.message };
                }
            }
        }),
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
        context = await model.createContext({
            contextSize: 8192,
            batchSize: 512,
        });

        chatSession = new LlamaChatSession({
            contextSequence: context.getSequence(),
            systemPrompt: `You are Jarvis, a helpful AI assistant. Answer concisely in the same language as the user. Use markdown formatting.`
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

    // CPU usage (average load % over last 1 min)
    const cpus = os.cpus();
    const avgLoad = os.loadavg()[0];
    const cpuPercent = Math.min(100, Math.round((avgLoad / cpus.length) * 100));

    // RAM
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;

    res.json({
        status: systemStatus,
        error: systemErrorMessage,
        llmExists,
        ttsExists,
        piperReady,
        cpu: cpuPercent,
        ramUsed: Math.round(usedMem / 1024 / 1024),   // MB
        ramTotal: Math.round(totalMem / 1024 / 1024),  // MB
        uptime: Math.floor(os.uptime())                 // seconds
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
            context = await model.createContext({ contextSize: 16384 });
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

    // Backend timeout — 90s नंतर automatic error response
    const BACKEND_TIMEOUT_MS = 400000;
    let timeoutHandle;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error('BACKEND_TIMEOUT')), BACKEND_TIMEOUT_MS);
    });

    try {
        console.log(`💬 User: ${prompt}`);

        // Tools बंद — Qwen-7B CPU वर tools सह खूप slow आहे
        // Plain chat mode: fast responses, no tool overhead
        console.log(`💬 Plain chat mode (no tools — CPU optimized)`);

        const inferencePromise = (async () => {
            const responseText = await chatSession.prompt(prompt, {
                maxTokens: 256,  // छोटे responses = faster
            });
            return responseText;
        })();

        let responseText = await Promise.race([inferencePromise, timeoutPromise]);
        clearTimeout(timeoutHandle);

        if (!responseText || !responseText.trim()) {
            responseText = "मला नक्की समजले नाही. कृपया वेगळ्या प्रकारे विचारा.";
        }

        console.log(`🤖 Jarvis: ${(responseText || '').substring(0, 100)}...`);

        const audioDataUrl = await synthesizeSpeech(responseText);
        res.json({ text: responseText, audio: audioDataUrl });

    } catch (error) {
        clearTimeout(timeoutHandle);
        if (error.message === 'BACKEND_TIMEOUT') {
            console.error("⏱️ Backend timeout — model too slow");
            return res.status(504).json({ error: "Jarvis ला उत्तर द्यायला वेळ लागतोय. पुन्हा विचारा." });
        }
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
