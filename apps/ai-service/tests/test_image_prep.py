"""Image pre-processing and PDF rendering (M7): orientation, metadata, size, quality, limits."""

import io

import pypdfium2 as pdfium
import pytest
from PIL import Image, ImageFilter
from pypdfium2 import PdfiumError

from app.llm.fake import FakeProvider
from app.pipeline.graph import GraphPipeline
from app.schemas.process import Intent
from app.tools import image_prep
from app.tools.image_prep import ImagePrepError, prepare_image
from app.tools.pdf_render import MAX_PDF_PAGES, PdfRejectedError, render_pdf_pages
from tests.rx_support import fake_fetch, image_request, make_ctx, sample_jpeg


def jpeg_of(image: Image.Image, **save: object) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", **save)  # type: ignore[arg-type]
    return buffer.getvalue()


class TestPrepareImage:
    def test_exif_orientation_is_applied(self):
        exif = Image.Exif()
        exif[0x0112] = 6  # "rotate 90 degrees clockwise to display"
        wide = Image.new("RGB", (400, 200), (240, 240, 240))
        prepared = prepare_image(jpeg_of(wide, exif=exif), max_px=2000)
        assert (prepared.width, prepared.height) == (200, 400)

    def test_all_metadata_including_gps_is_stripped(self):
        exif = Image.Exif()
        exif[0x010F] = "SecretPhoneMaker"  # Make
        exif[0x0110] = "SecretModel-9000"  # Model
        gps = exif.get_ifd(0x8825)
        gps[1], gps[2] = "N", (28.0, 36.0, 50.0)  # GPSLatitudeRef, GPSLatitude
        data = sample_jpeg(exif=exif.tobytes())
        assert b"SecretPhoneMaker" in data  # the source really carries metadata

        prepared = prepare_image(data, max_px=2000)
        out = Image.open(io.BytesIO(prepared.image.data))
        assert dict(out.getexif()) == {}
        assert out.getexif().get_ifd(0x8825) == {}
        assert b"SecretPhoneMaker" not in prepared.image.data
        assert b"SecretModel" not in prepared.image.data
        assert b"Exif" not in prepared.image.data
        assert out.info.get("icc_profile") is None

    def test_large_images_are_downscaled_keeping_the_aspect_ratio(self):
        big = Image.new("RGB", (4000, 3000), (240, 240, 240))
        prepared = prepare_image(jpeg_of(big), max_px=2000)
        assert (prepared.width, prepared.height) == (2000, 1500)

    def test_small_images_are_not_upscaled(self):
        prepared = prepare_image(sample_jpeg(size=(600, 800)), max_px=2000)
        assert (prepared.width, prepared.height) == (600, 800)

    def test_output_is_a_jpeg_and_png_with_transparency_is_flattened_on_white(self):
        png = io.BytesIO()
        Image.new("RGBA", (300, 300), (0, 0, 0, 0)).save(png, format="PNG")
        prepared = prepare_image(png.getvalue(), max_px=2000)
        assert prepared.image.mime == "image/jpeg"
        assert prepared.image.data[:3] == b"\xff\xd8\xff"
        pixel = Image.open(io.BytesIO(prepared.image.data)).getpixel((10, 10))
        assert min(pixel) > 240

    def test_not_an_image_is_rejected_with_a_stable_code(self):
        with pytest.raises(ImagePrepError) as info:
            prepare_image(b"this is not an image", max_px=2000)
        assert info.value.code == "not_an_image"

    def test_a_decompression_bomb_is_refused(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setattr(image_prep, "MAX_SOURCE_PIXELS", 1000)
        with pytest.raises(ImagePrepError) as info:
            prepare_image(sample_jpeg(size=(400, 400)), max_px=2000)
        assert info.value.code == "image_too_large"


class TestQuality:
    def test_a_sharp_page_of_text_is_fine(self):
        quality = prepare_image(sample_jpeg(), max_px=2000).quality
        assert not quality.unreadable, quality

    def test_a_heavily_blurred_page_is_blurry(self):
        blurred = Image.open(io.BytesIO(sample_jpeg())).filter(ImageFilter.GaussianBlur(14))
        quality = prepare_image(jpeg_of(blurred), max_px=2000).quality
        assert quality.blurry and quality.unreadable and quality.hint() == "blur"

    def test_a_black_photo_is_too_dark(self):
        quality = prepare_image(
            jpeg_of(Image.new("RGB", (800, 800), (8, 8, 8))), max_px=2000
        ).quality
        assert quality.too_dark and quality.hint() == "dark"

    def test_a_blank_white_page_is_washed_out_not_blurry(self):
        quality = prepare_image(
            jpeg_of(Image.new("RGB", (800, 800), (255, 255, 255))), max_px=2000
        ).quality
        assert quality.washed_out and not quality.blurry and quality.hint() == "contrast"


class TestPipelineSkipsTheModelForHopelessPhotos:
    @pytest.mark.parametrize(
        ("image", "expected"),
        [
            (jpeg_of(Image.new("RGB", (800, 800), (8, 8, 8))), "too dark"),
            (
                jpeg_of(Image.open(io.BytesIO(sample_jpeg())).filter(ImageFilter.GaussianBlur(14))),
                "too blurry",
            ),
        ],
    )
    async def test_no_llm_call_and_a_tip_is_returned(self, monkeypatch, image, expected):
        monkeypatch.setattr("app.tools.image_input.fetch_media", fake_fetch(image, "image/jpeg"))
        provider = FakeProvider()
        output = await GraphPipeline().run(image_request("en"), make_ctx(provider))
        assert provider.calls == []
        assert expected in output.reply.text and output.intent is Intent.other
        assert output.extraction is None and output.reply.buttons == []


def blank_pdf(pages: int) -> bytes:
    pdf = pdfium.PdfDocument.new()
    for _ in range(pages):
        pdf.new_page(595, 842)
    buffer = io.BytesIO()
    pdf.save(buffer)
    return buffer.getvalue()


class TestPdf:
    def test_only_the_first_three_pages_are_rendered(self):
        images = render_pdf_pages(blank_pdf(5), max_px=1000)
        assert len(images) == 3
        assert max(images[0].size) == pytest.approx(1000, abs=2)

    def test_too_many_pages_are_rejected(self):
        with pytest.raises(PdfRejectedError) as info:
            render_pdf_pages(blank_pdf(MAX_PDF_PAGES + 1), max_px=1000)
        assert info.value.code == "too_many_pages"

    def test_garbage_is_a_bad_pdf(self):
        with pytest.raises(PdfRejectedError) as info:
            render_pdf_pages(b"%PDF-not really", max_px=1000)
        assert info.value.code == "bad_pdf"

    def test_a_password_protected_pdf_is_rejected(self, monkeypatch: pytest.MonkeyPatch):
        def locked(*_args: object, **_kwargs: object) -> None:
            raise PdfiumError("Failed to load document (PDFium: Incorrect password error).")

        monkeypatch.setattr(pdfium, "PdfDocument", locked)
        with pytest.raises(PdfRejectedError) as info:
            render_pdf_pages(b"%PDF-1.7", max_px=1000)
        assert info.value.code == "encrypted_pdf"

    async def test_the_pipeline_answers_politely_for_an_encrypted_or_long_pdf(self, monkeypatch):
        provider = FakeProvider()
        request = image_request("en")
        pdf_input = request.input.model_copy(update={"mime": "application/pdf"})
        request = request.model_copy(update={"input": pdf_input})

        monkeypatch.setattr(
            "app.tools.image_input.fetch_media",
            fake_fetch(blank_pdf(MAX_PDF_PAGES + 1), "application/pdf"),
        )
        long_output = await GraphPipeline().run(request, make_ctx(provider))
        assert "too many pages" in long_output.reply.text

        monkeypatch.setattr(
            "app.tools.image_input.fetch_media", fake_fetch(b"%PDF-garbage", "application/pdf")
        )
        bad_output = await GraphPipeline().run(request, make_ctx(provider))
        assert "could not open this file" in bad_output.reply.text
        assert provider.calls == []
