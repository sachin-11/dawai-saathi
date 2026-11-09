"""Versioned internal API (CLAUDE.md §8.1): `POST /v1/process`."""

from fastapi import APIRouter

from app.api.v1.generic_details import router as generic_details_router
from app.api.v1.interactions import router as interactions_router
from app.api.v1.lab_render import router as lab_render_router
from app.api.v1.process import router as process_router
from app.api.v1.synthesize import router as synthesize_router

router = APIRouter()
router.include_router(process_router)
router.include_router(generic_details_router)
router.include_router(interactions_router)
router.include_router(lab_render_router)
router.include_router(synthesize_router)
