# ============================================================
# MeetPulse Models — Pydantic schemas
# ============================================================

from pydantic import BaseModel, Field
from typing import Optional, List
from datetime import datetime
import uuid


def new_id() -> str:
    return str(uuid.uuid4())


class TranscriptSegment(BaseModel):
    text: str
    speaker: str = "Speaker 1"
    is_final: bool = True
    confidence: float = 1.0
    timestamp: int = Field(default_factory=lambda: int(datetime.utcnow().timestamp() * 1000))
    meeting_id: Optional[str] = None


class ActionItem(BaseModel):
    id: str = Field(default_factory=new_id)
    text: str
    assignee: Optional[str] = None
    priority: str = "medium"   # low | medium | high
    done: bool = False
    created_at: datetime = Field(default_factory=datetime.utcnow)
    meeting_id: Optional[str] = None


class Screenshot(BaseModel):
    id: str = Field(default_factory=new_id)
    image: str          # base64 data URL
    timestamp: int
    meeting_id: Optional[str] = None


class CreateMeetingRequest(BaseModel):
    platform: str = "google_meet"
    meeting_code: str = "unknown"
    title: Optional[str] = None


class Meeting(BaseModel):
    id: str = Field(default_factory=new_id)
    platform: str
    meeting_code: str
    title: Optional[str] = None
    started_at: datetime = Field(default_factory=datetime.utcnow)
    ended_at: Optional[datetime] = None
    transcript: List[TranscriptSegment] = []
    actions: List[ActionItem] = []
    screenshots: List[str] = []   # screenshot IDs
    summary: Optional[str] = None
    decisions: List[str] = []
    questions: List[str] = []
    debrief: Optional[str] = None
    is_active: bool = True


class TranscriptBatch(BaseModel):
    meeting_id: str
    segments: List[TranscriptSegment]


class IntelligenceUpdate(BaseModel):
    summary: Optional[str] = None
    actions: Optional[List[ActionItem]] = []
    decisions: Optional[List[str]] = []
    questions: Optional[List[str]] = []


class DebtTopic(BaseModel):
    topic: str
    count: int
    last_seen: datetime
    meeting_ids: List[str] = []


class DebtLogResponse(BaseModel):
    topics: List[DebtTopic]
