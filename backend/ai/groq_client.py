# ============================================================
# MeetPulse AI — Groq Client (Llama 3.1 70B)
# ============================================================

import json
import os
from typing import Optional
from groq import AsyncGroq
from dotenv import load_dotenv

from ai.prompts import (
    LIVE_INTELLIGENCE_PROMPT,
    DEBRIEF_PROMPT,
    DEBT_TOPIC_EXTRACTION_PROMPT
)
from models import ActionItem, IntelligenceUpdate, TranscriptSegment

load_dotenv()

# Use the fast Llama3 8B for real-time inference, 70B for debrief
FAST_MODEL = "llama3-8b-8192"
SMART_MODEL = "llama-3.1-70b-versatile"


class GroqClient:
    def __init__(self):
        api_key = os.getenv("GROQ_API_KEY")
        if not api_key:
            raise ValueError("GROQ_API_KEY not set in environment")
        self.client = AsyncGroq(api_key=api_key)

    async def extract_intelligence(
        self,
        segments: list[TranscriptSegment],
        model: str = FAST_MODEL
    ) -> Optional[IntelligenceUpdate]:
        """
        Extract real-time intelligence (summary, actions, decisions, questions)
        from a batch of transcript segments.
        """
        if not segments:
            return None

        # Format transcript for prompt
        transcript_text = "\n".join([
            f"[{s.speaker}]: {s.text}"
            for s in segments
        ])

        try:
            completion = await self.client.chat.completions.create(
                model=model,
                messages=[
                    {
                        "role": "system",
                        "content": "You are a precise meeting intelligence AI. Always respond with valid JSON only."
                    },
                    {
                        "role": "user",
                        "content": LIVE_INTELLIGENCE_PROMPT + transcript_text
                    }
                ],
                temperature=0.2,
                max_tokens=1024
            )

            raw = completion.choices[0].message.content.strip()

            # Clean JSON response (strip code fences if any)
            if raw.startswith("```"):
                raw = raw.split("```")[1]
                if raw.startswith("json"):
                    raw = raw[4:]
            raw = raw.strip()

            data = json.loads(raw)

            actions = [
                ActionItem(
                    text=a.get("text", ""),
                    assignee=a.get("assignee"),
                    priority=a.get("priority", "medium")
                )
                for a in data.get("actions", [])
                if a.get("text")
            ]

            return IntelligenceUpdate(
                summary=data.get("summary"),
                actions=actions,
                decisions=data.get("decisions", []),
                questions=data.get("questions", [])
            )

        except json.JSONDecodeError as e:
            print(f"[Groq] JSON parse error: {e}\nRaw: {raw[:300]}")
            return None
        except Exception as e:
            print(f"[Groq] Intelligence extraction failed: {e}")
            return None

    async def generate_debrief(
        self,
        segments: list[TranscriptSegment],
        platform: str,
        started_at,
        ended_at,
        actions: list[ActionItem],
        decisions: list[str],
        questions: list[str],
        model: str = SMART_MODEL
    ) -> str:
        """
        Generate a comprehensive post-meeting debrief document.
        """
        transcript_text = "\n".join([
            f"[{s.speaker}]: {s.text}"
            for s in segments[-200:]  # last 200 segments max
        ])

        duration_str = "Unknown"
        if started_at and ended_at:
            delta = ended_at - started_at
            mins = int(delta.total_seconds() / 60)
            secs = int(delta.total_seconds() % 60)
            duration_str = f"{mins}m {secs}s"

        actions_text = "\n".join([
            f"- [{a.assignee or 'Unassigned'}] {a.text} ({a.priority} priority)"
            for a in actions
        ]) or "No action items recorded"

        decisions_text = "\n".join([f"- {d}" for d in decisions]) or "No decisions recorded"
        questions_text = "\n".join([f"- {q}" for q in questions]) or "No open questions"

        system_template = DEBRIEF_PROMPT.format(
            platform=platform,
            date=str(started_at)[:10] if started_at else "Unknown",
            duration=duration_str
        )

        user_content = f"""
Meeting Platform: {platform}
Duration: {duration_str}

DECISIONS:
{decisions_text}

OPEN QUESTIONS:
{questions_text}

ACTION ITEMS:
{actions_text}

TRANSCRIPT:
{transcript_text}
"""

        try:
            completion = await self.client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": system_template},
                    {"role": "user", "content": user_content}
                ],
                temperature=0.3,
                max_tokens=2048
            )
            return completion.choices[0].message.content.strip()
        except Exception as e:
            print(f"[Groq] Debrief generation failed: {e}")
            return f"Debrief generation failed: {str(e)}"

    async def extract_debt_topics(
        self,
        transcript_text: str,
        model: str = FAST_MODEL
    ) -> list[str]:
        """
        Identify recurring/unresolved topics that indicate meeting debt.
        """
        try:
            completion = await self.client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": "You return only valid JSON arrays."},
                    {"role": "user", "content": DEBT_TOPIC_EXTRACTION_PROMPT + transcript_text[:3000]}
                ],
                temperature=0.1,
                max_tokens=256
            )
            raw = completion.choices[0].message.content.strip()
            if raw.startswith("```"):
                raw = raw.split("```")[1].strip()
                if raw.startswith("json"):
                    raw = raw[4:].strip()
            return json.loads(raw)
        except Exception as e:
            print(f"[Groq] Debt topic extraction failed: {e}")
            return []


# Singleton instance
_groq_client: GroqClient = None


def get_groq_client() -> GroqClient:
    global _groq_client
    if _groq_client is None:
        _groq_client = GroqClient()
    return _groq_client
