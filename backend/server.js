import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { loadModel, completion, QvacSDK } from '@qvac/sdk';

const app = express();
app.use(cors());
app.use(express.json());

const qvac = new QvacSDK();
let llmModelId = null;
let ttsModelInstance = null;

// १. कन्व्हर्सेशन मेमरी: जार्विसला मागचा संदर्भ लक्षात राहण्यासाठी
let conversationHistory = [
    { role: "system", content: "You are Jarvis, a highly advanced AI assistant. Keep answers concise, short, intelligent and well-formatted using markdown lists or bold text where appropriate." }
];

// २. ऑडिओ कॅश: रिपीट होणाऱ्या उत्तरांसाठी वेगवान परफॉर्मन्स
const ttsAudioCache = new Map();

async function initJarvisMinds() {
    try {
        console.log("🔄 Loading Qwen-7B-Instruct LLM Model on CPU...");
        llmModelId = await loadModel({
            modelSrc: "./models/qwen2.5-7b-instruct-q4_k_m.gguf", 
            modelType: "llm",
            modelConfig: { ctx_size: 2048 }
        });
        console.log(`✅ Qwen-7B Connected. ID: ${llmModelId}`);

        console.log("🔄 Loading QVAC Supertonic TTS Model on CPU...");
        ttsModelInstance = await qvac.models.load({
            modelType: "tts",
            modelPath: "./models/supertonic-turbo.gguf"
        });
        console.log("✅ QVAC TTS Engine Armed.");
    } catch (error) {
        console.error("❌ Error loading system components:", error);
    }
}
initJarvisMinds();

app.post('/api/jarvis', async (req, res) => {
    const { prompt } = req.body;

    if (!llmModelId || !ttsModelInstance) {
        return res.status(503).json({ error: "सिस्टम अद्याप लोड होत आहे, कृपया थोडा वेळ थांबा." });
    }

    try {
        // युझरचा नवीन प्रश्न हिस्टरीमध्ये जोडणे
        conversationHistory.push({ role: "user", content: prompt });

        // मेमरी मर्यादित ठेवणे (शेवटचे १० मेसेज) जेणेकरून रॅम ओव्हरलोड होणार नाही
        if (conversationHistory.length > 12) {
            conversationHistory = [conversationHistory[0], ...conversationHistory.slice(-10)];
        }

        // QVAC LLM कडून उत्तर मिळवणे
        const llmResponse = await completion({
            model: llmModelId,
            prompt: conversationHistory,
            temperature: 0.6
        });

        const jarvisTextReply = llmResponse.text || "Execution failed.";
        
        // जार्विसचे उत्तर मेमरीमध्ये सेव्ह करणे (Follow-up प्रश्नांसाठी)
        conversationHistory.push({ role: "assistant", content: jarvisTextReply });

        // ऑडिओ कॅश तपासणे (MD5 Hash द्वारे)
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
            ttsAudioCache.set(textHash, audioBase64); // कॅशमध्ये सेव्ह करा
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
