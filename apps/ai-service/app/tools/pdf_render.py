"""Render the first pages of a prescription PDF to images (M7), fully in memory.

Limits: encrypted PDFs are rejected (we never ask for or try a password), PDFs with more than
`MAX_PDF_PAGES` pages are rejected (a prescription is one to three pages; a 200-page file is
something else), and only the first `RENDER_PAGES` pages are rendered.
"""

import pypdfium2 as pdfium
from PIL import Image
from pypdfium2 import PdfiumError

RENDER_PAGES = 3
MAX_PDF_PAGES = 10
_MIN_SCALE = 0.5
_MAX_SCALE = 4.0


class PdfRejectedError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def render_pdf_pages(data: bytes, *, max_px: int, pages: int = RENDER_PAGES) -> list[Image.Image]:
    """The first pages as RGB images, longest side about `max_px`. Raises PdfRejectedError."""
    try:
        pdf = pdfium.PdfDocument(data)
    except PdfiumError as error:
        if "password" in str(error).lower():
            raise PdfRejectedError("encrypted_pdf", "the PDF is password protected") from None
        raise PdfRejectedError("bad_pdf", "the PDF cannot be read") from None
    except (ValueError, TypeError):
        raise PdfRejectedError("bad_pdf", "the PDF cannot be read") from None

    try:
        page_count = len(pdf)
        if page_count == 0:
            raise PdfRejectedError("bad_pdf", "the PDF has no pages")
        if page_count > MAX_PDF_PAGES:
            raise PdfRejectedError("too_many_pages", "the PDF has too many pages")
        images: list[Image.Image] = []
        for index in range(min(page_count, pages)):
            page = pdf[index]
            try:
                width, height = page.get_size()
                scale = max(_MIN_SCALE, min(_MAX_SCALE, max_px / max(width, height, 1.0)))
                images.append(page.render(scale=scale).to_pil().convert("RGB"))
            finally:
                page.close()
        return images
    except PdfiumError:
        raise PdfRejectedError("bad_pdf", "the PDF cannot be rendered") from None
    finally:
        pdf.close()
