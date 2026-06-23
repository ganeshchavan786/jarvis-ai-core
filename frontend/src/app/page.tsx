'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import {
  Mic, MicOff, Send, Play, Pause, AlertCircle, Bot, User,
  RotateCcw, Download, Cpu, Activity, CheckCircle, RefreshCw,
  Plus, Trash2, Menu, X, MessageSquare, Search, Calendar, ChevronDown, ChevronRight,
  FolderOpen, FileCode, Terminal, ChevronUp, Eye, FolderClosed, Code, RefreshCcw, Settings
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

// ── Workspace Visualizer Types ───────────────────────────────────────────────

interface WorkspaceFile {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size?: number;
  modified?: number;
  children?: WorkspaceFile[];
}

// ── Workspace File Tree Node ──────────────────────────────────────────────────
function FileTreeNode({
  node, depth = 0, onSelect, selectedPath
}: {
  node: WorkspaceFile;
  depth?: number;
  onSelect: (path: string) => void;
  selectedPath: string;
}) {
  const [open, setOpen] = useState(depth < 2);
  const isSelected = node.path === selectedPath;

  const ext = node.name.split('.').pop()?.toLowerCase() || '';
  const iconColor = {
    py: 'text-yellow-400', js: 'text-yellow-300', ts: 'text-blue-400',
    tsx: 'text-blue-300', json: 'text-green-400', md: 'text-slate-300',
    txt: 'text-slate-400', sh: 'text-green-300', css: 'text-pink-400'
  }[ext] || 'text-slate-400';

  if (node.type === 'dir') {
    return (
      <div>
        <button
          onClick={() => setOpen(o => !o)}
          className="flex items-center gap-1.5 w-full px-2 py-1 hover:bg-cyan-950/20 rounded text-left transition-colors"
          style={{ paddingLeft: `${8 + depth * 14}px` }}
        >
          {open ? <FolderOpen size={13} className="text-cyan-400 shrink-0" /> : <FolderClosed size={13} className="text-cyan-500/70 shrink-0" />}
          <span className="text-xs text-cyan-300/80 truncate">{node.name}</span>
          {open ? <ChevronUp size={10} className="ml-auto text-slate-600" /> : <ChevronDown size={10} className="ml-auto text-slate-600" />}
        </button>
        {open && node.children?.map(child => (
          <FileTreeNode key={child.path} node={child} depth={depth + 1} onSelect={onSelect} selectedPath={selectedPath} />
        ))}
      </div>
    );
  }

  return (
    <button
      onClick={() => onSelect(node.path)}
      className={`flex items-center gap-1.5 w-full px-2 py-1 rounded text-left transition-colors ${
        isSelected ? 'bg-cyan-950/40 border-l-2 border-cyan-400' : 'hover:bg-slate-800/40'
      }`}
      style={{ paddingLeft: `${8 + depth * 14}px` }}
    >
      <FileCode size={12} className={`${iconColor} shrink-0`} />
      <span className={`text-xs truncate ${isSelected ? 'text-cyan-300' : 'text-slate-400'}`}>{node.name}</span>
      {node.size !== undefined && <span className="ml-auto text-[9px] text-slate-600 shrink-0">{node.size < 1024 ? node.size + 'B' : (node.size/1024).toFixed(1) + 'KB'}</span>}
    </button>
  );
}

