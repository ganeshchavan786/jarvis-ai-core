'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import {
  Mic, MicOff, Send, Play, Pause, AlertCircle, Bot, User,
  RotateCcw, Download, Cpu, Activity, CheckCircle, RefreshCw,
  Plus, Trash2, Menu, X, MessageSquare, Search, Calendar,
  ChevronDown, ChevronRight, Sun, Moon, Copy, Check, Wrench, Zap
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';

const API = 'https://jarvis.vrushaliinfotech.com';

interface Message {
  id: string;
  sender: 'user' | 'jarvis';
  text: string;
  audioUrl?: string;
  created_at?: number;
}

interface ChatSession {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  messages: Message[];
}

interface GroupedSessions {
  label: string;
  sessions: ChatSession[];
}

interface ModelProgress {
  total: number;
  downloaded: number;
  percent: number;
  active: boolean;
  error: string | null;
}

interface DownloadStatus {
  llm: ModelProgress;
  tts: ModelProgress;
}

interface SearchResult {
  id: string;
  session_id: string;
  session_title: string;
  sender: string;
  text: string;
  created_at: number;
}

interface SystemInfo {
  status: string;
  llmExists: boolean;
  ttsExists: boolean;
  error?: string;
  cpu?: number;
  ramUsed?: number;
  ramTotal?: number;
  uptime?: number;
}

// ── Tool name extraction ───────────────────────────────────────────────────────
const KNOWN_TOOLS = [
  'write_code_file','patch_code_file','read_code_file','delete_file',
  'list_workspace_files','search_in_files','install_package',
  'execute_code_command','get_execution_log','get_system_health',
  'get_weather','create_note','read_note'
];
function extractToolBadges(text: string): string[] {
  const found: string[] = [];
  for (const t of KNOWN_TOOLS) {
    if (text.includes(t)) found.push(t);
  }
  return [...new Set(found)];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDateLabel(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const isSameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (isSameDay(d, today)) return 'आज (Today)';
  if (isSameDay(d, yesterday)) return 'काल (Yesterday)';
  const diffMs = today.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffDays < 7) return `${diffDays} दिवसांपूर्वी`;
  return d.toLocaleDateString('mr-IN', { day: 'numeric', month: 'long', year: 'numeric' });
}

function groupSessionsByDate(sessions: ChatSession[]): GroupedSessions[] {
  const map = new Map<string, ChatSession[]>();
  for (const s of sessions) {
    const label = formatDateLabel(s.updated_at);
    if (!map.has(label)) map.set(label, []);
    map.get(label)!.push(s);
  }
  return Array.from(map.entries()).map(([label, sessions]) => ({ label, sessions }));
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('mr-IN', { hour: '2-digit', minute: '2-digit' });
}

