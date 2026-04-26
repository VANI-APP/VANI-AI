# Sarvam Near-Live Speech to Text (JavaScript)

This project gives you **near-live speech to text** in JavaScript using Sarvam AI.
It is configured by default for **English output** using `saaras:v3` + `mode=translate`.
It also supports **speaker diarization** using Groq (default model: `llama-3.3-70b-versatile`).
It now includes **live healthcare report extraction** into your JSON schema while the conversation is running.

Because the current public OpenAPI exposes `/speech-to-text` as a multipart file endpoint (not websocket streaming), this app records short microphone chunks and sends each chunk continuously for fast transcript updates.

## 1) Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create environment file:

   ```bash
   copy .env.example .env
   ```

3. Open `.env` and set your key:

   ```env
   SARVAM_API_SUBSCRIPTION_KEY=your_real_key
   GROQ_API_KEY=your_groq_key
   ```

4. Run app:

   ```bash
   npm run dev
   ```

5. Open:

   ```text
   http://localhost:3000
   ```

## 2) How it works

- Browser captures mic audio with `MediaRecorder` in short chunks.
- Each chunk is posted to `POST /api/transcribe-chunk`.
- Backend forwards file to `https://api.sarvam.ai/speech-to-text` with `api-subscription-key` header.
- Returned `transcript` text is appended in the UI.
- When enabled, the raw transcript is sent to `POST /api/diarize`.
- Backend calls Groq Chat Completions and returns speaker-labeled text.
- Live extraction calls `POST /api/extract-report` and updates a structured JSON report in the UI.
- Report keys come from `healthcare_report_schema.json`.

## 3) Notes

- For lower latency, keep chunk duration around `700-1500` ms.
- Very small chunks can reduce transcription quality.
- This is best-effort near-live behavior, not true frame-level realtime streaming.
- LLM diarization is heuristic (text-based), so speaker labels are not guaranteed to be perfect.
- LLM extraction is assistive and should be clinically reviewed before use.
