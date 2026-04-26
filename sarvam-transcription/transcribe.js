require('dotenv').config();
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const { SarvamAIClient } = require('sarvamai');
const axios = require('axios');

const SARVAM_API_KEY = process.env.SARVAM_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const AUDIO_FILE_PATH = './sample_audio.mp3'; // Change to your MP3 file
const OUTPUT_FILE = 'translated_diarized_transcript.txt';
const CHUNK_DURATION = 29; // seconds (guaranteed <30s)
const CHUNK_OVERLAP = 9;   // seconds overlap
const CHUNKS_DIR = './chunks';

ffmpeg.setFfmpegPath(ffmpegPath);

// Split audio into overlapping chunks: 0–29, 20–49, 30–59, etc.
function splitAudioOverlapping(filePath, chunkDuration, overlap, outDir) {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) return reject(err);
            const duration = metadata.format.duration;
            let chunks = [];
            let idx = 0;
            let starts = [];
            // Generate starts: 0, 20, 30, ... (example logic)
            for (let s = 0; s < duration; s += (chunkDuration - overlap)) {
                starts.push(s);
            }
            for (let i = 0; i < starts.length; i++) {
                let start = starts[i];
                let end = Math.min(start + chunkDuration, duration);
                let chunkPath = path.join(outDir, `chunk_${String(idx).padStart(3, '0')}.mp3`);
                chunks.push({ start, end, chunkPath });
                idx++;
            }
            // Extract each chunk
            let extractNext = (i) => {
                if (i >= chunks.length) {
                    resolve(chunks.map(c => c.chunkPath));
                    return;
                }
                ffmpeg(filePath)
                    .setStartTime(chunks[i].start)
                    .setDuration(chunks[i].end - chunks[i].start)
                    .output(chunks[i].chunkPath)
                    .on('end', () => extractNext(i + 1))
                    .on('error', reject)
                    .run();
            };
            extractNext(0);
        });
    });
}

// Transcribe a chunk (no diarization)
async function transcribeChunk(client, chunkPath) {
    try {
        const response = await client.speechToText.transcribe({
            file: fs.createReadStream(chunkPath),
            model: 'saaras:v3',
            mode: 'translate'
            // diarize: false (default)
        });
        return response;
    } catch (error) {
        console.error(`Error transcribing ${chunkPath}:`, error.body || error.message);
        return null;
    }
}

// Main orchestrator
async function runChunkedTranscription() {
    if (!SARVAM_API_KEY) {
        console.error('Error: SARVAM_API_KEY is missing.');
        return;
    }
    if (!GROQ_API_KEY) {
        console.error('Error: GROQ_API_KEY is missing.');
        return;
    }
    const client = new SarvamAIClient({ apiSubscriptionKey: SARVAM_API_KEY });
    try {
        console.log('Splitting audio into 30s chunks...');
        const chunkFiles = await splitAudioOverlapping(AUDIO_FILE_PATH, CHUNK_DURATION, CHUNK_OVERLAP, CHUNKS_DIR);
        console.log(`Created ${chunkFiles.length} overlapping chunks.`);

        let allTranscripts = [];
        for (let i = 0; i < chunkFiles.length; i++) {
            console.log(`Transcribing chunk ${i + 1}/${chunkFiles.length}...`);
            const result = await transcribeChunk(client, chunkFiles[i]);
            if (result && result.transcript) {
                allTranscripts.push(result.transcript);
            }
        }

        // Merge and save
        const mergedTranscript = allTranscripts.join('\n');
        fs.writeFileSync(OUTPUT_FILE, mergedTranscript);
        console.log(`\nSuccess! Plain transcript saved to: ${OUTPUT_FILE}`);

        // --- Diarization via Groq API (Llama 3) ---
        const prompt = `Segment and label the speakers in the following conversation transcript. Output as a diarized conversation with Speaker 1, Speaker 2, etc.\n\nTRANSCRIPT:\n${mergedTranscript}`;
        try {
            const groqResponse = await axios.post(
                'https://api.groq.com/openai/v1/chat/completions',
                {
                    model: 'llama-3.3-70b-versatile',
                    messages: [
                        { role: 'system', content: 'You are a diarization expert.' },
                        { role: 'user', content: prompt }
                    ]
                },
                {
                    headers: {
                        'Authorization': `Bearer ${GROQ_API_KEY}`,
                        'Content-Type': 'application/json'
                    }
                }
            );
            const diarized = groqResponse.data.choices[0].message.content;
            fs.writeFileSync('llama_diarized_transcript.txt', diarized);
            console.log('\nSuccess! Llama diarized transcript saved to: llama_diarized_transcript.txt');
        } catch (error) {
            console.error('Error calling Groq API:', error.response ? error.response.data : error.message);
        }
    } catch (error) {
        console.error('Error in chunked transcription:', error.message);
    }
}

runChunkedTranscription();