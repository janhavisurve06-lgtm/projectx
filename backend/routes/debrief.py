# ============================================================
# MeetPulse Routes — Debrief Generation
# ============================================================

from fastapi import APIRouter, HTTPException
from datetime import datetime

from db.mongo import get_db
from ai.groq_client import get_groq_client
from models import TranscriptSegment, ActionItem

router = APIRouter(prefix="/meetings", tags=["debrief"])


@router.post("/{meeting_id}/debrief")
async def generate_debrief(meeting_id: str):
    """
    Generate a comprehensive post-meeting debrief using Groq Llama3.
    Stores the result in MongoDB and returns it.
    """
    db = get_db()

    # Fetch meeting
    doc = await db.meetings.find_one({"id": meeting_id})
    if not doc:
        raise HTTPException(status_code=404, detail="Meeting not found")

    # Reconstruct models
    segments = [TranscriptSegment(**s) for s in doc.get("transcript", [])]
    actions = [ActionItem(**a) for a in doc.get("actions", [])]
    decisions = doc.get("decisions", [])
    questions = doc.get("questions", [])

    # Mark as ended if not already
    ended_at = doc.get("ended_at") or datetime.utcnow()
    started_at = doc.get("started_at")

    groq = get_groq_client()

    debrief_text = await groq.generate_debrief(
        segments=segments,
        platform=doc.get("platform", "unknown"),
        started_at=started_at,
        ended_at=ended_at,
        actions=actions,
        decisions=decisions,
        questions=questions
    )

    # Save debrief to MongoDB
    await db.meetings.update_one(
        {"id": meeting_id},
        {
            "$set": {
                "debrief": debrief_text,
                "ended_at": ended_at,
                "is_active": False
            }
        }
    )

    return {"debrief": debrief_text, "meeting_id": meeting_id}
