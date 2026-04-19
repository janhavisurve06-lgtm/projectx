# ============================================================
# MeetPulse — FastAPI Main Application
# WebSocket stream processor + REST API orchestration
# ============================================================

import asyncio
import json
import os
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Dict, Set

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from db.mongo import ping_db, close_db, get_db
from ai.groq_client import get_groq_client
from models import TranscriptSegment, ActionItem
from routes.meetings import router as meetings_router
from routes.debrief import router as debrief_router
from routes.debt_log import router as debt_log_router


# ─── Lifespan (startup / shutdown) ──────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    print("============================================")
    print("  MeetPulse Backend Starting...")
    print("============================================")

    # Verify DB connection
    db_ok = await ping_db()
    if db_ok:
        print("  [OK] MongoDB Atlas connected")
    else:
        print("  [ERROR] MongoDB connection FAILED - check .env")

    # Warm up Groq client
    try:
        get_groq_client()
        print("  [OK] Groq client initialized")
    except Exception as e:
        print(f"  [ERROR] Groq init failed: {e}")

    print(f"  [OK] Listening on http://localhost:{os.getenv('PORT', 8000)}")
    print("============================================")

    yield

    # Cleanup
    await close_db()
    print("[MeetPulse] Server shutting down cleanly.")


# ─── App Factory ─────────────────────────────────────────────
app = FastAPI(
    title="MeetPulse API",
    description="AI-Powered Live Meeting Intelligence System — Backend",
    version="1.0.0",
    lifespan=lifespan
)

# ─── CORS ────────────────────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Routers ─────────────────────────────────────────────────
app.include_router(meetings_router)
app.include_router(debrief_router)
app.include_router(debt_log_router)


# ─── WebSocket Connection Manager ────────────────────────────
class ConnectionManager:
    """Manages active WebSocket connections per meeting."""

    def __init__(self):
        # meeting_id → set of WebSocket connections
        self.active: Dict[str, Set[WebSocket]] = {}

    async def connect(self, ws: WebSocket, meeting_id: str):
        await ws.accept()
        if meeting_id not in self.active:
            self.active[meeting_id] = set()
        self.active[meeting_id].add(ws)
        print(f"[WS] Client connected to meeting {meeting_id}")

    def disconnect(self, ws: WebSocket, meeting_id: str):
        if meeting_id in self.active:
            self.active[meeting_id].discard(ws)
        print(f"[WS] Client disconnected from meeting {meeting_id}")

    async def broadcast(self, meeting_id: str, data: dict):
        """Send message to all connections for a meeting."""
        if meeting_id not in self.active:
            return
        dead = set()
        for ws in self.active[meeting_id]:
            try:
                await ws.send_json(data)
            except Exception:
                dead.add(ws)
        for ws in dead:
            self.active[meeting_id].discard(ws)


manager = ConnectionManager()

# ─── Active transcript buffers per meeting ───────────────────
# meeting_id → list of collected final segments since last Groq call
_buffers: Dict[str, list] = {}
_buffer_tasks: Dict[str, asyncio.Task] = {}
GROQ_TRIGGER_SENTENCES = 5   # trigger after 5 final sentences
GROQ_TRIGGER_SECONDS = 15    # or after 15 seconds of speech


# ─── WebSocket: Extension Audio Stream ───────────────────────
@app.websocket("/ws/stream")
async def ws_stream(ws: WebSocket, meeting_id: str = "unknown"):
    """
    Receives transcript batches from the extension's offscreen worker.
    Runs Groq inference and broadcasts intelligence back.
    """
    await manager.connect(ws, meeting_id)

    if meeting_id not in _buffers:
        _buffers[meeting_id] = []

    try:
        while True:
            raw = await ws.receive_text()
            msg = json.loads(raw)

            msg_type = msg.get("type")

            if msg_type == "TRANSCRIPT_BATCH":
                segments_data = msg.get("segments", [])
                segments = [TranscriptSegment(**s) for s in segments_data]

                # Store in MongoDB incrementally
                db = get_db()
                await db.meetings.update_one(
                    {"id": meeting_id},
                    {"$push": {"transcript": {"$each": [s.model_dump() for s in segments]}}}
                )

                # Add to buffer for Groq
                _buffers[meeting_id].extend(segments)

                # Trigger Groq analysis if buffer is large enough
                if len(_buffers[meeting_id]) >= GROQ_TRIGGER_SENTENCES:
                    await run_groq_analysis(meeting_id, ws)

            elif msg_type == "MEETING_END":
                await handle_meeting_end(meeting_id)
                await ws.send_json({"type": "MEETING_ENDED", "meeting_id": meeting_id})

    except WebSocketDisconnect:
        manager.disconnect(ws, meeting_id)
    except Exception as e:
        print(f"[WS] Error in stream for {meeting_id}: {e}")
        manager.disconnect(ws, meeting_id)


