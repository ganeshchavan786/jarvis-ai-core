'use client';

import { useState, useRef, useEffect } from 'react';
import { Mic, MicOff, Send, Play, Pause, AlertCircle, Bot, User, RotateCcw, Download, Cpu, Activity, CheckCircle, RefreshCw } from 'lucide-react';
import ReactMarkdown from 'react-markdown';

interface Message {
  id: string;
  sender: 'user' | 'jarvis';
  text: string;
  audioUrl?: string;
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

export default function JarvisAdvancedUI() {
  // Chat States
  const [messages, setMessages] = useState<Message[]>([]);
  const hasLoadedRef = useRef(false);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [error, setError] = useState<{ type: 'network' | 'server' | null; message: string }>({ type: null, message: '' });
  const [playingAudioId, setPlayingAudioId] = useState<string | null>(null);

  // System Setup States
  const [systemState, setSystemState] = useState<'checking' | 'uninitialized' | 'loading' | 'ready' | 'error'>('checking');
  const [systemErrorMessage, setSystemErrorMessage] = useState('');
  const [llmExists, setLlmExists] = useState(false);
  const [ttsExists, setTtsExists] = useState(false);

  // Download URLs & Progress States
  const [llmUrl, setLlmUrl] = useState('https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf');
  const [ttsUrl, setTtsUrl] = useState(''); // Empty by default, user can paste theirs
  const [downloadProgress, setDownloadProgress] = useState<DownloadStatus>({
    llm: { total: 0, downloaded: 0, percent: 0, active: false, error: null },
    tts: { total: 0, downloaded: 0, percent: 0, active: false, error: null }
  });

  const chatEndRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const recognitionRef = useRef<any>(null);
  const statusPollRef = useRef<NodeJS.Timeout | null>(null);
  const downloadPollRef = useRef<NodeJS.Timeout | null>(null);

  // Poll system status
  const checkSystemStatus = async () => {
    try {
      const res = await fetch('http://localhost:8000/api/system/status');
      if (!res.ok) throw new Error("Backend offline");
      const data = await res.json();
      
      setSystemState(data.status);
      setSystemErrorMessage(data.error || '');
      setLlmExists(data.llmExists);
      setTtsExists(data.ttsExists);

      if (data.status === 'ready' && statusPollRef.current) {
        clearInterval(statusPollRef.current);
        statusPollRef.current = null;
      }
    } catch (err) {
      setSystemState('error');
      setSystemErrorMessage('बॅकएंड सर्व्हरशी संपर्क होऊ शकला नाही. कृपया बॅकएंड चालू असल्याची खात्री करा.');
    }
  };

  // Poll download progress
  const checkDownloadStatus = async () => {
    try {
      const res = await fetch('http://localhost:8000/api/download/status');
      if (!res.ok) throw new Error("Offline");
      const data: DownloadStatus = await res.json();
      
      setDownloadProgress(data);
      
      // If none are active, check if models exist now
      const anyActive = data.llm.active || data.tts.active;
      if (!anyActive) {
        if (downloadPollRef.current) {
          clearInterval(downloadPollRef.current);
          downloadPollRef.current = null;
        }
        checkSystemStatus();
      }
    } catch (err) {
      console.error("Error fetching download progress:", err);
    }
  };

  // Load messages from localStorage on mount
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const savedMessages = localStorage.getItem('jarvis_chat_messages');
      if (savedMessages) {
        try {
          setMessages(JSON.parse(savedMessages));
        } catch (e) {
          console.error("Error loading chat history:", e);
        }
      }
      hasLoadedRef.current = true;
    }
  }, []);

  // Save messages to localStorage when they change
  useEffect(() => {
    if (typeof window !== 'undefined' && hasLoadedRef.current) {
      localStorage.setItem('jarvis_chat_messages', JSON.stringify(messages));
    }
  }, [messages]);

  // Initial load
  useEffect(() => {
    checkSystemStatus();
    statusPollRef.current = setInterval(checkSystemStatus, 3000);

    return () => {
      if (statusPollRef.current) clearInterval(statusPollRef.current);
      if (downloadPollRef.current) clearInterval(downloadPollRef.current);
    };
  }, []);

  // Monitor active downloads
  useEffect(() => {
    const isDownloading = downloadProgress.llm.active || downloadProgress.tts.active;
    if (isDownloading && !downloadPollRef.current) {
      downloadPollRef.current = setInterval(checkDownloadStatus, 1500);
    }
    return () => {
      if (!isDownloading && downloadPollRef.current) {
        clearInterval(downloadPollRef.current);
        downloadPollRef.current = null;
      }
    };
  }, [downloadProgress]);

  // Speech-to-Text Setup
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (SpeechRecognition) {
        const recognition = new SpeechRecognition();
        recognition.continuous = false;
        recognition.interimResults = false;
        recognition.lang = 'mr-IN';

        recognition.onresult = (event: any) => {
          const speechToText = event.results[0][0].transcript;
          setInput(speechToText);
          setIsListening(false);
        };

        recognition.onerror = () => {
          setIsListening(false);
          setError({ type: 'server', message: 'आवाज समजण्यात अडचण आली. कृपया पुन्हा बोला.' });
        };

        recognition.onend = () => setIsListening(false);
        recognitionRef.current = recognition;
      }
    }
  }, []);

  const triggerDownload = async (type: 'llm' | 'tts') => {
    const url = type === 'llm' ? llmUrl : ttsUrl;
    if (!url.trim()) {
      alert("कृपया योग्य डाउनलोड लिंक टाका.");
      return;
    }

    try {
      const res = await fetch('http://localhost:8000/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, url })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Download failed to start");
      
      // Start polling status immediately
      checkDownloadStatus();
    } catch (err: any) {
      alert("एरर: " + err.message);
    }
  };

  const triggerInit = async () => {
    try {
      setSystemState('loading');
      await fetch('http://localhost:8000/api/init-models', { method: 'POST' });
      // Poll faster to check status
      if (statusPollRef.current) clearInterval(statusPollRef.current);
      statusPollRef.current = setInterval(checkSystemStatus, 2000);
    } catch (err) {
      setSystemState('error');
      setSystemErrorMessage('सिस्टम सुरू करताना एरर आला.');
    }
  };

  const toggleListening = () => {
    if (!recognitionRef.current) {
      setError({ type: 'server', message: 'तुमच्या ब्राउझरमध्ये व्हॉईस इनपुट सपोर्ट नाही.' });
      return;
    }
    if (isListening) {
      try { recognitionRef.current.stop(); } catch (_) {}
      setIsListening(false);
    } else {
      setError({ type: null, message: '' });
      try {
        recognitionRef.current.abort(); // थांबवा आधीचे
        setTimeout(() => {
          try {
            setIsListening(true);
            recognitionRef.current.start();
          } catch (err: any) {
            setIsListening(false);
            setError({ type: 'server', message: 'मायक्रोफोन सुरू करण्यात अडचण. पुन्हा प्रयत्न करा.' });
          }
        }, 100);
      } catch (_) {}
    }
  };

  // Browser built-in TTS (fallback when no backend TTS model)
  const speakWithBrowser = (text: string) => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return;
    window.speechSynthesis.cancel(); // stop any previous speech
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-US';
    utterance.rate = 0.92;
    utterance.pitch = 0.75;
    utterance.volume = 1;
    window.speechSynthesis.speak(utterance);
  };

  const handlePlayAudio = (messageId: string, audioDataUrl: string) => {
    if (playingAudioId === messageId) {
      audioRef.current?.pause();
      setPlayingAudioId(null);
    } else {
      if (audioRef.current) audioRef.current.pause();
      audioRef.current = new Audio(audioDataUrl);
      setPlayingAudioId(messageId);
      audioRef.current.play();
      audioRef.current.onended = () => setPlayingAudioId(null);
    }
  };

  const clearChat = async () => {
    setMessages([]);
    setError({ type: null, message: '' });
    try {
      await fetch('http://localhost:8000/api/reset-chat', { method: 'POST' });
    } catch (err) {
      console.error("Failed to reset backend chat context:", err);
    }
  };

  const handleSendMessage = async () => {
    if (!input.trim() || loading) return;

    setError({ type: null, message: '' });
    const userMessageId = Date.now().toString();
    const userPrompt = input;
    
    setMessages((prev) => [...prev, { id: userMessageId, sender: 'user', text: userPrompt }]);
    setInput('');
    setLoading(true);

    try {
      const res = await fetch('http://localhost:8000/api/jarvis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: userPrompt }),
      });

      if (!res.ok) throw new Error(res.status === 503 ? 'server' : 'network');

      const data = await res.json();
      const jarvisMessageId = (Date.now() + 1).toString();

      setMessages((prev) => [
        ...prev,
        { id: jarvisMessageId, sender: 'jarvis', text: data.text, audioUrl: data.audio }
      ]);

      if (data.audio) {
        handlePlayAudio(jarvisMessageId, data.audio);
      } else {
        // Fallback: use browser's built-in voice if no backend TTS model
        speakWithBrowser(data.text);
      }

    } catch (err: any) {
      if (err.message === 'server') {
        setError({ type: 'server', message: '⚠️ जार्विस सिस्टीम लोड होत आहे, कृपया १० सेकंद थांबा.' });
      } else {
        setError({ type: 'network', message: '🌐 नेटवर्क कनेक्शन एरर! सर्व्हर बंद असण्याची शक्यता आहे.' });
      }
    } finally {
      setLoading(false);
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  // --- RENDER BOILERPLATE FOR SETUP INTERFACE ---
  if (systemState === 'checking') {
    return (
      <div className="flex flex-col h-screen bg-slate-950 text-cyan-400 font-mono items-center justify-center cyber-grid">
        <div className="flex flex-col items-center gap-4">
          <RefreshCw className="animate-spin text-cyan-500" size={48} />
          <p className="text-sm tracking-wider text-cyan-500/80">CORE PROTOCOLS RESOLVING...</p>
        </div>
      </div>
    );
  }

  if (systemState === 'uninitialized') {
    return (
      <div className="flex flex-col h-screen bg-slate-950 text-cyan-400 font-mono cyber-grid overflow-y-auto p-6">
        <div className="max-w-4xl mx-auto w-full py-8 space-y-6">
          
          {/* Header */}
          <header className="glass-panel p-6 rounded-2xl border border-cyan-500/20 text-center space-y-2">
            <h1 className="text-2xl font-bold tracking-widest bg-clip-text text-transparent bg-gradient-to-r from-cyan-400 to-blue-500">
              JARVIS // INSTALLATION PROTOCOL v2.5
            </h1>
            <p className="text-xs text-slate-500">
              जार्विस ऑफलाईन मेंदू सक्रिय करण्यासाठी खालील दोन्ही मॉडेल्स डाउनलोड करा.
            </p>
          </header>

          <div className="grid md:grid-cols-2 gap-6">
            
            {/* Card 1: LLM */}
            <div className="glass-panel p-6 rounded-2xl border border-cyan-500/20 flex flex-col justify-between space-y-4">
              <div className="space-y-3">
                <div className="flex items-center justify-between border-b border-cyan-500/10 pb-2">
                  <div className="flex items-center gap-2">
                    <Cpu size={18} className="text-cyan-400" />
                    <h2 className="font-bold text-sm tracking-wider">1. LLM (Qwen-7B)</h2>
                  </div>
                  {llmExists ? (
                    <span className="text-xs bg-cyan-950 text-cyan-400 border border-cyan-500/30 px-2 py-0.5 rounded">Downloaded</span>
                  ) : (
                    <span className="text-xs bg-red-950/40 text-red-400 border border-red-500/20 px-2 py-0.5 rounded">Missing</span>
                  )}
                </div>
                <p className="text-xs text-slate-400 leading-relaxed">
                  हा जार्विसचा विचार करण्याचा मुख्य मेंदू आहे. (साधारण ४.७ GB - GGUF 4-Bit).
                </p>
                <div className="space-y-1">
                  <label className="text-[10px] text-slate-500">DOWNLOAD URL</label>
                  <input 
                    type="text"
                    value={llmUrl}
                    onChange={(e) => setLlmUrl(e.target.value)}
                    disabled={downloadProgress.llm.active}
                    className="w-full bg-slate-900 border border-cyan-500/20 rounded px-3 py-1.5 text-xs text-slate-300 focus:outline-none focus:border-cyan-400"
                  />
                </div>
              </div>

              <div className="pt-4 space-y-3">
                {downloadProgress.llm.active && (
                  <div className="space-y-1">
                    <div className="flex justify-between text-[10px] text-slate-400">
                      <span>Downloading ({downloadProgress.llm.percent}%)</span>
                      <span>{formatSize(downloadProgress.llm.downloaded)} / {formatSize(downloadProgress.llm.total)}</span>
                    </div>
                    <div className="w-full bg-slate-900 h-2 rounded overflow-hidden border border-cyan-500/10">
                      <div 
                        className="bg-gradient-to-r from-cyan-500 to-blue-500 h-full glow-active"
                        style={{ width: `${downloadProgress.llm.percent}%` }}
                      />
                    </div>
                  </div>
                )}
                
                {downloadProgress.llm.error && (
                  <p className="text-[10px] text-red-400 border border-red-500/20 p-2 rounded bg-red-950/10">
                    Error: {downloadProgress.llm.error}
                  </p>
                )}

                <button
                  onClick={() => triggerDownload('llm')}
                  disabled={downloadProgress.llm.active || llmExists}
                  className="w-full bg-cyan-950/40 hover:bg-cyan-950 text-cyan-400 border border-cyan-500/30 hover:border-cyan-400 py-2.5 rounded-xl text-xs font-semibold tracking-wider transition-all disabled:opacity-30 disabled:pointer-events-none flex items-center justify-center gap-2"
                >
                  {llmExists ? <CheckCircle size={14} /> : <Download size={14} />}
                  {llmExists ? "MODEL INSTALLED" : "DOWNLOAD & INSTALL"}
                </button>
              </div>
            </div>

            {/* Card 2: TTS */}
            <div className="glass-panel p-6 rounded-2xl border border-cyan-500/20 flex flex-col justify-between space-y-4">
              <div className="space-y-3">
                <div className="flex items-center justify-between border-b border-cyan-500/10 pb-2">
                  <div className="flex items-center gap-2">
                    <Activity size={18} className="text-cyan-400" />
                    <h2 className="font-bold text-sm tracking-wider">2. TTS (Supertonic)</h2>
                  </div>
                  {ttsExists ? (
                    <span className="text-xs bg-cyan-950 text-cyan-400 border border-cyan-500/30 px-2 py-0.5 rounded">Downloaded</span>
                  ) : (
                    <span className="text-xs bg-red-950/40 text-red-400 border border-red-500/20 px-2 py-0.5 rounded">Missing</span>
                  )}
                </div>
                <p className="text-xs text-slate-400 leading-relaxed">
                  हा जार्विसला AI आवाज देतो. <span className="text-cyan-400">TTS नसेल तरी ब्राऊझरचा आवाज वापरला जाईल ✅</span> — डाउनलोड ऐच्छिक आहे.
                </p>
                <div className="space-y-1">
                  <label className="text-[10px] text-slate-500">TTS DIRECT DOWNLOAD GGUF URL</label>
                  <input 
                    type="text"
                    placeholder="https://huggingface.co/.../supertonic-turbo.gguf"
                    value={ttsUrl}
                    onChange={(e) => setTtsUrl(e.target.value)}
                    disabled={downloadProgress.tts.active}
                    className="w-full bg-slate-900 border border-cyan-500/20 rounded px-3 py-1.5 text-xs text-slate-300 focus:outline-none focus:border-cyan-400"
                  />
                </div>
              </div>

              <div className="pt-4 space-y-3">
                {downloadProgress.tts.active && (
                  <div className="space-y-1">
                    <div className="flex justify-between text-[10px] text-slate-400">
                      <span>Downloading ({downloadProgress.tts.percent}%)</span>
                      <span>{formatSize(downloadProgress.tts.downloaded)} / {formatSize(downloadProgress.tts.total)}</span>
                    </div>
                    <div className="w-full bg-slate-900 h-2 rounded overflow-hidden border border-cyan-500/10">
                      <div 
                        className="bg-gradient-to-r from-cyan-500 to-blue-500 h-full glow-active"
                        style={{ width: `${downloadProgress.tts.percent}%` }}
                      />
                    </div>
                  </div>
                )}

                {downloadProgress.tts.error && (
                  <p className="text-[10px] text-red-400 border border-red-500/20 p-2 rounded bg-red-950/10">
                    Error: {downloadProgress.tts.error}
                  </p>
                )}

                <button
                  onClick={() => triggerDownload('tts')}
                  disabled={downloadProgress.tts.active || ttsExists}
                  className="w-full bg-cyan-950/40 hover:bg-cyan-950 text-cyan-400 border border-cyan-500/30 hover:border-cyan-400 py-2.5 rounded-xl text-xs font-semibold tracking-wider transition-all disabled:opacity-30 disabled:pointer-events-none flex items-center justify-center gap-2"
                >
                  {ttsExists ? <CheckCircle size={14} /> : <Download size={14} />}
                  {ttsExists ? "MODEL INSTALLED" : "DOWNLOAD & INSTALL"}
                </button>
              </div>
            </div>

          </div>

          {/* Initialization Banner */}
          {llmExists && (
            <div className="glass-panel p-6 rounded-2xl border border-cyan-500/30 text-center space-y-4 shadow-[0_0_20px_rgba(6,182,212,0.15)]">
              <p className="text-xs text-slate-300">
                {ttsExists 
                  ? '🎉 दोन्ही मॉडेल्स तयार आहेत! आता जार्विस सुरू करा.'
                  : '✅ LLM मॉडेल तयार आहे! TTS नसेल तरी ब्राऊझरचा आवाज वापरला जाईल. आता जार्विस सुरू करा.'}
              </p>
              <button
                onClick={triggerInit}
                className="bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-slate-950 font-bold px-8 py-3.5 rounded-xl text-sm tracking-widest transition-all shadow-[0_4px_20px_rgba(6,182,212,0.3)] glow-active"
              >
                INITIALIZE JARVIS SYSTEM
              </button>
            </div>
          )}

        </div>
      </div>
    );
  }

  if (systemState === 'loading') {
    return (
      <div className="flex flex-col h-screen bg-slate-950 text-cyan-400 font-mono items-center justify-center cyber-grid p-6">
        <div className="max-w-md w-full glass-panel p-8 rounded-2xl border border-cyan-500/20 text-center space-y-4">
          <RefreshCw className="animate-spin text-cyan-400 mx-auto" size={48} />
          <h2 className="text-lg font-bold tracking-widest">LOADING CORE MEMORY...</h2>
          <p className="text-xs text-slate-500 leading-relaxed">
            जार्विस दोन्ही GGUF मॉडेल्स RAM वर लोड करत आहे. CPU परफॉर्मन्सनुसार याला १ ते २ मिनिटे लागू शकतात. कृपया वाट पाहा...
          </p>
        </div>
      </div>
    );
  }

  if (systemState === 'error') {
    return (
      <div className="flex flex-col h-screen bg-slate-950 text-cyan-400 font-mono items-center justify-center cyber-grid p-6">
        <div className="max-w-md w-full glass-panel p-8 rounded-2xl border border-red-500/20 text-center space-y-4">
          <AlertCircle className="text-red-400 mx-auto" size={48} />
          <h2 className="text-lg font-bold tracking-widest text-red-400">CORE FAULT DETECTED</h2>
          <p className="text-xs text-slate-400 leading-relaxed">
            {systemErrorMessage || "सिस्टम सुरू करताना एरर आला आहे."}
          </p>
          <button
            onClick={checkSystemStatus}
            className="w-full bg-red-950/40 hover:bg-red-950 text-red-400 border border-red-500/30 hover:border-red-400 py-2.5 rounded-xl text-xs font-semibold tracking-wider transition-all"
          >
            RETRY CONNECTION
          </button>
        </div>
      </div>
    );
  }

  // --- RENDER MAIN CHAT UI ---
  return (
    <div className="flex flex-col h-screen bg-slate-950 text-cyan-400 font-mono cyber-grid">
      {/* हेडर बार */}
      <header className="flex items-center justify-between px-6 py-4 glass-panel backdrop-blur shadow-[0_4px_20px_rgba(0,240,255,0.1)]">
        <div className="flex items-center gap-3">
          <div className="w-3 h-3 rounded-full bg-cyan-500 animate-pulse shadow-[0_0_10px_#00f0ff]" />
          <h1 className="text-lg md:text-xl font-bold tracking-widest text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-blue-500">
            JARVIS // CORE PROTOCOL v2.5
          </h1>
        </div>
        <button 
          onClick={clearChat} 
          className="p-2 hover:bg-slate-800/80 rounded-lg transition-all border border-cyan-500/20 hover:border-cyan-500/50 text-cyan-500 hover:text-cyan-400" 
          title="क्लियर चॅट"
        >
          <RotateCcw size={18} />
        </button>
      </header>

      {/* चॅट हिस्टरी एरिया */}
      <main className="flex-1 overflow-y-auto p-4 md:p-6 space-y-4">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-slate-500 text-center max-w-md mx-auto">
            <Bot size={64} className="mb-4 text-cyan-500/20 animate-pulse" />
            <p className="text-lg text-cyan-500/60 font-semibold tracking-wider">प्रणाली सक्रिय आहे. आदेशाची वाट पाहत आहे...</p>
            <p className="text-xs text-slate-500 mt-2 leading-relaxed border-t border-cyan-500/10 pt-2 w-full">
              टाईप करा किंवा डावीकडील माईक बटण दाबून थेट बोला.
            </p>
          </div>
        )}

        {messages.map((msg) => (
          <div key={msg.id} className={`flex gap-3 max-w-[90%] md:max-w-[80%] ${msg.sender === 'user' ? 'ml-auto flex-row-reverse' : 'mr-auto'}`}>
            <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 border ${msg.sender === 'user' ? 'bg-cyan-950 border-cyan-500 shadow-[0_0_8px_rgba(6,182,212,0.3)]' : 'bg-slate-900 border-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.3)]'}`}>
              {msg.sender === 'user' ? <User size={14} className="text-cyan-400" /> : <Bot size={14} className="text-blue-400" />}
            </div>

            <div className={`p-4 rounded-2xl border transition-all ${
              msg.sender === 'user' 
                ? 'bg-cyan-950/30 border-cyan-500/40 text-cyan-100 rounded-tr-none shadow-[0_4px_12px_rgba(6,182,212,0.05)]' 
                : 'glass-panel text-slate-200 rounded-tl-none shadow-[0_4px_12px_rgba(0,0,0,0.2)]'
            }`}>
              <div className="prose max-w-none text-sm leading-relaxed">
                <ReactMarkdown>{msg.text}</ReactMarkdown>
              </div>

              {msg.audioUrl && (
                <div className="mt-3 pt-2 border-t border-slate-800/60 flex items-center gap-2">
                  <button 
                    onClick={() => handlePlayAudio(msg.id, msg.audioUrl!)}
                    className="flex items-center gap-2 text-xs bg-slate-900/80 hover:bg-slate-800 text-cyan-400 hover:text-cyan-300 px-3 py-1.5 rounded-lg border border-cyan-500/20 hover:border-cyan-500/50 transition-all"
                  >
                    {playingAudioId === msg.id ? <Pause size={12} className="animate-pulse text-red-400" /> : <Play size={12} />}
                    {playingAudioId === msg.id ? "PAUSE" : "REPLAY VOICE"}
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex gap-3 max-w-[80%] mr-auto items-center">
            <div className="w-8 h-8 rounded-full bg-slate-900 border border-blue-500/50 flex items-center justify-center shadow-[0_0_8px_rgba(59,130,246,0.3)]">
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

      {/* एरर अलर्ट */}
      {error.message && (
        <div className={`mx-6 my-2 p-3 rounded-lg flex items-center gap-3 text-sm border transition-all ${
          error.type === 'network' 
            ? 'bg-red-950/40 border-red-500/30 text-red-400 shadow-[0_0_10px_rgba(239,68,68,0.1)]' 
            : 'bg-amber-950/40 border-amber-500/30 text-amber-400 shadow-[0_0_10px_rgba(245,158,11,0.1)]'
        }`}>
          <AlertCircle size={18} className="shrink-0 text-red-400" />
          <p className="flex-1 font-semibold">{error.message}</p>
        </div>
      )}

      {/* इनपुट पॅनेल */}
      <footer className="p-4 md:p-6 glass-panel border-t border-cyan-500/20 backdrop-blur shadow-[0_-4px_20px_rgba(0,240,255,0.05)]">
        <div className="max-w-4xl mx-auto flex gap-3">
          <button
            onClick={toggleListening}
            className={`p-3.5 rounded-xl border transition-all shrink-0 duration-300 flex items-center justify-center ${
              isListening 
                ? 'bg-red-600/90 hover:bg-red-700 border-red-500 text-white glow-active shadow-[0_0_15px_rgba(239,68,68,0.5)]' 
                : 'bg-slate-900 hover:bg-slate-800 border-cyan-500/40 text-cyan-400 hover:border-cyan-500/70 hover:text-cyan-300 shadow-[0_4px_10px_rgba(0,0,0,0.1)]'
            }`}
            title={isListening ? "ऐकणे थांबवा" : "बोला (Marathi/English)"}
          >
            {isListening ? <MicOff size={22} className="animate-pulse" /> : <Mic size={22} />}
          </button>

          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()}
            placeholder={isListening ? "ऐकत आहे... (कृपया बोला)" : "तुमचा आदेश टाईप करा आणि Enter दाबा..."}
            disabled={isListening}
            className="flex-1 bg-slate-950/80 border border-cyan-500/30 rounded-xl px-4 text-slate-100 placeholder-slate-500 focus:outline-none focus:border-cyan-400 focus:shadow-[0_0_10px_rgba(6,182,212,0.2)] transition-all font-sans text-sm md:text-base"
          />

          <button
            onClick={handleSendMessage}
            disabled={loading || !input.trim()}
            className="p-3.5 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-slate-950 font-bold rounded-xl disabled:opacity-30 disabled:pointer-events-none transition-all duration-300 shadow-[0_4px_12px_rgba(6,182,212,0.25)] flex items-center justify-center"
          >
            <Send size={18} />
          </button>
        </div>
      </footer>
    </div>
  );
}
