const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
require("dotenv").config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const PORT = Number(process.env.PORT || 3000);
const SARVAM_STT_URL = process.env.SARVAM_STT_URL || "https://api.sarvam.ai/speech-to-text";
const GROQ_API_URL = process.env.GROQ_API_URL || "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const REPORT_SCHEMA_PATH = path.join(__dirname, "healthcare_report_schema.json");

const DEFAULT_HEALTHCARE_REPORT_SCHEMA = {
  symptoms: [],
  past_history: [],
  clinical_observations: [],
  diagnosis: [],
  treatment_advice: [],
  immunization_data: [],
  pregnancy_data: [],
  risk_indicators: [],
  injury_and_mobility_details: [],
  ent_finding: [],
  "extra_info_from convo": [],
};

function deepCloneJson(data) {
  return JSON.parse(JSON.stringify(data));
}

function normalizeAgainstTemplate(template, candidate) {
  const normalized = deepCloneJson(template);

  for (const key of Object.keys(template)) {
    const rawValue = candidate?.[key];

    if (Array.isArray(rawValue)) {
      normalized[key] = rawValue
        .map((value) => String(value || "").trim())
        .filter(Boolean);
      continue;
    }

    if (typeof rawValue === "string" && rawValue.trim()) {
      normalized[key] = [rawValue.trim()];
      continue;
    }

    normalized[key] = [];
  }

  return normalized;
}

function loadReportSchema() {
  try {
    if (!fs.existsSync(REPORT_SCHEMA_PATH)) {
      return deepCloneJson(DEFAULT_HEALTHCARE_REPORT_SCHEMA);
    }

    const content = fs.readFileSync(REPORT_SCHEMA_PATH, "utf8");
    const parsed = JSON.parse(content);
    return normalizeAgainstTemplate(DEFAULT_HEALTHCARE_REPORT_SCHEMA, parsed);
  } catch (error) {
    console.warn("Failed to load healthcare_report_schema.json, using default schema.", error.message);
    return deepCloneJson(DEFAULT_HEALTHCARE_REPORT_SCHEMA);
  }
}

const REPORT_SCHEMA_TEMPLATE = loadReportSchema();

function normalizeHealthcareReport(candidate) {
  return normalizeAgainstTemplate(REPORT_SCHEMA_TEMPLATE, candidate);
}

function extractJsonObject(text) {
  if (!text || typeof text !== "string") {
    return null;
  }

  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed);
  } catch (_error) {
    // noop
  }

  const codeBlockStripped = trimmed.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(codeBlockStripped);
  } catch (_error) {
    // noop
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    } catch (_error) {
      return null;
    }
  }

  return null;
}

async function callGroqChat({ messages, temperature = 0.1, maxTokens = 1200 }) {
  const groqApiKey = process.env.GROQ_API_KEY;

  if (!groqApiKey) {
    const error = new Error("Missing GROQ_API_KEY in .env");
    error.status = 500;
    throw error;
  }

  const groqRes = await fetch(GROQ_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${groqApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature,
      max_tokens: maxTokens,
      messages,
    }),
  });

  const groqData = await groqRes.json().catch(() => ({}));

  if (!groqRes.ok) {
    const error = new Error("Groq request failed");
    error.status = groqRes.status;
    error.details = groqData;
    throw error;
  }

  return groqData;
}

