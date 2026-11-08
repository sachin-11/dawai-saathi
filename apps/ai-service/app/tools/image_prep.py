"""Image pre-processing before ANY model sees a picture (M7, CLAUDE.md §2.6, §12).

  * fix the EXIF orientation (phones store "rotate me" in metadata), convert to RGB
  * downscale the longest side to `VISION_MAX_PX` (cheaper, faster, and enough to read print)
  * re-encode as a fresh JPEG from raw pixels: EXIF, GPS, device and every other metadata block is
    gone because nothing but pixels is copied
  * cheap quality signals (blur, too dark, washed out) so a hopeless photo does not cost a vision call

Everything happens in memory. Nothing is written to disk (CLAUDE.md M7 §3).
"""

import io
from dataclasses import dataclass

from PIL import Image, ImageFilter, ImageOps, ImageStat, UnidentifiedImageError

from app.llm.types import ImageInput

# A decompression bomb (a tiny file that expands to gigapixels) must not exhaust memory.
MAX_SOURCE_PIXELS = 80_000_000
JPEG_QUALITY = 88
_ANALYSIS_PX = 900  # quality signals are computed on a small copy: fast and resolution independent

# Deliberately conservative: only a CLEARLY hopeless photo skips the model.
DARK_MEAN_MAX = 28.0
FLAT_STDDEV_MAX = 4.0  # almost no contrast: blank page, glare, or a black frame
DEFAULT_MIN_SHARPNESS = 12.0


class ImagePrepError(Exception):
    """The bytes are not a usable image. `code` is stable; the message never contains data."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True, slots=True)
class ImageQuality:
    sharpness: float  # variance of the Laplacian: higher = sharper
    brightness: float  # mean grey level 0..255
    contrast: float  # standard deviation of grey levels
    too_dark: bool
    washed_out: bool
    blurry: bool

    @property
    def unreadable(self) -> bool:
        """Clearly hopeless: ask the user to resend instead of paying for a vision call."""
        return self.too_dark or self.washed_out or self.blurry

    def hint(self) -> str:
        """Machine token for which tip to show; the texts live in the reply templates."""
        if self.too_dark:
            return "dark"
        if self.blurry:
            return "blur"
        return "contrast"


@dataclass(frozen=True, slots=True)
class PreparedImage:
    image: ImageInput  # JPEG, metadata-free, at most VISION_MAX_PX on the long side
    quality: ImageQuality
    width: int
    height: int


def _open(data: bytes) -> Image.Image:
    try:
        image = Image.open(io.BytesIO(data))
        if image.width * image.height > MAX_SOURCE_PIXELS:
            raise ImagePrepError("image_too_large", "the image has too many pixels")
        image.load()
    except ImagePrepError:
        raise
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
        raise ImagePrepError("not_an_image", "the file is not a readable image") from None
    return image


def _to_rgb(image: Image.Image) -> Image.Image:
    if image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info):
        rgba = image.convert("RGBA")
        background = Image.new("RGB", rgba.size, (255, 255, 255))  # transparency -> white paper
        background.paste(rgba, mask=rgba.getchannel("A"))
        return background
    return image.convert("RGB")


def measure_quality(
    image: Image.Image, min_sharpness: float = DEFAULT_MIN_SHARPNESS
) -> ImageQuality:
    grey = ImageOps.grayscale(image)
    grey.thumbnail((_ANALYSIS_PX, _ANALYSIS_PX), Image.Resampling.BILINEAR)
    stat = ImageStat.Stat(grey)
    brightness = float(stat.mean[0])
    contrast = float(stat.stddev[0])
    # Laplacian with a +128 offset so negative responses are not clipped away.
    laplacian = grey.filter(
        ImageFilter.Kernel((3, 3), [0, 1, 0, 1, -4, 1, 0, 1, 0], scale=1, offset=128)
    )
    # Pillow copies the 1-pixel border unfiltered; cut it off or it dominates the variance.
    inner = laplacian.crop((2, 2, max(3, laplacian.width - 2), max(3, laplacian.height - 2)))
    sharpness = float(ImageStat.Stat(inner).var[0])
    too_dark = brightness < DARK_MEAN_MAX
    washed_out = contrast < FLAT_STDDEV_MAX
    # A flat image has no edges either; report that as "washed out", not as "blurry".
    blurry = sharpness < min_sharpness and not washed_out and not too_dark
    return ImageQuality(
        sharpness=round(sharpness, 2),
        brightness=round(brightness, 2),
        contrast=round(contrast, 2),
        too_dark=too_dark,
        washed_out=washed_out,
        blurry=blurry,
    )


def prepare_pil(
    source: Image.Image, *, max_px: int, min_sharpness: float = DEFAULT_MIN_SHARPNESS
) -> PreparedImage:
    """Orientation fix, RGB, downscale, quality signals, and a metadata-free JPEG."""
    oriented = ImageOps.exif_transpose(source)
    rgb = _to_rgb(oriented)
    if max(rgb.size) > max_px:
        rgb.thumbnail((max_px, max_px), Image.Resampling.LANCZOS)  # keeps the aspect ratio
    quality = measure_quality(rgb, min_sharpness)

    # Copy raw pixels into a brand-new image: no `info`, no EXIF, no ICC profile can follow.
    clean = Image.new("RGB", rgb.size)
    clean.paste(rgb)
    buffer = io.BytesIO()
    clean.save(buffer, format="JPEG", quality=JPEG_QUALITY, optimize=True)
    return PreparedImage(
        image=ImageInput(data=buffer.getvalue(), mime="image/jpeg"),
        quality=quality,
        width=clean.width,
        height=clean.height,
    )


def prepare_image(
    data: bytes, *, max_px: int, min_sharpness: float = DEFAULT_MIN_SHARPNESS
) -> PreparedImage:
    """Prepare one image file (jpeg / png / webp)."""
    return prepare_pil(_open(data), max_px=max_px, min_sharpness=min_sharpness)
