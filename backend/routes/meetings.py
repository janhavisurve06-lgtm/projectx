# ============================================================
# MeetPulse Routes — Meetings CRUD
# ============================================================

from fastapi import APIRouter, HTTPException, status
from bson import ObjectId
from datetime import datetime

from db.mongo import get_db
from models import CreateMeetingRequest, Meeting, TranscriptSegment, Screenshot

router = APIRouter(prefix="/meetings", tags=["meetings"])


def _serialize(doc: dict) -> dict:
    """Convert MongoDB document to JSON-serializable dict."""
    if doc is None:
        return None
    doc = dict(doc)
    if "_id" in doc:
        doc["_id"] = str(doc["_id"])
    return doc


@router.post("", response_model=dict, status_code=status.HTTP_201_CREATED)
async def create_meeting(req: CreateMeetingRequest):
    """Register a new meeting when detected by the extension."""
    db = get_db()
    meeting = Meeting(
        platform=req.platform,
        meeting_code=req.meeting_code,
        title=req.title or f"Meeting on {req.platform}",
    )
    doc = meeting.model_dump()
    result = await db.meetings.insert_one(doc)
    doc["_id"] = str(result.inserted_id)
    return doc


@router.get("", response_model=list)
async def list_meetings(limit: int = 20, skip: int = 0):
    """List all meetings, most recent first."""
    db = get_db()
    cursor = db.meetings.find({}, {"transcript": 0}).sort("started_at", -1).skip(skip).limit(limit)
    meetings = []
    async for doc in cursor:
        meetings.append(_serialize(doc))
    return meetings


@router.get("/{meeting_id}", response_model=dict)
async def get_meeting(meeting_id: str):
    """Get a single meeting by ID."""
    db = get_db()
    doc = await db.meetings.find_one({"id": meeting_id})
    if not doc:
        raise HTTPException(status_code=404, detail="Meeting not found")
    return _serialize(doc)


@router.patch("/{meeting_id}/end")
async def end_meeting(meeting_id: str):
    """Mark a meeting as ended."""
    db = get_db()
    result = await db.meetings.update_one(
        {"id": meeting_id},
        {"$set": {"ended_at": datetime.utcnow(), "is_active": False}}
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Meeting not found")
    return {"status": "ended"}


@router.post("/{meeting_id}/transcript")
async def append_transcript(meeting_id: str, segments: list[TranscriptSegment]):
    """Append transcript segments to a meeting."""
    db = get_db()
    segs = [s.model_dump() for s in segments]
    result = await db.meetings.update_one(
        {"id": meeting_id},
        {"$push": {"transcript": {"$each": segs}}}
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Meeting not found")
    return {"appended": len(segs)}


@router.post("/{meeting_id}/screenshots")
async def add_screenshot(meeting_id: str, screenshot: Screenshot):
    """Add a screenshot capture to a meeting."""
    db = get_db()
    scr = screenshot.model_dump()
    scr["meeting_id"] = meeting_id

    # Store screenshot separately (images are large)
    result = await db.screenshots.insert_one(scr)
    scr_id = str(result.inserted_id)

    # Reference in meeting
    await db.meetings.update_one(
        {"id": meeting_id},
        {"$push": {"screenshots": scr_id}}
    )
    return {"id": scr_id}


@router.get("/{meeting_id}/screenshots")
async def get_screenshots(meeting_id: str):
    """Get all screenshots for a meeting."""
    db = get_db()
    cursor = db.screenshots.find({"meeting_id": meeting_id})
    screenshots = []
    async for doc in cursor:
        screenshots.append(_serialize(doc))
    return screenshots