app.use(cors());
app.use(express.json({ limit: "3mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/transcribe-chunk", upload.single("file"), async (req, res) => {
  try {
    const apiKey = process.env.SARVAM_API_SUBSCRIPTION_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error: "Missing SARVAM_API_SUBSCRIPTION_KEY in .env",
      });
    }

    if (!req.file) {
      return res.status(400).json({ error: "Audio file is required." });
    }

    const form = new FormData();
    form.append(
      "file",
      new Blob([req.file.buffer], { type: req.file.mimetype || "audio/webm" }),
      req.file.originalname || "chunk.webm"
    );

    if (req.body.model) {
      form.append("model", req.body.model);
    }

    if (req.body.mode) {
      form.append("mode", req.body.mode);
    }

    if (req.body.language_code) {
      form.append("language_code", req.body.language_code);
    }

    if (req.body.input_audio_codec) {
      form.append("input_audio_codec", req.body.input_audio_codec);
    }

    const sarvamRes = await fetch(SARVAM_STT_URL, {
      method: "POST",
      headers: {
        "api-subscription-key": apiKey,
      },
      body: form,
    });

    if (!sarvamRes.ok) {
      const errorText = await sarvamRes.text();
      return res.status(sarvamRes.status).json({
        error: "Sarvam request failed",
        details: errorText,
      });
    }

    const result = await sarvamRes.json();
    return res.json(result);
  } catch (error) {
    console.error("Transcription proxy error:", error);
    return res.status(500).json({
      error: "Internal server error",
      details: error.message,
    });
  }
});

app.post("/api/diarize", async (req, res) => {
  try {
    const transcript = String(req.body?.transcript || "").trim();

    if (!transcript) {
      return res.status(400).json({ error: "Transcript is required." });
    }

    const systemPrompt =
      "You are a medical conversation diarization assistant. The transcript is from a doctor-patient consultation. Split turns and label each line as Doctor: or Patient:. If uncertain, use Speaker 1: / Speaker 2:. Keep wording faithful and avoid adding details. Output plain text only.";

    const userPrompt = [
      "Diarize the transcript below in English for clinical documentation.",
      "Prefer labels Doctor and Patient.",
      "If only one speaker is present, use Doctor.",
      "Output format example:",
      "Doctor: ...",
      "Patient: ...",
      "Transcript:",
      transcript,
    ].join("\n");

    const groqData = await callGroqChat({
      temperature: 0.1,
      maxTokens: 1200,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    const diarizedText = groqData?.choices?.[0]?.message?.content?.trim();
    if (!diarizedText) {
      return res.status(502).json({
        error: "Groq response did not include diarized text",
        details: groqData,
      });
    }

    return res.json({
      diarized_transcript: diarizedText,
      model: GROQ_MODEL,
    });
  } catch (error) {
    console.error("Diarization proxy error:", error);
    return res.status(error.status || 500).json({
      error: "Internal server error",
      details: error.details || error.message,
    });
  }
});

app.post("/api/extract-report", async (req, res) => {
  try {
    const transcript = String(req.body?.transcript || "").trim();
    const diarizedTranscript = String(req.body?.diarized_transcript || "").trim();
    const sourceText = diarizedTranscript || transcript;

    if (!sourceText) {
      return res.status(400).json({ error: "Transcript is required." });
    }

    const schemaText = JSON.stringify(REPORT_SCHEMA_TEMPLATE, null, 2);
    const systemPrompt =
      "You are a clinical documentation assistant for doctor-patient conversations. Extract structured facts only from the provided transcript. Do not hallucinate and return valid JSON only.";

    const userPrompt = [
      "Create a structured healthcare report from this consultation transcript.",
      "Use exactly these keys and keep each value as an array of short English strings.",
      "If data is missing, keep the array empty.",
      "Schema:",
      schemaText,
      "Conversation transcript:",
      sourceText,
    ].join("\n\n");

    const groqData = await callGroqChat({
      temperature: 0,
      maxTokens: 1500,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    const content = groqData?.choices?.[0]?.message?.content || "";
    const parsedReport = extractJsonObject(content);

    if (!parsedReport) {
      return res.status(502).json({
        error: "Groq response did not include valid report JSON",
        details: content,
      });
    }

    const report = normalizeHealthcareReport(parsedReport);

    return res.json({
      report,
      model: GROQ_MODEL,
    });
  } catch (error) {
    console.error("Report extraction proxy error:", error);
    return res.status(error.status || 500).json({
      error: "Internal server error",
      details: error.details || error.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
