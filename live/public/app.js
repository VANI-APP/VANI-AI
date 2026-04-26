const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const statusEl = document.getElementById("status");
const transcriptEl = document.getElementById("transcript");
const diarizedTranscriptEl = document.getElementById("diarizedTranscript");
const reportJsonEl = document.getElementById("reportJson");
const eventsEl = document.getElementById("events");
const modelEl = document.getElementById("model");
const modeEl = document.getElementById("mode");
const languageCodeEl = document.getElementById("languageCode");
const chunkMsEl = document.getElementById("chunkMs");
const diarizeNowBtn = document.getElementById("diarizeNowBtn");
const extractNowBtn = document.getElementById("extractNowBtn");
const useGroqDiarizationEl = document.getElementById("useGroqDiarization");
const useLiveExtractionEl = document.getElementById("useLiveExtraction");

let mediaRecorder = null;
let stream = null;
let isRecording = false;
let chunkIndex = 0;
let queue = [];
let processingQueue = false;
let activeMimeType = "audio/webm";
let rawTranscript = "";
let diarizeDebounceId = null;
let diarizeInFlight = false;
let extractDebounceId = null;
let extractInFlight = false;

function setStatus(text) {
  statusEl.textContent = text;
}

function logEvent(text) {
  const ts = new Date().toLocaleTimeString();
  eventsEl.textContent = `[${ts}] ${text}\n` + eventsEl.textContent;
}

function appendTranscript(text) {
  if (!text) {
    return;
  }

  rawTranscript = rawTranscript ? `${rawTranscript.trim()} ${text}` : text;
  transcriptEl.value = rawTranscript.trim();
}

function scheduleDiarization() {
  if (!useGroqDiarizationEl.checked) {
    return;
  }

  if (diarizeDebounceId) {
    clearTimeout(diarizeDebounceId);
  }

  diarizeDebounceId = setTimeout(() => {
    runDiarization();
  }, 1400);
}

function scheduleExtraction() {
  if (!useLiveExtractionEl.checked) {
    return;
  }

  if (extractDebounceId) {
    clearTimeout(extractDebounceId);
  }

  extractDebounceId = setTimeout(() => {
    runExtraction();
  }, 1800);
}

async function runDiarization() {
  const transcript = rawTranscript.trim();
  if (!transcript) {
    return;
  }

  if (diarizeInFlight) {
    return;
  }

  diarizeInFlight = true;
  diarizeNowBtn.disabled = true;

  try {
    const response = await fetch("/api/diarize", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ transcript }),
    });

    if (!response.ok) {
      const errorPayload = await response.json().catch(() => ({}));
      throw new Error(errorPayload.error || "Diarization failed");
    }

    const result = await response.json();
    diarizedTranscriptEl.value = result.diarized_transcript || "";
    logEvent(`diarized with ${result.model || "Groq"}`);
    scheduleExtraction();
  } catch (error) {
    logEvent(`diarization failed: ${error.message}`);
  } finally {
    diarizeInFlight = false;
    diarizeNowBtn.disabled = false;
  }
}

async function runExtraction() {
  const transcript = rawTranscript.trim();
  if (!transcript) {
    return;
  }

  if (extractInFlight) {
    return;
  }

  extractInFlight = true;
  extractNowBtn.disabled = true;

  try {
    const response = await fetch("/api/extract-report", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        transcript,
        diarized_transcript: diarizedTranscriptEl.value.trim(),
      }),
    });

    if (!response.ok) {
      const errorPayload = await response.json().catch(() => ({}));
      throw new Error(errorPayload.error || "Report extraction failed");
    }

    const result = await response.json();
    reportJsonEl.value = JSON.stringify(result.report || {}, null, 2);
    logEvent(`report extracted with ${result.model || "Groq"}`);
  } catch (error) {
    logEvent(`extraction failed: ${error.message}`);
  } finally {
    extractInFlight = false;
    extractNowBtn.disabled = false;
  }
}

function updateButtons(recording) {
  startBtn.disabled = recording;
  stopBtn.disabled = !recording;
}

function extensionFromMimeType(mimeType) {
  if (!mimeType) {
    return "webm";
  }

  if (mimeType.includes("ogg")) {
    return "ogg";
  }

  if (mimeType.includes("mp4")) {
    return "m4a";
  }

  if (mimeType.includes("webm")) {
    return "webm";
  }

  return "webm";
}

