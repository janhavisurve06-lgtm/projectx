# ============================================================
# MeetPulse Database — Motor Async MongoDB Client
# ============================================================

from motor.motor_asyncio import AsyncIOMotorClient
from pydantic_settings import BaseSettings
from functools import lru_cache
import os
from dotenv import load_dotenv

load_dotenv()


class Settings(BaseSettings):
    mongo_uri: str = os.getenv("MONGO_URI", "")
    mongo_db: str = os.getenv("MONGO_DB", "meetpulse")
    groq_api_key: str = os.getenv("GROQ_API_KEY", "")
    deepgram_api_key: str = os.getenv("DEEPGRAM_API_KEY", "")
    allowed_origins: str = os.getenv("ALLOWED_ORIGINS", "*")
    port: int = int(os.getenv("PORT", "8000"))

    class Config:
        env_file = ".env"
        extra = "allow"


@lru_cache()
def get_settings() -> Settings:
    return Settings()


# Global client (initialized on app startup)
_client: AsyncIOMotorClient = None


def get_client() -> AsyncIOMotorClient:
    global _client
    if _client is None:
        settings = get_settings()
        _client = AsyncIOMotorClient(settings.mongo_uri)
    return _client


def get_db():
    settings = get_settings()
    return get_client()[settings.mongo_db]


async def ping_db():
    """Verify MongoDB connection."""
    try:
        await get_client().admin.command("ping")
        return True
    except Exception as e:
        print(f"[MeetPulse DB] Connection failed: {e}")
        return False


async def close_db():
    global _client
    if _client:
        _client.close()
        _client = None
