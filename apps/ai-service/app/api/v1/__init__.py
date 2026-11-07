"""Versioned internal API (CLAUDE.md §8.1): `POST /v1/process`."""

from fastapi import APIRouter

from app.api.v1.process import router as process_router

router = APIRouter()
router.include_router(process_router)
