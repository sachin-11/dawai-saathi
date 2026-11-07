"""Versioned internal API. `POST /v1/process` arrives in M5 (CLAUDE.md §8.1)."""

from fastapi import APIRouter

router = APIRouter(prefix="/v1")
