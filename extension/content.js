// ============================================================
// MeetPulse Content Script
// Injected into: Google Meet, Zoom, Teams
// Handles: Sidebar injection, screenshot monitoring, messaging
// ============================================================

const BACKEND_URL = "http://localhost:8080";
const SCREENSHOT_INTERVAL_MS = 5000;   // Check every 5s
const SCREENSHOT_DIFF_THRESHOLD = 0.12; // 12% change = significant

let sidebarFrame = null;
let sidebarVisible = false;
let meetingId = null;
let screenshotInterval = null;
let lastScreenshotHash = null;
let isCapturing = false;

// ─── Initialization ──────────────────────────────────────────
(async function init() {
  // Small delay to let meeting page fully load
  await sleep(2500);
  injectSidebar();
  detectMeetingPlatform();
})();

// ─── Sidebar Injection ───────────────────────────────────────
function injectSidebar() {
  if (sidebarFrame) return;

  // Create the iframe sidebar
  sidebarFrame = document.createElement("iframe");
  sidebarFrame.id = "meetpulse-sidebar";
  sidebarFrame.src = chrome.runtime.getURL("sidebar.html");
  sidebarFrame.style.cssText = `
    position: fixed;
    top: 0;
    right: -420px;
    width: 400px;
    height: 100vh;
    z-index: 2147483647;
    border: none;
    border-radius: 0;
    background: transparent;
    transition: right 0.4s cubic-bezier(0.4, 0, 0.2, 1);
    pointer-events: auto;
  `;

  // Inject toggle button
  const toggleBtn = document.createElement("div");
  toggleBtn.id = "meetpulse-toggle";
  toggleBtn.innerHTML = `
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z" fill="white"/>
    </svg>
    <span>MeetPulse</span>
  `;
  toggleBtn.style.cssText = `
    position: fixed;
    right: 0;
    top: 50%;
    transform: translateY(-50%);
    background: linear-gradient(135deg, #1a73e8, #0d47a1);
    color: white;
    padding: 12px 8px;
    border-radius: 12px 0 0 12px;
    cursor: pointer;
    z-index: 2147483646;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    font-family: 'Google Sans', sans-serif;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.5px;
    box-shadow: -4px 0 20px rgba(26, 115, 232, 0.4);
    transition: all 0.3s ease;
    writing-mode: horizontal-tb;
    min-width: 40px;
  `;

  toggleBtn.addEventListener("click", toggleSidebar);
  toggleBtn.addEventListener("mouseenter", () => {
    toggleBtn.style.boxShadow = "-6px 0 30px rgba(26, 115, 232, 0.7)";
  });
  toggleBtn.addEventListener("mouseleave", () => {
    toggleBtn.style.boxShadow = "-4px 0 20px rgba(26, 115, 232, 0.4)";
  });

  document.body.appendChild(sidebarFrame);
  document.body.appendChild(toggleBtn);
}

function toggleSidebar() {
  sidebarVisible = !sidebarVisible;
  if (sidebarVisible) {
    sidebarFrame.style.right = "0";
  } else {
    sidebarFrame.style.right = "-420px";
  }
}

// ─── Meeting Detection ───────────────────────────────────────
function detectMeetingPlatform() {
  const host = window.location.hostname;
  let platform = "unknown";

  if (host.includes("meet.google.com")) platform = "google_meet";
  else if (host.includes("zoom.us")) platform = "zoom";
  else if (host.includes("teams.microsoft.com")) platform = "teams";

  if (platform !== "unknown") {
    // Extract meeting code from URL
    const urlParts = window.location.pathname.split("/").filter(Boolean);
    const meetingCode = urlParts[urlParts.length - 1] || "unknown";

    chrome.storage.local.get("meetingId", async (data) => {
      if (data.meetingId) {
        meetingId = data.meetingId;
        postToSidebar({ type: "MEETING_RESUMED", meetingId, platform });
      } else {
        await startNewMeeting(platform, meetingCode);
      }
    });
  }
}

