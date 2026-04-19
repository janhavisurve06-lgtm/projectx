// ============================================================
// MeetPulse Popup Script
// ============================================================

const MEETING_PLATFORMS = ["meet.google.com", "zoom.us", "teams.microsoft.com"];

const btnStart = document.getElementById("btn-start");
const btnStop = document.getElementById("btn-stop");
const btnDebrief = document.getElementById("btn-debrief");
const statusIndicator = document.getElementById("status-indicator");
const statusLabel = document.getElementById("status-label");
const statusSub = document.getElementById("status-sub");

let currentTabId = null;
let meetingId = null;

async function init() {
  // Get current tab info
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  currentTabId = tab.id;
  const host = new URL(tab.url).hostname;
  const isMeeting = MEETING_PLATFORMS.some(p => host.includes(p));

  if (isMeeting) {
    setStatus("active", "Meeting detected", `${host}`);
    btnStart.disabled = false;
  }

  // Check capture status
  chrome.runtime.sendMessage({ type: "GET_STATUS" }, (resp) => {
    if (resp?.isCapturing) {
      setStatus("recording", "AI Capture Active", "Recording in progress...");
      btnStart.classList.add("hidden");
      btnStop.classList.remove("hidden");
    }
    if (resp?.meetingId) {
      meetingId = resp.meetingId;
    }
  });

  // Fetch meetingId from storage
  chrome.storage.local.get("meetingId", (data) => {
    if (data.meetingId) meetingId = data.meetingId;
  });
}

function setStatus(type, label, sub) {
  statusIndicator.className = `status-indicator ${type}`;
  statusLabel.textContent = label;
  statusSub.textContent = sub;
}

btnStart.addEventListener("click", async () => {
  // Get the meetingId from storage
  const { meetingId: mId } = await new Promise(resolve =>
    chrome.storage.local.get("meetingId", resolve)
  );

  chrome.runtime.sendMessage({
    type: "START_CAPTURE",
    tabId: currentTabId,
    meetingId: mId || "unknown"
  }, (resp) => {
    if (resp?.success) {
      setStatus("recording", "AI Capture Active", "Transcribing your meeting in real-time...");
      btnStart.classList.add("hidden");
      btnStop.classList.remove("hidden");
    }
  });
});

btnStop.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "STOP_CAPTURE" }, () => {
    setStatus("active", "Capture stopped", "Click start to resume");
    btnStop.classList.add("hidden");
    btnStart.classList.remove("hidden");
  });
});

btnDebrief.addEventListener("click", async () => {
  const { meetingId: mId } = await new Promise(resolve =>
    chrome.storage.local.get("meetingId", resolve)
  );

  if (!mId) {
    statusSub.textContent = "No active meeting to generate debrief for.";
    return;
  }

  statusSub.textContent = "Generating debrief with Groq...";

  const resp = await fetch(`${CONFIG.API_BASE_URL}/meetings/${mId}/debrief`, { method: "POST" });
  if (resp.ok) {
    statusSub.textContent = "Debrief sent to sidebar!";
    // Send to content script
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    chrome.tabs.sendMessage(tab.id, { type: "DEBRIEF_READY", data: await resp.json() });
  } else {
    statusSub.textContent = "Debrief failed. Is backend running?";
  }
});

// Hydrate links
document.getElementById("link-docs").href = `${CONFIG.API_BASE_URL}/docs`;
document.getElementById("link-meetings").href = `${CONFIG.API_BASE_URL}/meetings`;

init();
