"""Structured output of the image classifier (prompt `image_classify_v1`)."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

ImageKind = Literal["prescription", "lab_report", "medicine_strip", "other"]


class ImageClassification(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: ImageKind
    quality: Literal["good", "poor", "unreadable"] = "good"
    confidence: float = Field(ge=0.0, le=1.0)
