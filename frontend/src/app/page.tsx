'use client';

import { useState, useRef, useEffect } from 'react';
import { Mic, MicOff, Send, Play, Pause, AlertCircle, Bot, User, RotateCcw } from 'lucide-react';
import ReactMarkdown from 'react-markdown';

interface Message {
  id: string;
  sender: 'user' | 'jarvis';
  text: string;
  audioUrl?: string;
}

export default function JarvisAdvancedUI() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [error, setError] = useState<{ type: 'network' | 'server' | null; message: string }>({ type: null, message: '' });
  const [playingAudioId, setPlayingAudioId] = useState<string | null>(null);

  const chatEndRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const recognitionRef = useRef<any>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  // व्हॉईस इनपुट (Speech-to-Text - Web Speech API)
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (SpeechRecognition) {
        const recognition = new SpeechRecognition();
        recognition.continuous = false;
        recognition.interimResults = false;
        recognition.lang = 'mr-IN'; // मराठी-इंग्रजी मिश्रित बोलण्यासाठी

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

  const toggleListening = () => {
    if (!recognitionRef.current) {
      setError({ type: 'server', message: 'तुमच्या ब्राउझरमध्ये व्हॉईस इनपुट सपोर्ट नाही.' });
      return;
    }
    if (isListening) {
      recognitionRef.current.stop();
    } else {
      setError({ type: null, message: '' });
      setIsListening(true);
      recognitionRef.current.start();
    }
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

  const clearChat = () => {
    setMessages([]);
    setError({ type: null, message: '' });
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