function formatSize(bytes: number) {
  if (bytes === 0) return '0 B';
  const k = 1024, sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatUptime(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ── Copy Button ───────────────────────────────────────────────────────────────
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    await navigator.clipboard.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button
      onClick={handleCopy}
      className="copy-btn absolute top-2 right-2 p-1.5 rounded-lg bg-violet-950/60 border border-violet-500/30 text-violet-300 hover:text-white hover:bg-violet-700/50 transition-all"
      title="Copy"
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

// ── Tool Badges ───────────────────────────────────────────────────────────────
function ToolBadges({ text }: { text: string }) {
  const tools = extractToolBadges(text);
  if (tools.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 mb-2">
      {tools.map(t => (
        <span key={t} className="tool-badge">
          <Wrench size={9} /> {t}
        </span>
      ))}
    </div>
  );
}

// ── Status Bar ────────────────────────────────────────────────────────────────
function StatusBar({ info }: { info: SystemInfo | null }) {
  if (!info) return null;
  const cpu = info.cpu ?? 0;
  const ramPct = info.ramTotal ? Math.round((info.ramUsed! / info.ramTotal!) * 100) : 0;
  return (
    <div className="flex items-center gap-4 px-4 py-1.5 bg-black/30 border-b border-violet-500/10 text-[10px] font-mono text-violet-400/70 overflow-x-auto">
      <span className="flex items-center gap-1.5 shrink-0">
        <Cpu size={10} />
        <span>CPU</span>
        <div className="w-16 h-1.5 bg-violet-950 rounded-full overflow-hidden">
          <div className="h-full shimmer-bar rounded-full" style={{ width: `${cpu}%` }} />
        </div>
        <span>{cpu}%</span>
      </span>
      <span className="flex items-center gap-1.5 shrink-0">
        <Activity size={10} />
        <span>RAM</span>
        <div className="w-16 h-1.5 bg-violet-950 rounded-full overflow-hidden">
          <div className="h-full shimmer-bar rounded-full" style={{ width: `${ramPct}%` }} />
        </div>
        <span>{ramPct}%</span>
      </span>
      {info.uptime !== undefined && (
        <span className="flex items-center gap-1 shrink-0">
          <Zap size={10} /> UP: {formatUptime(info.uptime)}
        </span>
      )}
      <span className={`ml-auto shrink-0 font-bold ${info.status === 'ready' ? 'text-green-400' : 'text-amber-400'}`}>
        ● {info.status?.toUpperCase()}
      </span>
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────

export default function JarvisAdvancedUI() {
  // Theme
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');

  // Chat States
  const [messages, setMessages] = useState<Message[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>('');
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [error, setError] = useState<{ type: 'network' | 'server' | null; message: string }>({ type: null, message: '' });
  const [playingAudioId, setPlayingAudioId] = useState<string | null>(null);
  const [speechLanguage, setSpeechLanguage] = useState<'mr-IN' | 'en-US'>('mr-IN');

  // System info for status bar
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);

  // Search
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const searchDebounceRef = useRef<NodeJS.Timeout | null>(null);

  // Collapsed date groups
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  // System Setup States
  const [systemState, setSystemState] = useState<'checking' | 'uninitialized' | 'loading' | 'ready' | 'error'>('checking');
  const [systemErrorMessage, setSystemErrorMessage] = useState('');
  const [llmExists, setLlmExists] = useState(false);
  const [ttsExists, setTtsExists] = useState(false);

  // Download States
  const [llmUrl, setLlmUrl] = useState('https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf');
  const [ttsUrl, setTtsUrl] = useState('');
  const [downloadProgress, setDownloadProgress] = useState<DownloadStatus>({
    llm: { total: 0, downloaded: 0, percent: 0, active: false, error: null },
    tts: { total: 0, downloaded: 0, percent: 0, active: false, error: null }
  });

  const chatEndRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const recognitionRef = useRef<any>(null);
  const statusPollRef = useRef<NodeJS.Timeout | null>(null);
  const downloadPollRef = useRef<NodeJS.Timeout | null>(null);
  const hasLoadedRef = useRef(false);

  // ── Theme ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    const saved = localStorage.getItem('jarvis_theme') as 'dark' | 'light' | null;
    if (saved) setTheme(saved);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('jarvis_theme', theme);
  }, [theme]);

  const toggleTheme = () => setTheme(t => t === 'dark' ? 'light' : 'dark');

  // ── System Status ──────────────────────────────────────────────────────────

  const checkSystemStatus = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/system/status`);
      if (!res.ok) throw new Error('offline');
      const data: SystemInfo = await res.json();
      setSystemState(data.status as any);
      setSystemErrorMessage(data.error || '');
      setLlmExists(data.llmExists);
      setTtsExists(data.ttsExists);
      setSystemInfo(data);
      if (data.status === 'ready' && statusPollRef.current) {
        clearInterval(statusPollRef.current);
        statusPollRef.current = null;
      }
    } catch {
      setSystemState('error');
      setSystemErrorMessage('बॅकएंड सर्व्हरशी संपर्क होऊ शकला नाही.');
    }
  }, []);

  const checkDownloadStatus = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/download/status`);
      if (!res.ok) throw new Error('offline');
      const data: DownloadStatus = await res.json();
      setDownloadProgress(data);
      if (!data.llm.active && !data.tts.active) {
        if (downloadPollRef.current) { clearInterval(downloadPollRef.current); downloadPollRef.current = null; }
        checkSystemStatus();
      }
    } catch { /* ignore */ }
  }, [checkSystemStatus]);

  // ── SQLite History Sync ────────────────────────────────────────────────────

  const loadSessionsFromDB = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/history/sessions`);
      if (!res.ok) throw new Error('failed');
      const data = await res.json();
      const dbSessions: ChatSession[] = (data.sessions || []).map((s: any) => ({
        id: s.id, title: s.title, created_at: s.created_at, updated_at: s.updated_at, messages: []
      }));
      if (dbSessions.length === 0) {
        const fresh = await createSessionInDB('नवीन संभाषण (New Chat)');
        setSessions([fresh]);
        setActiveSessionId(fresh.id);
      } else {
        setSessions(dbSessions);
        const lastActive = localStorage.getItem('jarvis_active_session_id');
        const targetId = lastActive && dbSessions.find(s => s.id === lastActive) ? lastActive : dbSessions[0].id;
        setActiveSessionId(targetId);
        await loadMessagesForSession(targetId, dbSessions, true);
      }
      hasLoadedRef.current = true;
    } catch {
      fallbackLoadFromLocalStorage();
    }
  }, []);

  const createSessionInDB = async (title: string): Promise<ChatSession> => {
    const id = Date.now().toString();
    const now = Date.now();
    await fetch(`${API}/api/history/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, title, created_at: now })
    }).catch(() => {});
    return { id, title, created_at: now, updated_at: now, messages: [] };
  };

  const loadMessagesForSession = async (
    sessionId: string, currentSessions?: ChatSession[], setActive?: boolean
  ) => {
    try {
      const res = await fetch(`${API}/api/history/sessions/${sessionId}/messages`);
      if (!res.ok) throw new Error('failed');
      const data = await res.json();
      const msgs: Message[] = (data.messages || []).map((m: any) => ({
        id: m.id, sender: m.sender, text: m.text, audioUrl: m.audio_url || undefined, created_at: m.created_at
      }));
      if (setActive) setMessages(msgs);
      if (currentSessions) setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, messages: msgs } : s));
      return msgs;
    } catch { return []; }
  };

  const saveMessageToDB = async (msg: Message, sessionId: string) => {
    const now = Date.now();
    await fetch(`${API}/api/history/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: msg.id, session_id: sessionId, sender: msg.sender, text: msg.text, audio_url: msg.audioUrl || null, created_at: now })
    }).catch(() => {});
  };

  const updateSessionTitle = async (sessionId: string, title: string) => {
    await fetch(`${API}/api/history/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: sessionId, title, created_at: Date.now() })
    }).catch(() => {});
  };

  const fallbackLoadFromLocalStorage = () => {
    try {
      const stored = localStorage.getItem('jarvis_sessions');
      if (stored) {
        const parsed: ChatSession[] = JSON.parse(stored);
        setSessions(parsed);
        const lastActive = localStorage.getItem('jarvis_active_session_id');
        const targetId = lastActive && parsed.find(s => s.id === lastActive) ? lastActive : parsed[0]?.id;
        if (targetId) {
          setActiveSessionId(targetId);
          setMessages(parsed.find(s => s.id === targetId)?.messages || []);
        }
      } else {
        const fresh: ChatSession = { id: Date.now().toString(), title: 'नवीन संभाषण (New Chat)', created_at: Date.now(), updated_at: Date.now(), messages: [] };
        setSessions([fresh]);
        setActiveSessionId(fresh.id);
      }
      hasLoadedRef.current = true;
    } catch { /* ignore */ }
  };

  // ── Effects ────────────────────────────────────────────────────────────────

  useEffect(() => {
    checkSystemStatus();
    statusPollRef.current = setInterval(checkSystemStatus, 5000);
    return () => { if (statusPollRef.current) clearInterval(statusPollRef.current); };
  }, [checkSystemStatus]);

  useEffect(() => {
    if (systemState === 'ready' && !hasLoadedRef.current) loadSessionsFromDB();
  }, [systemState, loadSessionsFromDB]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  // System info refresh every 10s when ready
  useEffect(() => {
    if (systemState !== 'ready') return;
    const t = setInterval(checkSystemStatus, 10000);
    return () => clearInterval(t);
  }, [systemState, checkSystemStatus]);

  // Search debounce
  useEffect(() => {
    if (!showSearch) return;
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    if (searchQuery.trim().length < 2) { setSearchResults([]); return; }
    setIsSearching(true);
    searchDebounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`${API}/api/history/search?q=${encodeURIComponent(searchQuery.trim())}`);
        const data = await res.json();
        setSearchResults(data.results || []);
      } catch { setSearchResults([]); }
      finally { setIsSearching(false); }
    }, 400);
  }, [searchQuery, showSearch]);

  // Voice recognition setup
  useEffect(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) return;
    const recognition = new SpeechRecognition();
    recognition.lang = speechLanguage;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onresult = (e: any) => {
      const text = e.results[0][0].transcript;
      setInput(prev => prev + (prev ? ' ' : '') + text);
    };
    const msgs: Record<string, string> = {
      'no-speech': 'बोलणे आढळले नाही.', 'audio-capture': 'मायक्रोफोन आढळला नाही.',
      'not-allowed': 'मायक्रोफोन परवानगी नाकारली गेली.'
    };
    recognition.onerror = (e: any) => {
      setError({ type: 'server', message: msgs[e.error] || `व्हॉईस एरर: ${e.error}` });
    };
    recognition.onend = () => setIsListening(false);
    recognitionRef.current = recognition;
  }, [speechLanguage]);

  // Mobile: close sidebar on resize
  useEffect(() => {
    const handler = () => { if (window.innerWidth >= 768) setIsSidebarOpen(false); };
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  // ── Chat Actions ──────────────────────────────────────────────────────────

  const handleSendMessage = async () => {
    if (!input.trim() || loading) return;
    setError({ type: null, message: '' });
    const now = Date.now();
    const userMsg: Message = { id: now.toString(), sender: 'user', text: input.trim(), created_at: now };
    const userPrompt = input.trim();
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setLoading(true);

    const currentSession = sessions.find(s => s.id === activeSessionId);
    if (currentSession && currentSession.title === 'नवीन संभाषण (New Chat)' && messages.length === 0) {
      const newTitle = userPrompt.substring(0, 28) + (userPrompt.length > 28 ? '...' : '');
      setSessions(prev => prev.map(s => s.id === activeSessionId ? { ...s, title: newTitle } : s));
      await updateSessionTitle(activeSessionId, newTitle);
    }
    await saveMessageToDB(userMsg, activeSessionId);

    try {
      const res = await fetch(`${API}/api/jarvis`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: userPrompt })
      });
      if (!res.ok) throw new Error(res.status === 503 ? 'server' : 'network');
      const data = await res.json();
      const jarvisMsg: Message = {
        id: (Date.now() + 1).toString(),
        sender: 'jarvis',
        text: data.text,
        audioUrl: data.audio || undefined,
        created_at: Date.now()
      };
      setMessages(prev => [...prev, jarvisMsg]);
      await saveMessageToDB(jarvisMsg, activeSessionId);
      setSessions(prev => prev.map(s => s.id === activeSessionId ? { ...s, updated_at: Date.now() } : s));
      if (data.audio) handlePlayAudio(jarvisMsg.id, data.audio);
      else speakWithBrowser(data.text);
    } catch (err: any) {
      setError({
        type: err.message === 'server' ? 'server' : 'network',
        message: err.message === 'server'
          ? '⚠️ जार्विस लोड होत आहे, कृपया थांबा.'
          : '🌐 नेटवर्क एरर! सर्व्हर बंद असण्याची शक्यता आहे.'
      });
    } finally {
      setLoading(false);
    }
  };

  const createNewChat = async () => {
    const newSession = await createSessionInDB('नवीन संभाषण (New Chat)');
    setSessions(prev => [newSession, ...prev]);
    setActiveSessionId(newSession.id);
    setMessages([]);
    localStorage.setItem('jarvis_active_session_id', newSession.id);
    setError({ type: null, message: '' });
    fetch(`${API}/api/reset-chat`, { method: 'POST' }).catch(() => {});
    setIsSidebarOpen(false);
    setShowSearch(false);
  };

  const selectSession = async (id: string) => {
    setActiveSessionId(id);
    localStorage.setItem('jarvis_active_session_id', id);
    setError({ type: null, message: '' });
    setShowSearch(false);
    setIsSidebarOpen(false);
    const msgs = await loadMessagesForSession(id);
    setMessages(msgs);
    fetch(`${API}/api/reset-chat`, { method: 'POST' }).catch(() => {});
  };

  const deleteChat = async (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await fetch(`${API}/api/history/sessions/${sessionId}`, { method: 'DELETE' }).catch(() => {});
    const updated = sessions.filter(s => s.id !== sessionId);
    if (updated.length === 0) {
      const fresh = await createSessionInDB('नवीन संभाषण (New Chat)');
      setSessions([fresh]); setActiveSessionId(fresh.id); setMessages([]);
    } else {
      setSessions(updated);
      if (activeSessionId === sessionId) {
        setActiveSessionId(updated[0].id);
        const msgs = await loadMessagesForSession(updated[0].id);
        setMessages(msgs);
      }
    }
  };

  const clearChat = async () => {
    setMessages([]);
    setError({ type: null, message: '' });
    fetch(`${API}/api/reset-chat`, { method: 'POST' }).catch(() => {});
  };

  const toggleListening = () => {
    if (!recognitionRef.current) {
      setError({ type: 'server', message: 'तुमच्या ब्राउझरमध्ये व्हॉईस सपोर्ट नाही.' });
      return;
    }
    if (isListening) {
      try { recognitionRef.current.stop(); } catch (_) {}
      setIsListening(false);
    } else {
      setError({ type: null, message: '' });
      try {
        recognitionRef.current.abort();
        recognitionRef.current.lang = speechLanguage;
        setTimeout(() => {
          try { setIsListening(true); recognitionRef.current.start(); }
          catch { setIsListening(false); setError({ type: 'server', message: 'मायक्रोफोन सुरू करण्यात अडचण.' }); }
        }, 100);
      } catch (_) {}
    }
  };

  const speakWithBrowser = (text: string) => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US'; u.rate = 0.92; u.pitch = 0.75;
    window.speechSynthesis.speak(u);
  };

  const handlePlayAudio = (messageId: string, audioDataUrl: string) => {
    if (playingAudioId === messageId) {
      audioRef.current?.pause();
      setPlayingAudioId(null);
    } else {
      audioRef.current?.pause();
      audioRef.current = new Audio(audioDataUrl);
      setPlayingAudioId(messageId);
      audioRef.current.play();
      audioRef.current.onended = () => setPlayingAudioId(null);
    }
  };

  const triggerDownload = async (type: 'llm' | 'tts') => {
    const url = type === 'llm' ? llmUrl : ttsUrl;
    if (!url.trim()) { alert('कृपया योग्य डाउनलोड लिंक टाका.'); return; }
    try {
      const res = await fetch(`${API}/api/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, url })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'failed');
      if (downloadPollRef.current) clearInterval(downloadPollRef.current);
      downloadPollRef.current = setInterval(checkDownloadStatus, 1500);
    } catch (err: any) { alert('एरर: ' + err.message); }
  };

  const triggerInit = async () => {
    try {
      setSystemState('loading');
      await fetch(`${API}/api/init-models`, { method: 'POST' });
      if (statusPollRef.current) clearInterval(statusPollRef.current);
      statusPollRef.current = setInterval(checkSystemStatus, 2000);
    } catch { setSystemState('error'); setSystemErrorMessage('सिस्टम सुरू करताना एरर.'); }
  };

  const toggleGroup = (label: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      next.has(label) ? next.delete(label) : next.add(label);
      return next;
    });
  };

  // ── Accent color shortcuts ────────────────────────────────────────────────
  const ac = 'violet'; // tailwind color key

  // ── SETUP SCREENS ─────────────────────────────────────────────────────────

  if (systemState === 'checking') return (
    <div className={`flex flex-col h-screen font-mono items-center justify-center cyber-grid ${theme === 'dark' ? 'bg-slate-950 text-violet-400' : 'bg-violet-50 text-violet-700'}`}>
      <RefreshCw className="animate-spin text-violet-500" size={48} />
      <p className="text-sm tracking-wider text-violet-500/80 mt-4">CORE PROTOCOLS RESOLVING...</p>
    </div>
  );

  if (systemState === 'uninitialized') return (
    <div className={`flex flex-col h-screen font-mono cyber-grid overflow-y-auto p-6 ${theme === 'dark' ? 'bg-slate-950 text-violet-400' : 'bg-violet-50 text-violet-700'}`}>
      <div className="max-w-4xl mx-auto w-full py-8 space-y-6">
        <header className="glass-panel p-6 rounded-2xl text-center space-y-2">
          <h1 className="text-2xl font-bold tracking-widest bg-clip-text text-transparent bg-gradient-to-r from-violet-400 to-purple-500">JARVIS // INSTALLATION PROTOCOL v2.5</h1>
          <p className="text-xs opacity-60">जार्विस ऑफलाईन मेंदू सक्रिय करण्यासाठी मॉडेल डाउनलोड करा.</p>
        </header>
        <div className="grid md:grid-cols-2 gap-6">
          {/* LLM Card */}
          <div className="glass-panel p-6 rounded-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-violet-500/10 pb-2">
              <div className="flex items-center gap-2"><Cpu size={18} className="text-violet-400" /><h2 className="font-bold text-sm tracking-wider">1. LLM (Qwen-7B)</h2></div>
              {llmExists ? <span className="text-xs bg-violet-950 text-violet-400 border border-violet-500/30 px-2 py-0.5 rounded">Downloaded</span> : <span className="text-xs bg-red-950/40 text-red-400 border border-red-500/20 px-2 py-0.5 rounded">Missing</span>}
            </div>
            <p className="text-xs opacity-60">हा जार्विसचा मुख्य मेंदू आहे (साधारण ४.७ GB GGUF 4-Bit).</p>
            <input type="text" value={llmUrl} onChange={e => setLlmUrl(e.target.value)} disabled={downloadProgress.llm.active} className="w-full bg-slate-900 border border-violet-500/20 rounded px-3 py-1.5 text-xs text-slate-300 focus:outline-none focus:border-violet-400" />
            {downloadProgress.llm.active && <div className="w-full bg-slate-900 h-2 rounded overflow-hidden"><div className="shimmer-bar h-full" style={{ width: `${downloadProgress.llm.percent}%` }} /></div>}
            <button onClick={() => triggerDownload('llm')} disabled={downloadProgress.llm.active || llmExists} className="w-full bg-violet-950/40 hover:bg-violet-950 text-violet-400 border border-violet-500/30 py-2.5 rounded-xl text-xs font-semibold transition-all disabled:opacity-30 disabled:pointer-events-none flex items-center justify-center gap-2">
              {llmExists ? <CheckCircle size={14} /> : <Download size={14} />}{llmExists ? 'MODEL INSTALLED' : 'DOWNLOAD & INSTALL'}
            </button>
          </div>
          {/* TTS Card */}
          <div className="glass-panel p-6 rounded-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-violet-500/10 pb-2">
              <div className="flex items-center gap-2"><Activity size={18} className="text-violet-400" /><h2 className="font-bold text-sm tracking-wider">2. TTS (Supertonic)</h2></div>
              {ttsExists ? <span className="text-xs bg-violet-950 text-violet-400 border border-violet-500/30 px-2 py-0.5 rounded">Downloaded</span> : <span className="text-xs bg-red-950/40 text-red-400 border border-red-500/20 px-2 py-0.5 rounded">Missing</span>}
            </div>
            <p className="text-xs opacity-60">जार्विसला AI आवाज देतो. <span className="text-violet-400">नसेल तरी ब्राऊझर TTS वापरला जाईल ✅</span></p>
            <input type="text" placeholder="https://huggingface.co/.../model.gguf" value={ttsUrl} onChange={e => setTtsUrl(e.target.value)} disabled={downloadProgress.tts.active} className="w-full bg-slate-900 border border-violet-500/20 rounded px-3 py-1.5 text-xs text-slate-300 focus:outline-none focus:border-violet-400" />
            {downloadProgress.tts.active && <div className="w-full bg-slate-900 h-2 rounded overflow-hidden"><div className="shimmer-bar h-full" style={{ width: `${downloadProgress.tts.percent}%` }} /></div>}
            <button onClick={() => triggerDownload('tts')} disabled={downloadProgress.tts.active || ttsExists} className="w-full bg-violet-950/40 hover:bg-violet-950 text-violet-400 border border-violet-500/30 py-2.5 rounded-xl text-xs font-semibold transition-all disabled:opacity-30 disabled:pointer-events-none flex items-center justify-center gap-2">
              {ttsExists ? <CheckCircle size={14} /> : <Download size={14} />}{ttsExists ? 'MODEL INSTALLED' : 'DOWNLOAD & INSTALL'}
            </button>
          </div>
        </div>
        {llmExists && (
          <div className="glass-panel p-6 rounded-2xl text-center space-y-4">
            <p className="text-xs opacity-80">{ttsExists ? '🎉 दोन्ही मॉडेल्स तयार! आता जार्विस सुरू करा.' : '✅ LLM तयार! TTS नसेल तरी ब्राऊझर आवाज वापरला जाईल. जार्विस सुरू करा.'}</p>
            <button onClick={triggerInit} className="bg-gradient-to-r from-violet-500 to-purple-600 hover:from-violet-400 hover:to-purple-500 text-white font-bold px-8 py-3.5 rounded-xl text-sm tracking-widest transition-all">INITIALIZE JARVIS SYSTEM</button>
          </div>
        )}
      </div>
    </div>
  );

  if (systemState === 'loading') return (
    <div className={`flex flex-col h-screen font-mono items-center justify-center cyber-grid p-6 ${theme === 'dark' ? 'bg-slate-950 text-violet-400' : 'bg-violet-50 text-violet-700'}`}>
      <div className="max-w-md w-full glass-panel p-8 rounded-2xl text-center space-y-4">
        <div className="flex items-center justify-center gap-3">
          <span className="dot-1 w-4 h-4 bg-violet-500 rounded-full" />
          <span className="dot-2 w-4 h-4 bg-violet-400 rounded-full" />
          <span className="dot-3 w-4 h-4 bg-violet-300 rounded-full" />
        </div>
        <h2 className="text-lg font-bold tracking-widest">LOADING CORE MEMORY...</h2>
        <p className="text-xs opacity-60">जार्विस GGUF मॉडेल RAM वर लोड करत आहे. १-२ मिनिटे लागतील...</p>
      </div>
    </div>
  );

  if (systemState === 'error') return (
    <div className={`flex flex-col h-screen font-mono items-center justify-center cyber-grid p-6 ${theme === 'dark' ? 'bg-slate-950 text-violet-400' : 'bg-violet-50 text-violet-700'}`}>
      <div className="max-w-md w-full glass-panel p-8 rounded-2xl border border-red-500/20 text-center space-y-4">
        <AlertCircle className="text-red-400 mx-auto" size={48} />
        <h2 className="text-lg font-bold text-red-400">CORE FAULT DETECTED</h2>
        <p className="text-xs opacity-70">{systemErrorMessage || 'सिस्टम सुरू करताना एरर.'}</p>
        <button onClick={checkSystemStatus} className="w-full bg-red-950/40 text-red-400 border border-red-500/30 py-2.5 rounded-xl text-xs font-semibold transition-all">RETRY CONNECTION</button>
      </div>
    </div>
  );

  // ── MAIN CHAT UI ──────────────────────────────────────────────────────────
  const groupedSessions = groupSessionsByDate(sessions);
  const isDark = theme === 'dark';

  return (
    <div className={`flex flex-col h-screen font-mono overflow-hidden cyber-grid ${isDark ? 'bg-slate-950 text-violet-300' : 'bg-violet-50 text-violet-900'}`}>

      {/* STATUS BAR */}
      <StatusBar info={systemInfo} />

      <div className="flex flex-1 overflow-hidden">

        {/* SIDEBAR */}
        <aside className={`
          fixed inset-y-0 left-0 z-50 w-72 flex flex-col transition-transform duration-300 backdrop-blur-md
          md:static md:translate-x-0 md:z-auto
          ${isDark ? 'bg-slate-900/95 border-r border-violet-500/20' : 'bg-white/90 border-r border-violet-300/40'}
          ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'}
        `}>
          {/* Sidebar Header */}
          <div className={`flex items-center justify-between px-4 py-4 border-b ${isDark ? 'border-violet-500/20' : 'border-violet-200'}`}>
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-full bg-gradient-to-br from-violet-500 to-purple-700 flex items-center justify-center avatar-glow">
                <Bot size={13} className="text-white" />
              </div>
              <span className={`text-xs font-bold tracking-widest ${isDark ? 'text-violet-300' : 'text-violet-700'}`}>SYSTEM CONTEXTS</span>
            </div>
            <button onClick={() => setIsSidebarOpen(false)} className="md:hidden p-1.5 text-violet-400 hover:bg-slate-800 rounded-lg"><X size={18} /></button>
          </div>

          {/* New Chat + Search Toggle */}
          <div className="p-3 space-y-2">
            <button onClick={createNewChat} className={`w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl border font-bold text-xs tracking-wider transition-all ${isDark ? 'border-violet-500/30 hover:border-violet-400 bg-violet-950/20 hover:bg-violet-950/40 text-violet-400' : 'border-violet-300 hover:border-violet-500 bg-violet-50 hover:bg-violet-100 text-violet-700'}`}>
              <Plus size={15} /> नवीन संभाषण
            </button>
            <button onClick={() => { setShowSearch(s => !s); setSearchQuery(''); setSearchResults([]); }} className={`w-full flex items-center justify-center gap-2 py-2 px-4 rounded-xl border text-xs font-semibold transition-all ${showSearch ? (isDark ? 'bg-violet-950/30 border-violet-500/40 text-violet-300' : 'bg-violet-100 border-violet-400 text-violet-700') : (isDark ? 'bg-slate-950/40 border-slate-700 text-slate-400 hover:text-violet-400 hover:border-violet-500/30' : 'bg-slate-100 border-slate-300 text-slate-500 hover:text-violet-600 hover:border-violet-300')}`}>
              <Search size={14} /> {showSearch ? 'बंद करा' : 'History शोधा'}
            </button>
          </div>

          {/* Search Panel */}
          {showSearch && (
            <div className="px-3 pb-2 space-y-2">
              <div className="relative">
                <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
                <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
                  placeholder="संभाषण शोधा..."
                  className={`w-full border rounded-lg pl-7 pr-3 py-2 text-xs placeholder-slate-500 focus:outline-none focus:border-violet-400 ${isDark ? 'bg-slate-950 border-violet-500/20 text-slate-200' : 'bg-white border-violet-200 text-slate-800'}`}
                  autoFocus />
              </div>
              {isSearching && <p className="text-[10px] text-slate-500 px-1">शोधत आहे...</p>}
              {searchResults.length > 0 && (
                <div className="space-y-1 max-h-56 overflow-y-auto">
                  {searchResults.map(r => (
                    <div key={r.id} onClick={() => selectSession(r.session_id)}
                      className={`p-2 rounded-lg border cursor-pointer transition-all group ${isDark ? 'bg-slate-950/60 border-slate-800 hover:border-violet-500/30' : 'bg-violet-50 border-violet-100 hover:border-violet-300'}`}>
                      <div className="flex items-center gap-1 mb-0.5">
                        <span className="text-[9px] text-violet-500/70 uppercase font-bold tracking-wider">{r.session_title}</span>
                        <span className="text-[9px] text-slate-600 ml-auto">{formatTime(r.created_at)}</span>
                      </div>
                      <p className="text-[10px] text-slate-400 group-hover:text-slate-300 line-clamp-2">{r.text}</p>
                    </div>
                  ))}
                </div>
              )}
              {!isSearching && searchQuery.trim().length >= 2 && searchResults.length === 0 && (
                <p className="text-[10px] text-slate-500 px-1">कोणतेही परिणाम सापडले नाहीत.</p>
              )}
            </div>
          )}

          {/* Date-grouped Sessions List */}
          <div className="flex-1 overflow-y-auto px-3 pb-4 space-y-3">
            {groupedSessions.map(({ label, sessions: group }) => (
              <div key={label}>
                <button onClick={() => toggleGroup(label)} className={`w-full flex items-center gap-1.5 px-1 py-1 text-[10px] font-bold uppercase tracking-widest transition-colors ${isDark ? 'text-violet-500/60 hover:text-violet-400' : 'text-violet-400 hover:text-violet-600'}`}>
                  <Calendar size={10} />
                  <span className="flex-1 text-left">{label}</span>
                  {collapsedGroups.has(label) ? <ChevronRight size={10} /> : <ChevronDown size={10} />}
                </button>
                {!collapsedGroups.has(label) && (
                  <div className="space-y-1">
                    {group.map(session => (
                      <div key={session.id} onClick={() => selectSession(session.id)}
                        className={`group flex items-center justify-between px-3 py-2.5 rounded-xl border text-xs cursor-pointer transition-all duration-200 ${session.id === activeSessionId
                          ? (isDark ? 'bg-violet-950/30 border-violet-500/50 text-violet-300' : 'bg-violet-100 border-violet-400 text-violet-700')
                          : (isDark ? 'bg-slate-950/40 border-slate-800/80 text-slate-400 hover:text-violet-400 hover:border-violet-500/20 hover:bg-violet-950/10' : 'bg-white border-slate-200 text-slate-500 hover:text-violet-600 hover:border-violet-200 hover:bg-violet-50')}`}>
                        <div className="flex items-center gap-2 truncate pr-2 flex-1 min-w-0">
                          <MessageSquare size={12} className={session.id === activeSessionId ? 'text-violet-400 shrink-0' : 'text-slate-500 group-hover:text-violet-500 shrink-0'} />
                          <div className="truncate min-w-0">
                            <p className="truncate text-[11px]">{session.title}</p>
                            <p className="text-[9px] text-slate-500">{formatTime(session.updated_at)}</p>
                          </div>
                        </div>
                        <button onClick={e => deleteChat(session.id, e)} className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-slate-800 text-slate-500 hover:text-red-400 transition-all shrink-0">
                          <Trash2 size={11} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </aside>

        {/* Mobile Backdrop */}
        {isSidebarOpen && <div onClick={() => setIsSidebarOpen(false)} className="fixed inset-0 z-40 bg-slate-950/60 backdrop-blur-sm md:hidden" />}

        {/* MAIN CHAT AREA */}
        <div className="flex-1 flex flex-col h-full overflow-hidden">

          {/* Header */}
          <header className={`flex items-center justify-between px-4 md:px-6 py-3.5 border-b backdrop-blur ${isDark ? 'bg-slate-900/60 border-violet-500/10' : 'bg-white/80 border-violet-200'}`}>
            <div className="flex items-center gap-3">
              <button onClick={() => setIsSidebarOpen(true)} className={`md:hidden p-2 rounded-lg border ${isDark ? 'text-violet-400 hover:bg-slate-800 border-violet-500/20' : 'text-violet-600 hover:bg-violet-100 border-violet-200'}`}><Menu size={18} /></button>
              {/* Animated Jarvis Avatar */}
              <div className="w-9 h-9 rounded-full bg-gradient-to-br from-violet-500 to-purple-700 flex items-center justify-center avatar-glow shrink-0">
                <Bot size={18} className="text-white" />
              </div>
              <div>
                <h1 className="text-base md:text-lg font-bold tracking-widest text-transparent bg-clip-text bg-gradient-to-r from-violet-400 to-purple-500">JARVIS</h1>
                <p className="text-[9px] opacity-50 tracking-widest">CORE PROTOCOL v2.5</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {/* Dark/Light toggle */}
              <button onClick={toggleTheme} className={`p-2 rounded-lg border transition-all ${isDark ? 'bg-slate-800 border-violet-500/20 text-violet-400 hover:text-yellow-300' : 'bg-violet-100 border-violet-300 text-violet-600 hover:text-yellow-600'}`} title="Theme बदला">
                {isDark ? <Sun size={16} /> : <Moon size={16} />}
              </button>
              <button onClick={clearChat} className={`p-2 rounded-lg border transition-all ${isDark ? 'hover:bg-slate-800/80 border-violet-500/20 text-violet-500 hover:text-violet-400' : 'hover:bg-violet-100 border-violet-300 text-violet-500'}`} title="क्लियर चॅट">
                <RotateCcw size={16} />
              </button>
            </div>
          </header>

          {/* Messages */}
          <main className="flex-1 overflow-y-auto p-4 md:p-6 space-y-5">
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full text-center max-w-md mx-auto">
                <div className="w-20 h-20 rounded-full bg-gradient-to-br from-violet-600 to-purple-800 flex items-center justify-center mb-4 avatar-glow">
                  <Bot size={40} className="text-white" />
                </div>
                <p className={`text-lg font-semibold tracking-wider ${isDark ? 'text-violet-500/60' : 'text-violet-400'}`}>प्रणाली सक्रिय आहे.</p>
                <p className={`text-xs mt-1 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>आदेशाची वाट पाहत आहे...</p>
                <p className={`text-xs mt-3 border-t pt-2 w-full ${isDark ? 'text-slate-600 border-violet-500/10' : 'text-slate-400 border-violet-200'}`}>टाईप करा किंवा माईक बटण दाबून बोला.</p>
              </div>
            )}

            {messages.map(msg => (
              <div key={msg.id} className={`flex gap-3 max-w-[92%] md:max-w-[80%] ${msg.sender === 'user' ? 'ml-auto flex-row-reverse' : 'mr-auto'}`}>

                {/* Avatar */}
                <div className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${
                  msg.sender === 'user'
                    ? (isDark ? 'bg-violet-950 border border-violet-500' : 'bg-violet-200 border border-violet-400')
                    : 'bg-gradient-to-br from-violet-500 to-purple-700 avatar-glow'
                }`}>
                  {msg.sender === 'user'
                    ? <User size={15} className={isDark ? 'text-violet-300' : 'text-violet-700'} />
                    : <Bot size={15} className="text-white" />
                  }
                </div>

                {/* Bubble */}
                <div className={`relative msg-bubble p-4 rounded-2xl ${
                  msg.sender === 'user'
                    ? (isDark ? 'bg-violet-950/40 border border-violet-500/40 text-violet-100 rounded-tr-none' : 'bg-violet-100 border border-violet-300 text-violet-900 rounded-tr-none')
                    : `glass-panel rounded-tl-none ${isDark ? 'text-slate-200' : 'text-slate-800'}`
                }`}>
                  {/* Tool Badges — only for Jarvis */}
                  {msg.sender === 'jarvis' && <ToolBadges text={msg.text} />}

                  <div className="prose max-w-none text-sm leading-relaxed">
                    <ReactMarkdown>{msg.text}</ReactMarkdown>
                  </div>

                  {msg.created_at && <p className={`text-[9px] mt-1 text-right ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>{formatTime(msg.created_at)}</p>}

                  {/* Audio button */}
                  {msg.audioUrl && (
                    <div className="mt-3 pt-2 border-t border-slate-800/60">
                      <button onClick={() => handlePlayAudio(msg.id, msg.audioUrl!)} className={`flex items-center gap-2 text-xs px-3 py-1.5 rounded-lg border transition-all ${isDark ? 'bg-slate-900/80 hover:bg-slate-800 text-violet-400 border-violet-500/20' : 'bg-violet-50 hover:bg-violet-100 text-violet-600 border-violet-200'}`}>
                        {playingAudioId === msg.id ? <Pause size={12} className="text-red-400" /> : <Play size={12} />}
                        {playingAudioId === msg.id ? 'PAUSE' : 'REPLAY VOICE'}
                      </button>
                    </div>
                  )}

                  {/* Copy Button */}
                  <CopyButton text={msg.text} />
                </div>
              </div>
            ))}

            {/* Typing Animation */}
            {loading && (
              <div className="flex gap-3 max-w-[80%] mr-auto items-center">
                <div className="w-9 h-9 rounded-full bg-gradient-to-br from-violet-500 to-purple-700 avatar-glow flex items-center justify-center">
                  <Bot size={15} className="text-white" />
                </div>
                <div className={`glass-panel p-4 rounded-2xl rounded-tl-none flex gap-2 items-center ${isDark ? '' : 'bg-white/80'}`}>
                  <span className="dot-1 w-2.5 h-2.5 bg-violet-400 rounded-full" />
                  <span className="dot-2 w-2.5 h-2.5 bg-violet-500 rounded-full" />
                  <span className="dot-3 w-2.5 h-2.5 bg-violet-600 rounded-full" />
                  <span className={`text-xs ml-1 ${isDark ? 'text-violet-500/60' : 'text-violet-400'}`}>विचार करत आहे...</span>
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </main>

          {/* Error */}
          {error.message && (
            <div className={`mx-6 my-2 p-3 rounded-lg flex items-center gap-3 text-sm border ${error.type === 'network' ? 'bg-red-950/40 border-red-500/30 text-red-400' : 'bg-amber-950/40 border-amber-500/30 text-amber-400'}`}>
              <AlertCircle size={18} className="shrink-0" />
              <p className="flex-1 font-semibold">{error.message}</p>
            </div>
          )}

          {/* Input */}
          <footer className={`p-4 md:p-5 border-t backdrop-blur ${isDark ? 'glass-panel border-violet-500/20' : 'bg-white/90 border-violet-200'}`}>
            <div className="max-w-4xl mx-auto flex gap-3">
              <button onClick={toggleListening} className={`p-3.5 rounded-xl border transition-all shrink-0 ${isListening ? 'bg-red-600/90 border-red-500 text-white shadow-[0_0_15px_rgba(239,68,68,0.5)]' : (isDark ? 'bg-slate-900 border-violet-500/40 text-violet-400 hover:border-violet-500/70' : 'bg-violet-50 border-violet-300 text-violet-600 hover:border-violet-500')}`} title={isListening ? 'ऐकणे थांबवा' : 'बोला'}>
                {isListening ? <MicOff size={22} className="animate-pulse" /> : <Mic size={22} />}
              </button>
              <button onClick={() => setSpeechLanguage(p => p === 'mr-IN' ? 'en-US' : 'mr-IN')} className={`px-3 rounded-xl border transition-all shrink-0 font-bold text-xs ${isDark ? (speechLanguage === 'mr-IN' ? 'bg-violet-950/40 border-violet-500/30 text-violet-400' : 'bg-blue-950/40 border-blue-500/30 text-blue-400') : (speechLanguage === 'mr-IN' ? 'bg-violet-100 border-violet-300 text-violet-700' : 'bg-blue-50 border-blue-300 text-blue-600')}`}>
                {speechLanguage === 'mr-IN' ? 'मराठी' : 'ENG'}
              </button>
              <input type="text" value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleSendMessage()}
                placeholder={isListening ? 'ऐकत आहे...' : 'तुमचा आदेश टाईप करा...'}
                disabled={isListening}
                className={`flex-1 border rounded-xl px-4 text-sm md:text-base focus:outline-none transition-all ${isDark ? 'bg-slate-950/80 border-violet-500/30 text-slate-100 placeholder-slate-500 focus:border-violet-400' : 'bg-white border-violet-300 text-slate-800 placeholder-slate-400 focus:border-violet-500'}`} />
              <button onClick={handleSendMessage} disabled={loading || !input.trim()} className="p-3.5 bg-gradient-to-r from-violet-500 to-purple-600 hover:from-violet-400 hover:to-purple-500 text-white font-bold rounded-xl disabled:opacity-30 disabled:pointer-events-none transition-all shadow-[0_0_15px_rgba(139,92,246,0.4)]">
                <Send size={18} />
              </button>
            </div>
          </footer>
        </div>
      </div>
    </div>
  );
}