async function sendChunk(blob, index) {
  const fd = new FormData();
  const selectedModel = modelEl.value;
  const fileExtension = extensionFromMimeType(blob.type || activeMimeType);
  fd.append("file", blob, `chunk-${index}.${fileExtension}`);
  fd.append("model", selectedModel);

  const mode = modeEl.value;
  if (mode && selectedModel === "saaras:v3") {
    fd.append("mode", mode);
  }

  const languageCode = languageCodeEl.value;
  if (languageCode) {
    fd.append("language_code", languageCode);
  }

  const response = await fetch("/api/transcribe-chunk", {
    method: "POST",
    body: fd,
  });

  if (!response.ok) {
    const errorPayload = await response.json().catch(() => ({}));
    throw new Error(errorPayload.details || errorPayload.error || `HTTP ${response.status}`);
  }

  return response.json();
}

function recordSingleChunk(chunkMs) {
  return new Promise((resolve, reject) => {
    if (!stream) {
      reject(new Error("Audio stream is not available."));
      return;
    }

    const parts = [];
    mediaRecorder = new MediaRecorder(stream, activeMimeType ? { mimeType: activeMimeType } : undefined);

    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        parts.push(event.data);
      }
    };

    mediaRecorder.onerror = (event) => {
      reject(new Error(event.error?.message || "Recorder error"));
    };

    mediaRecorder.onstop = () => {
      const blob = new Blob(parts, { type: activeMimeType || "audio/webm" });
      resolve(blob);
    };

    mediaRecorder.start();

    setTimeout(() => {
      if (mediaRecorder && mediaRecorder.state !== "inactive") {
        mediaRecorder.stop();
      }
    }, chunkMs);
  });
}

async function captureLoop(chunkMs) {
  while (isRecording) {
    chunkIndex += 1;
    const currentIndex = chunkIndex;

    try {
      const blob = await recordSingleChunk(chunkMs);

      if (!isRecording && blob.size === 0) {
        break;
      }

      if (blob.size > 0) {
        queue.push({ blob, index: currentIndex });
        processQueue();
      } else {
        logEvent(`chunk ${currentIndex} skipped: empty audio`);
      }
    } catch (error) {
      logEvent(`capture failed on chunk ${currentIndex}: ${error.message}`);
      break;
    }
  }
}

async function processQueue() {
  if (processingQueue) {
    return;
  }

  processingQueue = true;
  try {
    while (queue.length > 0) {
      const item = queue.shift();
      try {
        const result = await sendChunk(item.blob, item.index);
        const transcript = result.transcript || "";
        appendTranscript(transcript);
        scheduleDiarization();
        scheduleExtraction();
        logEvent(`chunk ${item.index}: ${transcript || "(empty transcript)"}`);
      } catch (error) {
        logEvent(`chunk ${item.index} failed: ${error.message}`);
      }
    }
  } finally {
    processingQueue = false;
  }
}

async function startRecording() {
  if (isRecording) {
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    alert("Your browser does not support microphone capture.");
    return;
  }

  const chunkMs = Number(chunkMsEl.value);
  if (!Number.isFinite(chunkMs) || chunkMs < 300) {
    alert("Chunk duration must be >= 300 ms");
    return;
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
      },
    });

    const mimeCandidates = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/mp4",
    ];

    const mimeType = mimeCandidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
    activeMimeType = mimeType || "audio/webm";

    chunkIndex = 0;
    queue = [];
    rawTranscript = "";
    transcriptEl.value = "";
    diarizedTranscriptEl.value = "";
    reportJsonEl.value = "";
    isRecording = true;
    updateButtons(true);
    setStatus("Recording");
    logEvent(`recording started (${chunkMs} ms chunks, ${activeMimeType})`);
    captureLoop(chunkMs);
  } catch (error) {
    logEvent(`start failed: ${error.message}`);
    setStatus("Error");
  }
}

function stopRecording() {
  if (!isRecording) {
    return;
  }

  isRecording = false;

  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }

  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
  }

  mediaRecorder = null;
  stream = null;

  updateButtons(false);
  setStatus("Idle");
  logEvent("recording stopped");

  if (useGroqDiarizationEl.checked && rawTranscript.trim()) {
    runDiarization();
  }

  if (useLiveExtractionEl.checked && rawTranscript.trim()) {
    runExtraction();
  }
}

startBtn.addEventListener("click", startRecording);
stopBtn.addEventListener("click", stopRecording);
diarizeNowBtn.addEventListener("click", runDiarization);
extractNowBtn.addEventListener("click", runExtraction);
