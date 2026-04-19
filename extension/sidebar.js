// ============================================================
// MeetPulse Sidebar JavaScript
// Handles: State management, UI rendering, message relay
// ============================================================

const BACKEND_URL = CONFIG.API_BASE_URL;
const SPEAKER_COLORS = ["s0", "s1", "s2", "s3", "s4", "s5"];

let state = {
  meetingId: null,
  platform: null,
  isCapturing: false,
  startTime: null,
  durationTimer: null,
  wordCount: 0,
  actionCount: 0,
  screenshotCount: 0,
  actions: [],
  speakerMap: {},
  speakerColorCounter: 0
};

// ─── DOM References ──────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const els = {
  statusDot: document.querySelector(".status-dot"),
  statusText: $("status-text"),
  btnStart: $("btn-start"),
  btnStop: $("btn-stop"),
  btnDebrief: $("btn-debrief"),
  btnClose: $("btn-close"),
  meetingPlatform: $("meeting-platform"),
  meetingDuration: $("meeting-duration"),
  statWords: $("stat-words"),
  statActions: $("stat-actions"),
  statScreenshots: $("stat-screenshots"),
  transcriptEmpty: $("transcript-empty"),
  transcriptFeed: $("transcript-feed"),
  summaryBody: $("summary-body"),
  decisionsList: $("decisions-list"),
  questionsList: $("questions-list"),
  debtList: $("debt-list"),
  actionsList: $("actions-list"),
  actionsCount: $("actions-count"),
  btnCopyActions: $("btn-copy-actions"),
  galleryGrid: $("gallery-grid"),
  debriefOverlay: $("debrief-overlay"),
  debriefContent: $("debrief-content"),
  btnCopyDebrief: $("btn-copy-debrief"),
  btnCloseDebrief: $("btn-close-debrief"),
  btnCloseDebrief2: $("btn-close-debrief2"),
  toast: $("toast")
};

// ─── Tab Navigation ──────────────────────────────────────────
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const tabId = btn.dataset.tab;

    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-pane").forEach(p => {
      p.classList.add("hidden");
      p.classList.remove("active");
    });

    btn.classList.add("active");
    const pane = $(`tab-${tabId}`);
    if (pane) {
      pane.classList.remove("hidden");
      pane.classList.add("active");
    }
  });
});

// ─── Header Buttons ──────────────────────────────────────────
els.btnStart.addEventListener("click", () => {
  window.parent.postMessage({ type: "REQUEST_START", source: "meetpulse-sidebar" }, "*");
});

els.btnStop.addEventListener("click", () => {
  window.parent.postMessage({ type: "REQUEST_STOP", source: "meetpulse-sidebar" }, "*");
});

els.btnDebrief.addEventListener("click", () => {
  window.parent.postMessage({ type: "REQUEST_DEBRIEF", source: "meetpulse-sidebar" }, "*");
  showToast("Generating debrief with Groq...");
});

els.btnClose.addEventListener("click", () => {
  window.parent.postMessage({ type: "CLOSE_SIDEBAR", source: "meetpulse-sidebar" }, "*");
});

els.btnCopyActions.addEventListener("click", () => {
  const text = state.actions.map((a, i) =>
    `${i + 1}. ${a.text}${a.assignee ? ` (@${a.assignee})` : ""} — ${a.priority || "medium"} priority`
  ).join("\n");
  navigator.clipboard.writeText(text).then(() => showToast("Actions copied!"));
});

els.btnCopyDebrief.addEventListener("click", () => {
  navigator.clipboard.writeText(els.debriefContent.textContent).then(() => showToast("Debrief copied!"));
});

[els.btnCloseDebrief, els.btnCloseDebrief2].forEach(btn => {
  btn?.addEventListener("click", () => {
    els.debriefOverlay.classList.add("hidden");
  });
});

// ─── Message Handler (from content.js) ──────────────────────
window.addEventListener("message", (event) => {
  if (!event.data?.source === "meetpulse-content") return;
  handleMessage(event.data);
});

function handleMessage(msg) {
  switch (msg.type) {
    case "MEETING_STARTED":
      onMeetingStarted(msg);
      break;
    case "MEETING_RESUMED":
      onMeetingResumed(msg);
      break;
    case "CAPTURE_STARTED":
      onCaptureStarted(msg);
      break;
    case "CAPTURE_STOPPED":
      onCaptureStopped();
      break;
    case "TRANSCRIPT_CHUNK":
      onTranscriptChunk(msg.data);
      break;
    case "INTELLIGENCE_UPDATE":
      onIntelligenceUpdate(msg.data);
      break;
    case "SCREENSHOT_CAPTURED":
      onScreenshotCaptured(msg);
      break;
    case "MEETING_ENDED":
      onMeetingEnded(msg.data);
      break;
    case "DEBRIEF_READY":
      onDebriefReady(msg.data);
      break;
  }
}

