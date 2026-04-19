// ============================================================
// MeetPulse Background Service Worker
// Handles: Tab Audio Capture → Deepgram STT → Backend relay
// ============================================================

const DEEPGRAM_API_KEY = "d0acdf94478d3d6564f2004b9d42c10cfd8d4007";
const BACKEND_WS = "ws://localhost:8080/ws/stream";

let dgSocket = null;
let mediaRecorder = null;
let activeTabId = null;
let meetingId = null;
let isCapturing = false;
let audioStream = null;

// ─── Message Router ─────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "START_CAPTURE") {
    startCapture(msg.tabId, msg.meetingId).then(() => {
      sendResponse({ success: true });
    }).catch(err => {
      console.error("[MeetPulse] Capture failed:", err);
      sendResponse({ success: false, error: err.message });
    });
    return true; // async
  }

  if (msg.type === "STOP_CAPTURE") {
    stopCapture();
    sendResponse({ success: true });
    return true;
  }

  if (msg.type === "GET_STATUS") {
    sendResponse({ isCapturing, meetingId, activeTabId });
    return true;
  }

  if (msg.type === "SCREENSHOT_TAKEN") {
    relayScreenshotToBackend(msg.imageDataUrl, msg.meetingId);
    return true;
  }
});

// ─── Tab Audio Capture ───────────────────────────────────────
async function startCapture(tabId, mId) {
  if (isCapturing) stopCapture();

  activeTabId = tabId;
  meetingId = mId;

  // Capture the tab's audio
  const streamId = await new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(id);
    });
  });

  // Get audio stream from the stream ID using offscreen if needed
  // In MV3 we use offscreen document to handle getUserMedia
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Tab audio capture for STT"
  }).catch(() => {}); // Already exists is fine

  // Notify offscreen to start streaming
  chrome.runtime.sendMessage({
    type: "OFFSCREEN_START",
    streamId,
    dgKey: DEEPGRAM_API_KEY,
    meetingId,
    backendWs: BACKEND_WS
  });

  isCapturing = true;
  broadcastToContent({ type: "CAPTURE_STARTED", meetingId });
}

function stopCapture() {
  if (!isCapturing) return;
  chrome.runtime.sendMessage({ type: "OFFSCREEN_STOP" });
  isCapturing = false;
  activeTabId = null;
  broadcastToContent({ type: "CAPTURE_STOPPED" });
}

async function relayScreenshotToBackend(imageDataUrl, mId) {
  try {
    await fetch(`http://localhost:8080/meetings/${mId}/screenshots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: imageDataUrl, timestamp: Date.now() })
    });
  } catch (err) {
    console.error("[MeetPulse] Screenshot relay failed:", err);
  }
}

// ─── Broadcast to all content scripts ───────────────────────
function broadcastToContent(msg) {
  chrome.tabs.query({ status: "complete" }, (tabs) => {
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
    });
  });
}

// ─── Listen for transcript + intelligence from offscreen ─────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "TRANSCRIPT_CHUNK") {
    broadcastToContent({ type: "TRANSCRIPT_CHUNK", data: msg.data });
  }
  if (msg.type === "INTELLIGENCE_UPDATE") {
    broadcastToContent({ type: "INTELLIGENCE_UPDATE", data: msg.data });
  }
  if (msg.type === "MEETING_ENDED") {
    broadcastToContent({ type: "MEETING_ENDED", data: msg.data });
    isCapturing = false;
  }
});
