// ============================================================
// MeetPulse Offscreen Document
// Handles: getUserMedia (tab audio) → Deepgram WebSocket STT
//          → Backend WebSocket relay
// ============================================================

let dgSocket = null;
let backendSocket = null;
let mediaRecorder = null;
let meetingId = null;
let transcriptBuffer = [];
let silenceTimer = null;

chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg.type === "OFFSCREEN_START") {
    await startStreaming(msg.streamId, msg.dgKey, msg.meetingId, msg.backendWs);
  }
  if (msg.type === "OFFSCREEN_STOP") {
    stopStreaming();
  }
});

async function startStreaming(streamId, dgKey, mId, backendWs) {
  meetingId = mId;

  try {
    // Get tab audio stream
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId
        }
      },
      video: false
    });

    // ── Connect to Deepgram WebSocket ─────────────────────────
    const dgUrl = `wss://api.deepgram.com/v1/listen?` +
      `model=nova-2&` +
      `language=en-US&` +
      `smart_format=true&` +
      `diarize=true&` +
      `punctuate=true&` +
      `interim_results=true&` +
      `utterance_end_ms=1500&` +
      `vad_events=true`;

    dgSocket = new WebSocket(dgUrl, ["token", dgKey]);

    dgSocket.onopen = () => {
      console.log("[MeetPulse Offscreen] Deepgram connected");
      startMediaRecorder(stream);
    };

    dgSocket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      handleDeepgramMessage(data);
    };

    dgSocket.onerror = (err) => console.error("[MeetPulse Offscreen] Deepgram error:", err);
    dgSocket.onclose = () => console.log("[MeetPulse Offscreen] Deepgram closed");

    // ── Connect to Backend WebSocket ──────────────────────────
    backendSocket = new WebSocket(backendWs + `?meeting_id=${meetingId}`);

    backendSocket.onopen = () => {
      console.log("[MeetPulse Offscreen] Backend WS connected");
    };

    backendSocket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      // Intelligence from Groq arrives here
      chrome.runtime.sendMessage({ type: "INTELLIGENCE_UPDATE", data });
    };

    backendSocket.onerror = (err) => console.error("[MeetPulse Offscreen] Backend WS error:", err);

  } catch (err) {
    console.error("[MeetPulse Offscreen] Stream error:", err);
  }
}

function startMediaRecorder(stream) {
  // Use audio/webm for efficient codec
  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : "audio/webm";

  mediaRecorder = new MediaRecorder(stream, { mimeType });

  mediaRecorder.ondataavailable = (event) => {
    if (event.data.size > 0 && dgSocket?.readyState === WebSocket.OPEN) {
      dgSocket.send(event.data);
    }
  };

  // Send 250ms chunks for near-realtime latency
  mediaRecorder.start(250);
}

function handleDeepgramMessage(data) {
  // Handle VAD silence event
  if (data.type === "UtteranceEnd") {
    flushTranscriptToBackend();
    return;
  }

  if (data.type !== "Results") return;

  const alternatives = data.channel?.alternatives;
  if (!alternatives?.length) return;

  const transcript = alternatives[0].transcript?.trim();
  if (!transcript) return;

  const isFinal = data.is_final;
  const speaker = data.channel?.alternatives[0]?.words?.[0]?.speaker ?? 0;
  const confidence = alternatives[0].confidence ?? 0;

  const chunk = {
    text: transcript,
    speaker: `Speaker ${speaker + 1}`,
    is_final: isFinal,
    confidence,
    timestamp: Date.now(),
    meeting_id: meetingId
  };

  // Relay to content scripts for live display
  chrome.runtime.sendMessage({ type: "TRANSCRIPT_CHUNK", data: chunk });

  // Buffer finals for backend analysis
  if (isFinal) {
    transcriptBuffer.push(chunk);

    // Send to backend every 5 final sentences or after 10s
    resetSilenceFlush();
    if (transcriptBuffer.length >= 5) {
      flushTranscriptToBackend();
    }
  }
}

function resetSilenceFlush() {
  clearTimeout(silenceTimer);
  silenceTimer = setTimeout(flushTranscriptToBackend, 10000);
}

function flushTranscriptToBackend() {
  if (!transcriptBuffer.length) return;
  if (backendSocket?.readyState !== WebSocket.OPEN) return;

  const payload = {
    type: "TRANSCRIPT_BATCH",
    meeting_id: meetingId,
    segments: [...transcriptBuffer]
  };

  backendSocket.send(JSON.stringify(payload));
  transcriptBuffer = [];
}

function stopStreaming() {
  clearTimeout(silenceTimer);

  if (transcriptBuffer.length > 0) {
    flushTranscriptToBackend();
  }

  if (mediaRecorder?.state !== "inactive") mediaRecorder?.stop();

  if (dgSocket) {
    dgSocket.send(JSON.stringify({ type: "CloseStream" }));
    dgSocket.close();
    dgSocket = null;
  }

  // Signal backend to finalize the meeting
  if (backendSocket?.readyState === WebSocket.OPEN) {
    backendSocket.send(JSON.stringify({ type: "MEETING_END", meeting_id: meetingId }));
    setTimeout(() => {
      backendSocket?.close();
      backendSocket = null;
    }, 2000);
  }

  meetingId = null;
}