// ─── Event Handlers ──────────────────────────────────────────
function onMeetingStarted({ meetingId, platform }) {
  state.meetingId = meetingId;
  state.platform = platform;
  state.startTime = Date.now();

  const platformLabels = {
    google_meet: "Google Meet",
    zoom: "Zoom",
    teams: "Microsoft Teams"
  };

  els.meetingPlatform.textContent = platformLabels[platform] || platform;
  setStatus("ready", "Joined");
  showToast(`Meeting detected on ${platformLabels[platform] || platform}`);
  loadDebtLog();
}

function onMeetingResumed({ meetingId, platform }) {
  onMeetingStarted({ meetingId, platform });
}

function onCaptureStarted({ meetingId }) {
  state.isCapturing = true;
  state.startTime = state.startTime || Date.now();

  els.btnStart.classList.add("hidden");
  els.btnStop.classList.remove("hidden");
  setStatus("recording", "Recording");
  startDurationTimer();
  showToast("AI capture started");
}

function onCaptureStopped() {
  state.isCapturing = false;
  els.btnStart.classList.remove("hidden");
  els.btnStop.classList.add("hidden");
  setStatus("ready", "Paused");
  stopDurationTimer();
  showToast("Capture paused");
}

function onTranscriptChunk(chunk) {
  const { text, speaker, is_final, timestamp } = chunk;

  // Show feed, hide empty state
  if (els.transcriptEmpty && !els.transcriptEmpty.classList.contains("hidden")) {
    els.transcriptEmpty.classList.add("hidden");
    els.transcriptFeed.classList.remove("hidden");
  }

  // Get or assign speaker color
  if (!state.speakerMap[speaker]) {
    const colorClass = SPEAKER_COLORS[state.speakerColorCounter % SPEAKER_COLORS.length];
    state.speakerColorCounter++;
    state.speakerMap[speaker] = {
      color: colorClass,
      initial: (speaker || "S").charAt(speaker.length - 1)
    };
  }

  const { color, initial } = state.speakerMap[speaker];
  const timeStr = formatTime(timestamp);

  // Update last bubble if interim, or create new
  const existingInterim = els.transcriptFeed.querySelector(".interim");
  if (existingInterim && !is_final) {
    existingInterim.querySelector(".transcript-bubble").textContent = text;
    return;
  }

  if (existingInterim) {
    existingInterim.querySelector(".transcript-bubble").textContent = text;
    existingInterim.querySelector(".transcript-bubble").classList.remove("interim");
    existingInterim.dataset.final = "true";
    updateWordCount(text);
    return;
  }

  const msgEl = document.createElement("div");
  msgEl.className = `transcript-msg${is_final ? "" : " interim"}`;
  msgEl.dataset.final = is_final ? "true" : "false";
  msgEl.innerHTML = `
    <div class="transcript-meta">
      <div class="speaker-avatar ${color}">${initial}</div>
      <span class="speaker-name">${speaker}</span>
      <span class="transcript-time">${timeStr}</span>
    </div>
    <div class="transcript-bubble${is_final ? "" : " interim"}">${escapeHtml(text)}</div>
  `;

  els.transcriptFeed.appendChild(msgEl);
  els.transcriptFeed.parentElement.scrollTop = els.transcriptFeed.parentElement.scrollHeight;

  if (is_final) updateWordCount(text);
}

function onIntelligenceUpdate(data) {
  const { summary, actions, decisions, questions } = data;

  // Update rolling summary
  if (summary) {
    els.summaryBody.textContent = summary;
    animateElement(els.summaryBody);
  }

  // Update decisions
  if (decisions?.length) {
    els.decisionsList.innerHTML = decisions.map(d => `
      <div class="intel-item">✅ ${escapeHtml(d)}</div>
    `).join("");
  }

  // Update open questions
  if (questions?.length) {
    els.questionsList.innerHTML = questions.map(q => `
      <div class="intel-item">❓ ${escapeHtml(q)}</div>
    `).join("");
  }

  // Update action items
  if (actions?.length) {
    actions.forEach(action => {
      if (!state.actions.find(a => a.text === action.text)) {
        state.actions.push(action);
        renderActionCard(action);
        state.actionCount++;
        els.statActions.textContent = state.actionCount;
        els.actionsCount.textContent = `${state.actionCount} action item${state.actionCount !== 1 ? "s" : ""}`;

        // Highlight transcript bubble if it mentions this
        highlightActionInTranscript(action.text);
      }
    });
  }
}