async function startNewMeeting(platform, meetingCode) {
  try {
    const resp = await fetch(`${BACKEND_URL}/meetings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform, meeting_code: meetingCode, title: document.title })
    });
    const data = await resp.json();
    meetingId = data.id;

    chrome.storage.local.set({ meetingId });

    // Auto-open sidebar for new meetings
    sidebarVisible = true;
    sidebarFrame.style.right = "0";

    postToSidebar({ type: "MEETING_STARTED", meetingId, platform, meeting_code: meetingCode });
  } catch (err) {
    console.error("[MeetPulse] Failed to register meeting:", err);
  }
}

// ─── Screenshot Monitor ──────────────────────────────────────
function startScreenshotMonitor() {
  if (screenshotInterval) return;

  screenshotInterval = setInterval(async () => {
    try {
      // Use Chrome tab screenshot API via messaging background
      const screenshotDataUrl = await captureVisibleTab();
      if (!screenshotDataUrl) return;

      const hash = await hashImage(screenshotDataUrl);

      // Check if the screen has changed significantly
      if (lastScreenshotHash && !isSignificantChange(hash, lastScreenshotHash)) return;

      lastScreenshotHash = hash;

      // Send to background → backend
      chrome.runtime.sendMessage({
        type: "SCREENSHOT_TAKEN",
        imageDataUrl: screenshotDataUrl,
        meetingId
      });

      // Display in sidebar
      postToSidebar({
        type: "SCREENSHOT_CAPTURED",
        imageDataUrl: screenshotDataUrl,
        timestamp: Date.now()
      });
    } catch (err) {
      // Silent fail on screenshot
    }
  }, SCREENSHOT_INTERVAL_MS);
}

async function captureVisibleTab() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "CAPTURE_SCREENSHOT" }, (response) => {
      resolve(response?.dataUrl || null);
    });
  });
}

async function hashImage(dataUrl) {
  const text = dataUrl.substring(0, 5000); // Sample beginning
  const buffer = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function isSignificantChange(hashA, hashB) {
  // Simple Hamming distance on hash strings
  let diff = 0;
  for (let i = 0; i < Math.min(hashA.length, hashB.length); i++) {
    if (hashA[i] !== hashB[i]) diff++;
  }
  return diff > hashA.length * SCREENSHOT_DIFF_THRESHOLD;
}

// ─── Receive messages from background ───────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "CAPTURE_STARTED") {
    isCapturing = true;
    startScreenshotMonitor();
    postToSidebar({ type: "CAPTURE_STARTED", meetingId: msg.meetingId });
  }

  if (msg.type === "CAPTURE_STOPPED") {
    isCapturing = false;
    if (screenshotInterval) {
      clearInterval(screenshotInterval);
      screenshotInterval = null;
    }
    postToSidebar({ type: "CAPTURE_STOPPED" });
  }

  if (msg.type === "TRANSCRIPT_CHUNK") {
    postToSidebar({ type: "TRANSCRIPT_CHUNK", data: msg.data });
  }

  if (msg.type === "INTELLIGENCE_UPDATE") {
    postToSidebar({ type: "INTELLIGENCE_UPDATE", data: msg.data });
  }

  if (msg.type === "MEETING_ENDED") {
    postToSidebar({ type: "MEETING_ENDED", data: msg.data });
    chrome.storage.local.remove("meetingId");
    meetingId = null;
  }
});

// ─── Receive messages from sidebar iframe ───────────────────
window.addEventListener("message", (event) => {
  if (!event.data?.source === "meetpulse-sidebar") return;

  const msg = event.data;

  if (msg.type === "REQUEST_START") {
    chrome.runtime.sendMessage({
      type: "START_CAPTURE",
      tabId: undefined, // background will use active tab
      meetingId
    });
  }

  if (msg.type === "REQUEST_STOP") {
    chrome.runtime.sendMessage({ type: "STOP_CAPTURE" });
  }

  if (msg.type === "REQUEST_DEBRIEF") {
    generateDebrief();
  }

  if (msg.type === "CLOSE_SIDEBAR") {
    toggleSidebar();
  }
});

async function generateDebrief() {
  if (!meetingId) return;
  try {
    const resp = await fetch(`${BACKEND_URL}/meetings/${meetingId}/debrief`, { method: "POST" });
    const data = await resp.json();
    postToSidebar({ type: "DEBRIEF_READY", data });
  } catch (err) {
    console.error("[MeetPulse] Debrief generation failed:", err);
  }
}

// ─── Helpers ─────────────────────────────────────────────────
function postToSidebar(data) {
  if (!sidebarFrame?.contentWindow) return;
  sidebarFrame.contentWindow.postMessage({ ...data, source: "meetpulse-content" }, "*");
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