async def run_groq_analysis(meeting_id: str, ws: WebSocket):
    """
    Run Groq intelligence extraction on buffered segments.
    Saves results to MongoDB and pushes back to extension.
    """
    segments = _buffers.get(meeting_id, [])
    if not segments:
        return

    # Clear buffer before async call to prevent double-processing
    _buffers[meeting_id] = []

    groq = get_groq_client()
    intelligence = await groq.extract_intelligence(segments)

    if not intelligence:
        return

    db = get_db()

    # Build update dict
    update_ops = {}

    if intelligence.summary:
        update_ops["summary"] = intelligence.summary

    if intelligence.decisions:
        await db.meetings.update_one(
            {"id": meeting_id},
            {"$addToSet": {"decisions": {"$each": intelligence.decisions}}}
        )

    if intelligence.questions:
        await db.meetings.update_one(
            {"id": meeting_id},
            {"$addToSet": {"questions": {"$each": intelligence.questions}}}
        )

    if intelligence.actions:
        action_docs = [a.model_dump() for a in intelligence.actions]
        await db.meetings.update_one(
            {"id": meeting_id},
            {"$push": {"actions": {"$each": action_docs}}}
        )

    if update_ops:
        await db.meetings.update_one({"id": meeting_id}, {"$set": update_ops})

    # Broadcast intelligence update to all connections for this meeting
    payload = {
        "type": "INTELLIGENCE_UPDATE",
        "summary": intelligence.summary,
        "actions": [a.model_dump() for a in (intelligence.actions or [])],
        "decisions": intelligence.decisions or [],
        "questions": intelligence.questions or []
    }

    await manager.broadcast(meeting_id, payload)

    # Also send back through the originating WebSocket connection
    try:
        await ws.send_json(payload)
    except Exception:
        pass


async def handle_meeting_end(meeting_id: str):
    """
    Called when meeting ends:
    1. Flush remaining buffer through Groq
    2. Generate debt log topics
    3. Mark meeting as ended
    """
    db = get_db()

    # Final Groq pass on remaining buffer
    remaining = _buffers.pop(meeting_id, [])
    if remaining:
        groq = get_groq_client()
        intelligence = await groq.extract_intelligence(remaining)
        if intelligence and intelligence.actions:
            action_docs = [a.model_dump() for a in intelligence.actions]
            await db.meetings.update_one(
                {"id": meeting_id},
                {"$push": {"actions": {"$each": action_docs}}}
            )

    # Get full transcript for debt topic extraction
    doc = await db.meetings.find_one({"id": meeting_id})
    if doc:
        transcript_text = " ".join([
            s.get("text", "") for s in doc.get("transcript", [])
        ])

        groq = get_groq_client()
        debt_topics = await groq.extract_debt_topics(transcript_text)

        if debt_topics:
            # Update debt log
            from routes.debt_log import router as debt_log_router
            for topic in debt_topics:
                normalized = topic.lower().strip()
                existing = await db.debt_log.find_one({"topic_normalized": normalized})
                if existing:
                    await db.debt_log.update_one(
                        {"topic_normalized": normalized},
                        {
                            "$inc": {"count": 1},
                            "$set": {"last_seen": datetime.utcnow()},
                            "$addToSet": {"meeting_ids": meeting_id}
                        }
                    )
                else:
                    await db.debt_log.insert_one({
                        "topic": topic,
                        "topic_normalized": normalized,
                        "count": 1,
                        "first_seen": datetime.utcnow(),
                        "last_seen": datetime.utcnow(),
                        "meeting_ids": [meeting_id]
                    })

    # Mark ended
    await db.meetings.update_one(
        {"id": meeting_id},
        {"$set": {"ended_at": datetime.utcnow(), "is_active": False}}
    )

    print(f"[MeetPulse] Meeting {meeting_id} ended and processed.")


# ─── Health Check ─────────────────────────────────────────────
@app.get("/health")
async def health():
    db_ok = await ping_db()
    return {
        "status": "ok" if db_ok else "degraded",
        "db": "connected" if db_ok else "disconnected",
        "version": "1.0.0"
    }


@app.get("/")
async def root():
    return {
        "message": "MeetPulse API",
        "docs": "/docs",
        "health": "/health"
    }


# ─── Entry Point ─────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