function renderActionCard(action) {
  // Remove empty state if present
  const empty = els.actionsList.querySelector(".empty-state");
  if (empty) empty.remove();

  const card = document.createElement("div");
  card.className = "action-card";
  card.innerHTML = `
    <div class="action-check" data-done="false">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="white" class="check-icon" style="display:none">
        <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
      </svg>
    </div>
    <div class="action-body">
      <div class="action-text">${escapeHtml(action.text)}</div>
      <div class="action-meta">
        ${action.assignee ? `<span class="action-assignee">👤 ${escapeHtml(action.assignee)}</span>` : ""}
        <span class="action-priority priority-${action.priority || "medium"}">${action.priority || "medium"}</span>
      </div>
    </div>
  `;

  const check = card.querySelector(".action-check");
  check.addEventListener("click", () => {
    const done = check.dataset.done === "true";
    check.dataset.done = !done;
    check.classList.toggle("done", !done);
    check.querySelector(".check-icon").style.display = done ? "none" : "block";
  });

  els.actionsList.appendChild(card);
}

function onScreenshotCaptured({ imageDataUrl, timestamp }) {
  state.screenshotCount++;
  els.statScreenshots.textContent = state.screenshotCount;

  // Remove empty state
  const empty = els.galleryGrid.querySelector(".empty-state");
  if (empty) empty.remove();

  const item = document.createElement("div");
  item.className = "gallery-item";
  item.innerHTML = `
    <img src="${imageDataUrl}" alt="Screen capture at ${formatTime(timestamp)}" loading="lazy" />
    <div class="gallery-timestamp">${formatTime(timestamp)}</div>
  `;

  item.addEventListener("click", () => {
    const win = window.open();
    win.document.write(`<img src="${imageDataUrl}" style="max-width:100%;height:auto"/>`);
  });

  els.galleryGrid.prepend(item);
  animateElement(item);
}

function onMeetingEnded(data) {
  setStatus("ready", "Meeting ended");
  stopDurationTimer();
  els.btnStart.classList.remove("hidden");
  els.btnStop.classList.add("hidden");
  showToast("Meeting ended. Generating debrief...");

  if (data?.debrief) {
    onDebriefReady({ debrief: data.debrief });
  }
}

function onDebriefReady({ debrief }) {
  els.debriefContent.textContent = debrief;
  els.debriefOverlay.classList.remove("hidden");
}

// ─── Debt Log ─────────────────────────────────────────────────
async function loadDebtLog() {
  try {
    const resp = await fetch(`${BACKEND_URL}/debt-log`);
    const data = await resp.json();

    if (data.topics?.length) {
      els.debtList.innerHTML = data.topics.map(t => `
        <div class="debt-item">
          <div class="debt-topic">${escapeHtml(t.topic)}</div>
          <span class="debt-count">🔁 Mentioned ${t.count}x across meetings</span>
        </div>
      `).join("");
    } else {
      els.debtList.innerHTML = `<div class="intel-empty">No recurring topics yet</div>`;
    }
  } catch {
    els.debtList.innerHTML = `<div class="intel-empty">Could not load debt log</div>`;
  }
}

// ─── Utilities ────────────────────────────────────────────────
function setStatus(type, label) {
  els.statusDot.className = `status-dot ${type}`;
  els.statusText.textContent = label;
}

function startDurationTimer() {
  if (state.durationTimer) clearInterval(state.durationTimer);
  state.durationTimer = setInterval(() => {
    const elapsed = Math.floor((Date.now() - state.startTime) / 1000);
    const m = String(Math.floor(elapsed / 60)).padStart(2, "0");
    const s = String(elapsed % 60).padStart(2, "0");
    els.meetingDuration.textContent = `${m}:${s}`;
  }, 1000);
}

function stopDurationTimer() {
  if (state.durationTimer) {
    clearInterval(state.durationTimer);
    state.durationTimer = null;
  }
}

function updateWordCount(text) {
  state.wordCount += text.split(/\s+/).filter(Boolean).length;
  els.statWords.textContent = state.wordCount;
}

function formatTime(ts) {
  const d = ts ? new Date(ts) : new Date();
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function escapeHtml(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function showToast(msg, duration = 3000) {
  els.toast.textContent = msg;
  els.toast.classList.remove("hidden");
  setTimeout(() => els.toast.classList.add("hidden"), duration);
}

function animateElement(el) {
  el.style.animation = "none";
  el.offsetHeight; // reflow
  el.style.animation = "fadeSlideIn 0.3s ease";
}

function highlightActionInTranscript(actionText) {
  // Find last matching bubble and highlight it
  const bubbles = els.transcriptFeed.querySelectorAll(".transcript-bubble:not(.has-action)");
  const lower = actionText.toLowerCase();
  for (let i = bubbles.length - 1; i >= 0; i--) {
    if (bubbles[i].textContent.toLowerCase().includes(lower.substring(0, 30))) {
      bubbles[i].classList.add("has-action");
      break;
    }
  }
}

// ─── Init: fetch current meeting status from bg ──────────────
(async function init() {
  try {
    const resp = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "GET_STATUS" }, resolve);
    });
    if (resp?.isCapturing) {
      onCaptureStarted({ meetingId: resp.meetingId });
    }
    if (resp?.meetingId) {
      state.meetingId = resp.meetingId;
    }
  } catch {
    // Not in extension context (e.g., direct file open)
  }
})();