// ── Workspace Panel Component ─────────────────────────────────────────────────
function WorkspacePanel({ onClose }: { onClose: () => void }) {
  const [activeTab, setActiveTab] = useState<'files' | 'code' | 'terminal'>('files');
  const [fileTree, setFileTree] = useState<WorkspaceFile[]>([]);
  const [selectedFile, setSelectedFile] = useState('');
  const [fileContent, setFileContent] = useState('');
  const [fileExt, setFileExt] = useState('');
  const [execLog, setExecLog] = useState('');
  const [loading, setLoading] = useState(false);
  const terminalRef = useRef<HTMLDivElement>(null);

  const fetchTree = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API}/api/workspace/files`);
      const data = await res.json();
      setFileTree(data.tree || []);
    } catch { /* ignore */ }
    setLoading(false);
  };

  const fetchFile = async (filePath: string) => {
    setLoading(true);
    setSelectedFile(filePath);
    setActiveTab('code');
    try {
      const res = await fetch(`${API}/api/workspace/file?path=${encodeURIComponent(filePath)}`);
      const data = await res.json();
      setFileContent(data.content || '');
      setFileExt(data.ext || '');
    } catch { setFileContent('Error loading file.'); }
    setLoading(false);
  };

  const fetchLog = async () => {
    setLoading(true);
    setActiveTab('terminal');
    try {
      const res = await fetch(`${API}/api/workspace/execution-log`);
      const data = await res.json();
      setExecLog(data.log || '(कोणतेही commands चालवले नाहीत)');
    } catch { setExecLog('Error loading log.'); }
    setLoading(false);
    setTimeout(() => terminalRef.current?.scrollTo({ top: 9999, behavior: 'smooth' }), 100);
  };

  useEffect(() => { fetchTree(); }, []);

  // Auto-refresh every 5s
  useEffect(() => {
    const t = setInterval(() => {
      fetchTree();
      if (activeTab === 'terminal') fetchLog();
    }, 5000);
    return () => clearInterval(t);
  }, [activeTab]);

  return (
    <div className="flex flex-col h-full w-80 xl:w-96 border-l border-cyan-500/20 bg-slate-900/95 backdrop-blur-md shrink-0">
      {/* Panel Header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-cyan-500/15 bg-slate-950/60">
        <div className="flex items-center gap-2">
          <Code size={14} className="text-cyan-400" />
          <span className="text-xs font-bold tracking-widest text-cyan-300">WORKSPACE</span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={fetchTree} className="p-1 rounded hover:bg-slate-800 text-slate-500 hover:text-cyan-400 transition-colors" title="Refresh">
            <RefreshCcw size={13} />
          </button>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-800 text-slate-500 hover:text-red-400 transition-colors">
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-cyan-500/15">
        {([
          { key: 'files', icon: FolderOpen, label: 'Files' },
          { key: 'code',  icon: FileCode,   label: 'Code'  },
          { key: 'terminal', icon: Terminal, label: 'Terminal' }
        ] as const).map(({ key, icon: Icon, label }) => (
          <button key={key}
            onClick={() => key === 'terminal' ? fetchLog() : setActiveTab(key)}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-[10px] font-bold tracking-wider transition-colors ${
              activeTab === key
                ? 'text-cyan-400 border-b-2 border-cyan-400 bg-cyan-950/20'
                : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            <Icon size={11} /> {label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-hidden">

        {/* FILES TAB */}
        {activeTab === 'files' && (
          <div className="h-full overflow-y-auto py-1">
            {loading && <p className="text-[10px] text-slate-500 px-3 py-2">Loading...</p>}
            {!loading && fileTree.length === 0 && (
              <p className="text-[10px] text-slate-600 px-3 py-4 text-center">Workspace रिकामी आहे.<br/>जार्विसला code लिहायला सांगा!</p>
            )}
            {fileTree.map(node => (
              <FileTreeNode key={node.path} node={node} onSelect={fetchFile} selectedPath={selectedFile} />
            ))}
          </div>
        )}

        {/* CODE TAB */}
        {activeTab === 'code' && (
          <div className="h-full flex flex-col">
            {selectedFile && (
              <div className="px-3 py-1.5 bg-slate-950/60 border-b border-cyan-500/10 flex items-center gap-2">
                <FileCode size={11} className="text-cyan-500 shrink-0" />
                <span className="text-[10px] text-slate-400 truncate">{selectedFile}</span>
              </div>
            )}
            <div className="flex-1 overflow-y-auto">
              {loading && <p className="text-[10px] text-slate-500 px-3 py-4">Loading...</p>}
              {!loading && !selectedFile && (
                <p className="text-[10px] text-slate-600 px-3 py-4 text-center">Files tab मधून file select करा</p>
              )}
              {!loading && fileContent && (
                <pre className="text-[10px] leading-relaxed text-slate-300 p-3 font-mono whitespace-pre-wrap break-all">{fileContent}</pre>
              )}
            </div>
          </div>
        )}

        {/* TERMINAL TAB */}
        {activeTab === 'terminal' && (
          <div ref={terminalRef} className="h-full overflow-y-auto bg-black/40 font-mono">
            {loading && <p className="text-[10px] text-green-500/60 px-3 py-4">Loading...</p>}
            {!loading && (
              <pre className="text-[10px] leading-relaxed text-green-400/80 p-3 whitespace-pre-wrap break-all">
                {execLog || '(कोणतेही commands चालवले नाहीत)'}
              </pre>
            )}
          </div>
        )}
      </div>

      {/* Status Bar */}
      <div className="px-3 py-1.5 border-t border-cyan-500/10 bg-slate-950/60 flex items-center gap-2">
        <span className="text-[9px] text-slate-600">
          {fileTree.length > 0 ? `${fileTree.length} items` : 'Empty'}
        </span>
        {selectedFile && <span className="text-[9px] text-cyan-500/60 truncate ml-auto">{selectedFile}</span>}
      </div>
    </div>
  );
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

// ── Main Component ─────────────────────────────────────────────────────────────

export default function JarvisAdvancedUI() {
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

  // Workspace Visualizer
  const [showWorkspace, setShowWorkspace] = useState(false);

  // Search
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const searchDebounceRef = useRef<NodeJS.Timeout | null>(null);

  // Collapsed date groups
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  // Settings States
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [braveSearchKey, setBraveSearchKey] = useState('');
  const [githubToken, setGithubToken] = useState('');
  const [keysStatus, setKeysStatus] = useState({ braveSearchKeyExists: false, githubTokenExists: false });
  const [isSavingKeys, setIsSavingKeys] = useState(false);

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

  // ── System Status ────────────────────────────────────────────────────────────

  const checkSystemStatus = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/system/status`);
      if (!res.ok) throw new Error('offline');
      const data = await res.json();
      setSystemState(data.status);
      setSystemErrorMessage(data.error || '');
      setLlmExists(data.llmExists);
      setTtsExists(data.ttsExists);
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

  // ── Settings Keys Status & Operations ────────────────────────────────────────

  const fetchKeysStatus = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/settings/keys`);
      if (res.ok) {
        const data = await res.json();
        setKeysStatus(data);
      }
    } catch (err) {
      console.error('Error fetching settings keys status:', err);
    }
  }, []);

  const saveKeys = async () => {
    setIsSavingKeys(true);
    try {
      const res = await fetch(`${API}/api/settings/keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          braveSearchKey: braveSearchKey,
          githubToken: githubToken
        })
      });
      if (res.ok) {
        setBraveSearchKey('');
        setGithubToken('');
        await fetchKeysStatus();
        setIsSettingsOpen(false);
      } else {
        alert('की सेव्ह करताना त्रुटी आली. कृपया पुन्हा प्रयत्न करा.');
      }
    } catch (err) {
      console.error('Error saving keys:', err);
      alert('बॅकएंडशी संपर्क साधताना त्रुटी आली.');
    } finally {
      setIsSavingKeys(false);
    }
  };

  useEffect(() => {
    if (isSettingsOpen) {
      fetchKeysStatus();
    }
  }, [isSettingsOpen, fetchKeysStatus]);

  // ── SQLite History Sync ──────────────────────────────────────────────────────

  const loadSessionsFromDB = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/history/sessions`);
      if (!res.ok) throw new Error('failed');
      const data = await res.json();
      const dbSessions: ChatSession[] = (data.sessions || []).map((s: any) => ({
        id: s.id,
        title: s.title,
        created_at: s.created_at,
        updated_at: s.updated_at,
        messages: []
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
      // Fallback to localStorage if DB unavailable
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
    sessionId: string,
    currentSessions?: ChatSession[],
    setActive?: boolean
  ) => {
    try {
      const res = await fetch(`${API}/api/history/sessions/${sessionId}/messages`);
      if (!res.ok) throw new Error('failed');
      const data = await res.json();
      const msgs: Message[] = (data.messages || []).map((m: any) => ({
        id: m.id,
        sender: m.sender,
        text: m.text,
        audioUrl: m.audio_url || undefined,
        created_at: m.created_at
      }));
      if (setActive) setMessages(msgs);
      if (currentSessions) {
        setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, messages: msgs } : s));
      }
      return msgs;
    } catch {
      return [];
    }
  };

  const saveMessageToDB = async (msg: Message, sessionId: string) => {
    await fetch(`${API}/api/history/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: msg.id,
        session_id: sessionId,
        sender: msg.sender,
        text: msg.text,
        audio_url: msg.audioUrl || null,
        created_at: msg.created_at || Date.now()
      })
    }).catch(() => {});
  };

  const updateSessionTitle = async (sessionId: string, title: string) => {
    await fetch(`${API}/api/history/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: sessionId, title })
    }).catch(() => {});
  };

  const fallbackLoadFromLocalStorage = () => {
    if (typeof window === 'undefined') return;
    try {
      const sessionsStr = localStorage.getItem('jarvis_chat_sessions');
      let savedSessions: ChatSession[] = sessionsStr ? JSON.parse(sessionsStr) : [];
      if (savedSessions.length === 0) {
        const d: ChatSession = { id: Date.now().toString(), title: 'नवीन संभाषण', created_at: Date.now(), updated_at: Date.now(), messages: [] };
        savedSessions = [d];
      }
      setSessions(savedSessions);
      const lastActive = localStorage.getItem('jarvis_active_session_id') || savedSessions[0].id;
      setActiveSessionId(lastActive);
      const active = savedSessions.find(s => s.id === lastActive);
      if (active) setMessages(active.messages);
    } catch { /* ignore */ }
    hasLoadedRef.current = true;
  };

  // ── Search ───────────────────────────────────────────────────────────────────

  const handleSearch = useCallback(async (q: string) => {
    if (q.trim().length < 2) { setSearchResults([]); return; }
    setIsSearching(true);
    try {
      const res = await fetch(`${API}/api/history/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      setSearchResults(data.results || []);
    } catch { setSearchResults([]); }
    setIsSearching(false);
  }, []);

  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => handleSearch(searchQuery), 350);
  }, [searchQuery, handleSearch]);

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  useEffect(() => {
    loadSessionsFromDB();
    checkSystemStatus();
    fetchKeysStatus();
    statusPollRef.current = setInterval(checkSystemStatus, 3000);
    return () => {
      if (statusPollRef.current) clearInterval(statusPollRef.current);
      if (downloadPollRef.current) clearInterval(downloadPollRef.current);
    };
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  useEffect(() => {
    const isDownloading = downloadProgress.llm.active || downloadProgress.tts.active;
    if (isDownloading && !downloadPollRef.current) {
      downloadPollRef.current = setInterval(checkDownloadStatus, 1500);
    }
  }, [downloadProgress]);

  // Speech Recognition
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return;
    const recognition = new SR();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = speechLanguage;
    recognition.onresult = (e: any) => { setInput(e.results[0][0].transcript); setIsListening(false); };
    recognition.onerror = (e: any) => {
      setIsListening(false);
      const msgs: Record<string, string> = {
        'not-allowed': 'मायक्रोफोन परवानगी नाकारली.',
        'no-speech': 'आवाज ऐकू आला नाही.',
        'network': 'नेटवर्क एरर.',
        'aborted': 'व्हॉईस इनपुट थांबवले.'
      };
      setError({ type: 'server', message: msgs[e.error] || `व्हॉईस एरर: ${e.error}` });
    };
    recognition.onend = () => setIsListening(false);
    recognitionRef.current = recognition;
  }, [speechLanguage]);

  // ── Chat Actions ─────────────────────────────────────────────────────────────

  const handleSendMessage = async () => {
    if (!input.trim() || loading) return;
    setError({ type: null, message: '' });
    const now = Date.now();
    const userMsg: Message = { id: now.toString(), sender: 'user', text: input.trim(), created_at: now };
    const userPrompt = input.trim();

    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setLoading(true);

    // Auto-title session from first message
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
      setSessions([fresh]);
      setActiveSessionId(fresh.id);
      setMessages([]);
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
      checkDownloadStatus();
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

  // ── SETUP SCREENS ─────────────────────────────────────────────────────────────

  if (systemState === 'checking') return (
    <div className="flex flex-col h-screen bg-slate-950 text-cyan-400 font-mono items-center justify-center cyber-grid">
      <RefreshCw className="animate-spin text-cyan-500" size={48} />
      <p className="text-sm tracking-wider text-cyan-500/80 mt-4">CORE PROTOCOLS RESOLVING...</p>
    </div>
  );

  if (systemState === 'uninitialized') return (
    <div className="flex flex-col h-screen bg-slate-950 text-cyan-400 font-mono cyber-grid overflow-y-auto p-6">
      <div className="max-w-4xl mx-auto w-full py-8 space-y-6">
        <header className="glass-panel p-6 rounded-2xl border border-cyan-500/20 text-center space-y-2">
          <h1 className="text-2xl font-bold tracking-widest bg-clip-text text-transparent bg-gradient-to-r from-cyan-400 to-blue-500">JARVIS // INSTALLATION PROTOCOL v2.5</h1>
          <p className="text-xs text-slate-500">जार्विस ऑफलाईन मेंदू सक्रिय करण्यासाठी मॉडेल डाउनलोड करा.</p>
        </header>
        <div className="grid md:grid-cols-2 gap-6">
          {/* LLM Card */}
          <div className="glass-panel p-6 rounded-2xl border border-cyan-500/20 space-y-4">
            <div className="flex items-center justify-between border-b border-cyan-500/10 pb-2">
              <div className="flex items-center gap-2"><Cpu size={18} className="text-cyan-400" /><h2 className="font-bold text-sm tracking-wider">1. LLM (Qwen-7B)</h2></div>
              {llmExists ? <span className="text-xs bg-cyan-950 text-cyan-400 border border-cyan-500/30 px-2 py-0.5 rounded">Downloaded</span> : <span className="text-xs bg-red-950/40 text-red-400 border border-red-500/20 px-2 py-0.5 rounded">Missing</span>}
            </div>
            <p className="text-xs text-slate-400">हा जार्विसचा मुख्य मेंदू आहे (साधारण ४.७ GB GGUF 4-Bit).</p>
            <input type="text" value={llmUrl} onChange={e => setLlmUrl(e.target.value)} disabled={downloadProgress.llm.active} className="w-full bg-slate-900 border border-cyan-500/20 rounded px-3 py-1.5 text-xs text-slate-300 focus:outline-none focus:border-cyan-400" />
            {downloadProgress.llm.active && <div className="w-full bg-slate-900 h-2 rounded overflow-hidden"><div className="bg-gradient-to-r from-cyan-500 to-blue-500 h-full" style={{ width: `${downloadProgress.llm.percent}%` }} /></div>}
            <button onClick={() => triggerDownload('llm')} disabled={downloadProgress.llm.active || llmExists} className="w-full bg-cyan-950/40 hover:bg-cyan-950 text-cyan-400 border border-cyan-500/30 py-2.5 rounded-xl text-xs font-semibold transition-all disabled:opacity-30 disabled:pointer-events-none flex items-center justify-center gap-2">
              {llmExists ? <CheckCircle size={14} /> : <Download size={14} />}{llmExists ? 'MODEL INSTALLED' : 'DOWNLOAD & INSTALL'}
            </button>
          </div>
          {/* TTS Card */}
          <div className="glass-panel p-6 rounded-2xl border border-cyan-500/20 space-y-4">
            <div className="flex items-center justify-between border-b border-cyan-500/10 pb-2">
              <div className="flex items-center gap-2"><Activity size={18} className="text-cyan-400" /><h2 className="font-bold text-sm tracking-wider">2. TTS (Supertonic)</h2></div>
              {ttsExists ? <span className="text-xs bg-cyan-950 text-cyan-400 border border-cyan-500/30 px-2 py-0.5 rounded">Downloaded</span> : <span className="text-xs bg-red-950/40 text-red-400 border border-red-500/20 px-2 py-0.5 rounded">Missing</span>}
            </div>
            <p className="text-xs text-slate-400">जार्विसला AI आवाज देतो. <span className="text-cyan-400">नसेल तरी ब्राऊझर TTS वापरला जाईल ✅</span></p>
            <input type="text" placeholder="https://huggingface.co/.../supertonic-turbo.gguf" value={ttsUrl} onChange={e => setTtsUrl(e.target.value)} disabled={downloadProgress.tts.active} className="w-full bg-slate-900 border border-cyan-500/20 rounded px-3 py-1.5 text-xs text-slate-300 focus:outline-none focus:border-cyan-400" />
            {downloadProgress.tts.active && <div className="w-full bg-slate-900 h-2 rounded overflow-hidden"><div className="bg-gradient-to-r from-cyan-500 to-blue-500 h-full" style={{ width: `${downloadProgress.tts.percent}%` }} /></div>}
            <button onClick={() => triggerDownload('tts')} disabled={downloadProgress.tts.active || ttsExists} className="w-full bg-cyan-950/40 hover:bg-cyan-950 text-cyan-400 border border-cyan-500/30 py-2.5 rounded-xl text-xs font-semibold transition-all disabled:opacity-30 disabled:pointer-events-none flex items-center justify-center gap-2">
              {ttsExists ? <CheckCircle size={14} /> : <Download size={14} />}{ttsExists ? 'MODEL INSTALLED' : 'DOWNLOAD & INSTALL'}
            </button>
          </div>
        </div>
        {llmExists && (
          <div className="glass-panel p-6 rounded-2xl border border-cyan-500/30 text-center space-y-4">
            <p className="text-xs text-slate-300">{ttsExists ? '🎉 दोन्ही मॉडेल्स तयार! आता जार्विस सुरू करा.' : '✅ LLM तयार! TTS नसेल तरी ब्राऊझर आवाज वापरला जाईल. जार्विस सुरू करा.'}</p>
            <button onClick={triggerInit} className="bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-slate-950 font-bold px-8 py-3.5 rounded-xl text-sm tracking-widest transition-all">INITIALIZE JARVIS SYSTEM</button>
          </div>
        )}
      </div>
    </div>
  );

  if (systemState === 'loading') return (
    <div className="flex flex-col h-screen bg-slate-950 text-cyan-400 font-mono items-center justify-center cyber-grid p-6">
      <div className="max-w-md w-full glass-panel p-8 rounded-2xl border border-cyan-500/20 text-center space-y-4">
        <RefreshCw className="animate-spin text-cyan-400 mx-auto" size={48} />
        <h2 className="text-lg font-bold tracking-widest">LOADING CORE MEMORY...</h2>
        <p className="text-xs text-slate-500">जार्विस GGUF मॉडेल RAM वर लोड करत आहे. १-२ मिनिटे लागतील...</p>
      </div>
    </div>
  );

  if (systemState === 'error') return (
    <div className="flex flex-col h-screen bg-slate-950 text-cyan-400 font-mono items-center justify-center cyber-grid p-6">
      <div className="max-w-md w-full glass-panel p-8 rounded-2xl border border-red-500/20 text-center space-y-4">
        <AlertCircle className="text-red-400 mx-auto" size={48} />
        <h2 className="text-lg font-bold text-red-400">CORE FAULT DETECTED</h2>
        <p className="text-xs text-slate-400">{systemErrorMessage || 'सिस्टम सुरू करताना एरर.'}</p>
        <button onClick={checkSystemStatus} className="w-full bg-red-950/40 text-red-400 border border-red-500/30 py-2.5 rounded-xl text-xs font-semibold transition-all">RETRY CONNECTION</button>
      </div>
    </div>
  );

  // ── MAIN CHAT UI ──────────────────────────────────────────────────────────────
  const groupedSessions = groupSessionsByDate(sessions);

  return (
    <div className="flex h-screen bg-slate-950 text-cyan-400 font-mono overflow-hidden cyber-grid">

      {/* SIDEBAR */}
      <aside className={`
        fixed inset-y-0 left-0 z-50 w-72 bg-slate-900/95 border-r border-cyan-500/20 flex flex-col transition-transform duration-300 backdrop-blur-md
        md:static md:translate-x-0
        ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'}
      `}>
        {/* Sidebar Header */}
        <div className="flex items-center justify-between px-4 py-4 border-b border-cyan-500/20">
          <div className="flex items-center gap-2">
            <Cpu size={16} className="text-cyan-400 animate-pulse" />
            <span className="text-xs font-bold tracking-widest text-cyan-300">SYSTEM CONTEXTS</span>
          </div>
          <button onClick={() => setIsSidebarOpen(false)} className="md:hidden p-1.5 text-cyan-400 hover:bg-slate-800 rounded-lg"><X size={18} /></button>
        </div>

        {/* New Chat + Search Toggle */}
        <div className="p-3 space-y-2">
          <button onClick={createNewChat} className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl border border-cyan-500/30 hover:border-cyan-400 bg-cyan-950/20 hover:bg-cyan-950/40 text-cyan-400 font-bold text-xs tracking-wider transition-all">
            <Plus size={15} /> नवीन संभाषण
          </button>
          <button onClick={() => { setShowSearch(s => !s); setSearchQuery(''); setSearchResults([]); }} className={`w-full flex items-center justify-center gap-2 py-2 px-4 rounded-xl border text-xs font-semibold transition-all ${showSearch ? 'bg-blue-950/30 border-blue-500/40 text-blue-300' : 'bg-slate-950/40 border-slate-700 text-slate-400 hover:text-cyan-400 hover:border-cyan-500/30'}`}>
            <Search size={14} /> {showSearch ? 'बंद करा' : 'History शोधा'}
          </button>
        </div>

        {/* Search Panel */}
        {showSearch && (
          <div className="px-3 pb-2 space-y-2">
            <div className="relative">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="संभाषण शोधा..."
                className="w-full bg-slate-950 border border-cyan-500/20 rounded-lg pl-7 pr-3 py-2 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-cyan-400"
                autoFocus
              />
            </div>
            {isSearching && <p className="text-[10px] text-slate-500 px-1">शोधत आहे...</p>}
            {searchResults.length > 0 && (
              <div className="space-y-1 max-h-56 overflow-y-auto">
                {searchResults.map(r => (
                  <div key={r.id} onClick={() => selectSession(r.session_id)}
                    className="p-2 rounded-lg bg-slate-950/60 border border-slate-800 hover:border-cyan-500/30 cursor-pointer transition-all group">
                    <div className="flex items-center gap-1 mb-0.5">
                      <span className="text-[9px] text-cyan-500/70 uppercase font-bold tracking-wider">{r.session_title}</span>
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
        <div className="flex-1 overflow-y-auto px-3 pb-4 space-y-3 custom-scrollbar">
          {groupedSessions.map(({ label, sessions: group }) => (
            <div key={label}>
              {/* Date Group Header */}
              <button onClick={() => toggleGroup(label)} className="w-full flex items-center gap-1.5 px-1 py-1 text-[10px] text-cyan-500/60 font-bold uppercase tracking-widest hover:text-cyan-400 transition-colors">
                <Calendar size={10} />
                <span className="flex-1 text-left">{label}</span>
                {collapsedGroups.has(label) ? <ChevronRight size={10} /> : <ChevronDown size={10} />}
              </button>

              {!collapsedGroups.has(label) && (
                <div className="space-y-1">
                  {group.map(session => (
                    <div key={session.id} onClick={() => selectSession(session.id)}
                      className={`group flex items-center justify-between px-3 py-2.5 rounded-xl border text-xs cursor-pointer transition-all duration-200 ${session.id === activeSessionId
                        ? 'bg-cyan-950/30 border-cyan-500/50 text-cyan-300'
                        : 'bg-slate-950/40 border-slate-800/80 text-slate-400 hover:text-cyan-400 hover:border-cyan-500/20 hover:bg-cyan-950/10'}`}>
                      <div className="flex items-center gap-2 truncate pr-2 flex-1 min-w-0">
                        <MessageSquare size={12} className={session.id === activeSessionId ? 'text-cyan-400 shrink-0' : 'text-slate-500 group-hover:text-cyan-500 shrink-0'} />
                        <div className="truncate min-w-0">
                          <p className="truncate text-[11px]">{session.title}</p>
                          <p className="text-[9px] text-slate-600">{formatTime(session.updated_at)}</p>
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
        <header className="flex items-center justify-between px-4 md:px-6 py-3.5 bg-slate-900/60 border-b border-cyan-500/10 backdrop-blur">
          <div className="flex items-center gap-3">
            <button onClick={() => setIsSidebarOpen(true)} className="md:hidden p-2 text-cyan-400 hover:bg-slate-800 rounded-lg border border-cyan-500/20"><Menu size={18} /></button>
            <div className="w-3 h-3 rounded-full bg-cyan-500 animate-pulse shadow-[0_0_10px_#00f0ff]" />
            <h1 className="text-base md:text-lg font-bold tracking-widest text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-blue-500">JARVIS // CORE PROTOCOL v2.5</h1>
          </div>
          <div className="flex items-center gap-2">
            {/* Workspace Toggle Button */}
            <button
              onClick={() => setShowWorkspace(w => !w)}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-bold tracking-wider transition-all ${
                showWorkspace
                  ? 'bg-cyan-950/50 border-cyan-400/60 text-cyan-300 shadow-[0_0_10px_rgba(6,182,212,0.3)]'
                  : 'bg-slate-900 border-cyan-500/20 text-cyan-500 hover:border-cyan-400/40 hover:text-cyan-400'
              }`}
              title="Workspace Visualizer"
            >
              <Code size={14} />
              <span className="hidden md:inline">{showWorkspace ? 'WORKSPACE ✕' : 'WORKSPACE'}</span>
            </button>
            <button onClick={clearChat} className="p-2 hover:bg-slate-800/80 rounded-lg border border-cyan-500/20 text-cyan-500 hover:text-cyan-400 transition-all" title="क्लियर चॅट"><RotateCcw size={18} /></button>
            <button onClick={() => setIsSettingsOpen(true)} className="p-2 hover:bg-slate-800/80 rounded-lg border border-cyan-500/20 text-cyan-500 hover:text-cyan-400 transition-all" title="सेटिंग्ज (Settings)"><Settings size={18} /></button>
          </div>
        </header>

        {/* Messages */}
        <main className="flex-1 overflow-y-auto p-4 md:p-6 space-y-4">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-slate-500 text-center max-w-md mx-auto">
              <Bot size={64} className="mb-4 text-cyan-500/20 animate-pulse" />
              <p className="text-lg text-cyan-500/60 font-semibold tracking-wider">प्रणाली सक्रिय आहे. आदेशाची वाट पाहत आहे...</p>
              <p className="text-xs text-slate-500 mt-2 leading-relaxed border-t border-cyan-500/10 pt-2 w-full">टाईप करा किंवा माईक बटण दाबून बोला.</p>
            </div>
          )}

          {messages.map(msg => (
            <div key={msg.id} className={`flex gap-3 max-w-[90%] md:max-w-[80%] ${msg.sender === 'user' ? 'ml-auto flex-row-reverse' : 'mr-auto'}`}>
              <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 border ${msg.sender === 'user' ? 'bg-cyan-950 border-cyan-500' : 'bg-slate-900 border-blue-500'}`}>
                {msg.sender === 'user' ? <User size={14} className="text-cyan-400" /> : <Bot size={14} className="text-blue-400" />}
              </div>
              <div className={`p-4 rounded-2xl border ${msg.sender === 'user' ? 'bg-cyan-950/30 border-cyan-500/40 text-cyan-100 rounded-tr-none' : 'glass-panel text-slate-200 rounded-tl-none'}`}>
                <div className="prose max-w-none text-sm leading-relaxed">
                  <ReactMarkdown>{msg.text}</ReactMarkdown>
                </div>
                {msg.created_at && <p className="text-[9px] text-slate-600 mt-1 text-right">{formatTime(msg.created_at)}</p>}
                {msg.audioUrl && (
                  <div className="mt-3 pt-2 border-t border-slate-800/60">
                    <button onClick={() => handlePlayAudio(msg.id, msg.audioUrl!)} className="flex items-center gap-2 text-xs bg-slate-900/80 hover:bg-slate-800 text-cyan-400 px-3 py-1.5 rounded-lg border border-cyan-500/20 transition-all">
                      {playingAudioId === msg.id ? <Pause size={12} className="text-red-400" /> : <Play size={12} />}
                      {playingAudioId === msg.id ? 'PAUSE' : 'REPLAY VOICE'}
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}

          {loading && (
            <div className="flex gap-3 max-w-[80%] mr-auto items-center">
              <div className="w-8 h-8 rounded-full bg-slate-900 border border-blue-500/50 flex items-center justify-center">
                <Bot size={14} className="text-blue-400" />
              </div>
              <div className="glass-panel p-4 rounded-2xl rounded-tl-none flex gap-1.5 items-center">
                <span className="w-2.5 h-2.5 bg-cyan-400 rounded-full animate-bounce [animation-delay:-0.3s]" />
                <span className="w-2.5 h-2.5 bg-cyan-400 rounded-full animate-bounce [animation-delay:-0.15s]" />
                <span className="w-2.5 h-2.5 bg-cyan-400 rounded-full animate-bounce" />
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
        <footer className="p-4 md:p-6 glass-panel border-t border-cyan-500/20 backdrop-blur">
          <div className="max-w-4xl mx-auto flex gap-3">
            <button onClick={toggleListening} className={`p-3.5 rounded-xl border transition-all shrink-0 ${isListening ? 'bg-red-600/90 border-red-500 text-white shadow-[0_0_15px_rgba(239,68,68,0.5)]' : 'bg-slate-900 border-cyan-500/40 text-cyan-400 hover:border-cyan-500/70'}`} title={isListening ? 'ऐकणे थांबवा' : 'बोला'}>
              {isListening ? <MicOff size={22} className="animate-pulse" /> : <Mic size={22} />}
            </button>
            <button onClick={() => setSpeechLanguage(p => p === 'mr-IN' ? 'en-US' : 'mr-IN')} className={`px-3 rounded-xl border transition-all shrink-0 font-bold text-xs ${speechLanguage === 'mr-IN' ? 'bg-cyan-950/40 border-cyan-500/30 text-cyan-400' : 'bg-blue-950/40 border-blue-500/30 text-blue-400'}`}>
              {speechLanguage === 'mr-IN' ? 'मराठी' : 'ENG'}
            </button>
            <input type="text" value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleSendMessage()}
              placeholder={isListening ? 'ऐकत आहे...' : 'तुमचा आदेश टाईप करा...'}
              disabled={isListening}
              className="flex-1 bg-slate-950/80 border border-cyan-500/30 rounded-xl px-4 text-slate-100 placeholder-slate-500 focus:outline-none focus:border-cyan-400 transition-all text-sm md:text-base" />
            <button onClick={handleSendMessage} disabled={loading || !input.trim()} className="p-3.5 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-slate-950 font-bold rounded-xl disabled:opacity-30 disabled:pointer-events-none transition-all">
              <Send size={18} />
            </button>
          </div>
        </footer>
      </div>

      {/* SETTINGS PANEL MODAL */}
      {isSettingsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-sm p-4">
          <div className="glass-panel w-full max-w-md p-6 rounded-2xl border border-cyan-500/20 bg-slate-900/95 shadow-2xl relative text-slate-100">
            <button onClick={() => setIsSettingsOpen(false)} className="absolute top-4 right-4 p-1 rounded hover:bg-slate-800 text-slate-500 hover:text-red-400 transition-colors">
              <X size={16} />
            </button>
            <div className="flex items-center gap-2 mb-6 pb-3 border-b border-cyan-500/10">
              <Settings size={18} className="text-cyan-400" />
              <h2 className="text-sm font-bold tracking-widest text-cyan-300">SYSTEM SETTINGS (सेटिंग्ज)</h2>
            </div>
            
            <div className="space-y-5">
              {/* Brave Search Key Section */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-semibold text-slate-300">Brave Search API Key</label>
                  {keysStatus.braveSearchKeyExists ? (
                    <span className="text-[10px] text-green-400 bg-green-950/40 border border-green-500/20 px-1.5 py-0.5 rounded font-bold">Configured ✅</span>
                  ) : (
                    <span className="text-[10px] text-slate-500 bg-slate-800/40 border border-slate-700/20 px-1.5 py-0.5 rounded font-bold">Not Configured ❌</span>
                  )}
                </div>
                <input
                  type="password"
                  value={braveSearchKey}
                  onChange={e => setBraveSearchKey(e.target.value)}
                  placeholder={keysStatus.braveSearchKeyExists ? "••••••••••••••••" : "Brave API Key एंटर करा..."}
                  className="w-full bg-slate-950/80 border border-cyan-500/30 rounded-xl px-4 py-2.5 text-slate-100 placeholder-slate-600 focus:outline-none focus:border-cyan-400 transition-all text-sm"
                />
              </div>

              {/* GitHub Token Section */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-semibold text-slate-300">GitHub Personal Access Token</label>
                  {keysStatus.githubTokenExists ? (
                    <span className="text-[10px] text-green-400 bg-green-950/40 border border-green-500/20 px-1.5 py-0.5 rounded font-bold">Configured ✅</span>
                  ) : (
                    <span className="text-[10px] text-slate-500 bg-slate-800/40 border border-slate-700/20 px-1.5 py-0.5 rounded font-bold">Not Configured ❌</span>
                  )}
                </div>
                <input
                  type="password"
                  value={githubToken}
                  onChange={e => setGithubToken(e.target.value)}
                  placeholder={keysStatus.githubTokenExists ? "••••••••••••••••" : "GitHub Token एंटर करा..."}
                  className="w-full bg-slate-950/80 border border-cyan-500/30 rounded-xl px-4 py-2.5 text-slate-100 placeholder-slate-600 focus:outline-none focus:border-cyan-400 transition-all text-sm"
                />
              </div>
            </div>

            <div className="flex gap-3 mt-8">
              <button
                onClick={() => setIsSettingsOpen(false)}
                className="flex-1 py-2.5 rounded-xl border border-slate-700 hover:bg-slate-800 text-slate-300 text-xs font-bold transition-all"
              >
                रद्द करा (Cancel)
              </button>
              <button
                onClick={saveKeys}
                disabled={isSavingKeys || (!braveSearchKey.trim() && !githubToken.trim())}
                className="flex-1 py-2.5 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-slate-950 text-xs font-bold rounded-xl disabled:opacity-30 disabled:pointer-events-none transition-all"
              >
                {isSavingKeys ? "सेव्ह होत आहे..." : "सेव्ह करा (Save)"}
              </button>
            </div>
            
            <p className="text-[10px] text-slate-500 text-center mt-4">नोंद: कीज सुरक्षितपणे सेव्ह झाल्यावर MCP सर्व्हर्स आपोआप रिलोड होतील.</p>
          </div>
        </div>
      )}

      {/* WORKSPACE VISUALIZER PANEL */}
      {showWorkspace && (
        <WorkspacePanel onClose={() => setShowWorkspace(false)} />
      )}
    </div>
  );
}
