# ============================================================
# MeetPulse Routes — Cross-Meeting Debt Log
# ============================================================

from fastapi import APIRouter
from datetime import datetime

from db.mongo import get_db
from models import DebtTopic, DebtLogResponse

router = APIRouter(prefix="/debt-log", tags=["debt-log"])


@router.get("", response_model=DebtLogResponse)
async def get_debt_log(limit: int = 20):
    """
    Return all recurring topics across meetings, sorted by occurrence count.
    These are topics discussed in multiple meetings without resolution.
    """
    db = get_db()
    cursor = db.debt_log.find({}).sort("count", -1).limit(limit)
    topics = []
    async for doc in cursor:
        topics.append(DebtTopic(
            topic=doc["topic"],
            count=doc["count"],
            last_seen=doc.get("last_seen", datetime.utcnow()),
            meeting_ids=doc.get("meeting_ids", [])
        ))
    return DebtLogResponse(topics=topics)


@router.post("/update/{meeting_id}")
async def update_debt_log(meeting_id: str, topics: list[str]):
    """
    Called after a meeting ends. For each extracted topic:
    - Increment its count if it already exists
    - Create a new entry if it's new
    """
    db = get_db()
    now = datetime.utcnow()
    updated = 0

    for topic in topics:
        # Normalize: lowercase, strip whitespace
        normalized = topic.lower().strip()
        if not normalized:
            continue

        existing = await db.debt_log.find_one({"topic_normalized": normalized})

        if existing:
            await db.debt_log.update_one(
                {"topic_normalized": normalized},
                {
                    "$inc": {"count": 1},
                    "$set": {"last_seen": now},
                    "$addToSet": {"meeting_ids": meeting_id}
                }
            )
        else:
            await db.debt_log.insert_one({
                "topic": topic,
                "topic_normalized": normalized,
                "count": 1,
                "first_seen": now,
                "last_seen": now,
                "meeting_ids": [meeting_id]
            })

        updated += 1

    return {"updated": updated, "topics": topics}


@router.delete("/{topic}")
async def remove_debt_topic(topic: str):
    """Remove a topic from the debt log (marked as resolved)."""
    db = get_db()
    normalized = topic.lower().strip()
    result = await db.debt_log.delete_one({"topic_normalized": normalized})
    return {"deleted": result.deleted_count > 0}
