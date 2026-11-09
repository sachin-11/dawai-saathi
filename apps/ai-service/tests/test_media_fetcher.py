"""SSRF guard and size limits of the presigned-URL fetcher (plain httpx, mocked with respx)."""

import httpx
import pytest
import respx

from app.llm.types import ImageInput
from app.media.fetcher import (
    FetchedMedia,
    MediaRejectedError,
    fetch_media,
    normalise_mime,
    validate_media_url,
)
from tests.conftest import make_settings

GOOD_URL = "http://localhost:9000/dawai-media/media/u/2026/11/m.jpg?X-Amz-Signature=abc"
SETTINGS = make_settings(ALLOWED_MEDIA_HOSTS="localhost:9000, media.example.com", MAX_MEDIA_MB=1)


class TestValidateUrl:
    @pytest.mark.parametrize(
        "url",
        [
            "http://localhost:9000/b/k?sig=1",
            "https://media.example.com/b/k?sig=1",
            "https://MEDIA.example.com/b/k",  # host comparison is case-insensitive
        ],
    )
    def test_allowed_urls_pass(self, url):
        validate_media_url(url, SETTINGS)

    @pytest.mark.parametrize(
        ("url", "code"),
        [
            ("http://evil.example.org/x", "host_not_allowed"),
            ("http://localhost:9999/x", "host_not_allowed"),  # right host, wrong port
            ("http://169.254.169.254/latest/meta-data/", "host_not_allowed"),  # cloud metadata
            ("http://127.0.0.1:9000/x", "host_not_allowed"),  # not on the allowlist
            ("https://media.example.com.evil.com/x", "host_not_allowed"),  # suffix trick
            ("https://evil.com/media.example.com", "host_not_allowed"),  # host in the path
            ("ftp://localhost:9000/x", "bad_scheme"),
            ("file:///etc/passwd", "bad_scheme"),
            ("gopher://localhost:9000/x", "bad_scheme"),
            ("https://user:pass@media.example.com/x", "bad_url"),  # credentials
            (
                "https://media.example.com@evil.com/x",
                "bad_url",
            ),  # userinfo trick: rejected as credentials
            ("not a url", "bad_scheme"),
            ("https:///nohost", "bad_url"),
            ("", "bad_scheme"),
        ],
    )
    def test_dangerous_urls_are_rejected(self, url, code):
        with pytest.raises(MediaRejectedError) as info:
            validate_media_url(url, SETTINGS)
        assert info.value.code == code
        assert url not in str(info.value) or url == ""  # the URL is never echoed

    def test_plain_http_is_refused_in_production(self):
        prod = make_settings(
            ALLOWED_MEDIA_HOSTS="media.example.com",
            NODE_ENV="production",
            LLM_MODE="real",
            SERVICE_TOKEN="a-real-production-token",
            METRICS_TOKEN="metrics-token-123456",
        )
        with pytest.raises(MediaRejectedError) as info:
            validate_media_url("http://media.example.com/x", prod)
        assert info.value.code == "bad_scheme"
        validate_media_url("https://media.example.com/x", prod)


class TestFetch:
    @respx.mock
    async def test_downloads_an_allowed_file(self):
        respx.get(GOOD_URL).mock(
            return_value=httpx.Response(
                200, content=b"jpeg-bytes", headers={"content-length": "10"}
            )
        )
        media = await fetch_media(GOOD_URL, "image/jpeg", SETTINGS)
        assert media == FetchedMedia(data=b"jpeg-bytes", mime="image/jpeg")
        assert isinstance(media.as_image(), ImageInput)

    @respx.mock
    async def test_a_mime_type_with_parameters_is_normalised(self):
        respx.get(GOOD_URL).mock(return_value=httpx.Response(200, content=b"opus"))
        media = await fetch_media(GOOD_URL, "audio/ogg; codecs=opus", SETTINGS)
        assert media.mime == "audio/ogg"
        assert normalise_mime("IMAGE/PNG ") == "image/png"

    @pytest.mark.parametrize(
        "mime", ["image/svg+xml", "text/html", "application/zip", "video/mp4", ""]
    )
    @respx.mock
    async def test_a_disallowed_mime_type_is_rejected_before_any_request(self, mime):
        route = respx.get(GOOD_URL).mock(return_value=httpx.Response(200, content=b"x"))
        with pytest.raises(MediaRejectedError) as info:
            await fetch_media(GOOD_URL, mime, SETTINGS)
        assert info.value.code == "mime_not_allowed"
        assert not route.called

    @respx.mock
    async def test_a_disallowed_host_is_rejected_before_any_request(self):
        route = respx.get("http://evil.example.org/x").mock(
            return_value=httpx.Response(200, content=b"x")
        )
        with pytest.raises(MediaRejectedError) as info:
            await fetch_media("http://evil.example.org/x", "image/jpeg", SETTINGS)
        assert info.value.code == "host_not_allowed"
        assert not route.called

    @respx.mock
    async def test_redirects_are_not_followed(self):
        respx.get(GOOD_URL).mock(
            return_value=httpx.Response(302, headers={"location": "http://169.254.169.254/secret"})
        )
        secret = respx.get("http://169.254.169.254/secret").mock(
            return_value=httpx.Response(200, content=b"x")
        )
        with pytest.raises(MediaRejectedError) as info:
            await fetch_media(GOOD_URL, "image/jpeg", SETTINGS)
        assert info.value.code == "redirect"
        assert not secret.called

    @respx.mock
    async def test_an_announced_size_over_the_limit_is_rejected_without_downloading(self):
        respx.get(GOOD_URL).mock(
            return_value=httpx.Response(
                200, content=b"x", headers={"content-length": str(5 * 1024 * 1024)}
            )
        )
        with pytest.raises(MediaRejectedError) as info:
            await fetch_media(GOOD_URL, "image/jpeg", SETTINGS)
        assert info.value.code == "too_large"

    @respx.mock
    async def test_the_limit_is_enforced_while_streaming_even_if_the_header_lies(self):
        big = b"x" * (2 * 1024 * 1024)  # limit is 1 MB
        respx.get(GOOD_URL).mock(
            return_value=httpx.Response(200, content=big, headers={"content-length": "10"})
        )
        with pytest.raises(MediaRejectedError) as info:
            await fetch_media(GOOD_URL, "image/jpeg", SETTINGS)
        assert info.value.code == "too_large"

    @respx.mock
    async def test_a_file_of_exactly_the_limit_is_accepted(self):
        exact = b"x" * (1024 * 1024)
        respx.get(GOOD_URL).mock(return_value=httpx.Response(200, content=exact))
        assert len((await fetch_media(GOOD_URL, "image/png", SETTINGS)).data) == len(exact)

    @pytest.mark.parametrize("status", [403, 404, 500])
    @respx.mock
    async def test_error_statuses_are_rejected_without_the_body(self, status):
        respx.get(GOOD_URL).mock(return_value=httpx.Response(status, content=b"secret error body"))
        with pytest.raises(MediaRejectedError) as info:
            await fetch_media(GOOD_URL, "image/jpeg", SETTINGS)
        assert info.value.code == "fetch_failed"
        assert "secret" not in str(info.value)

    @respx.mock
    async def test_network_errors_become_a_clean_rejection(self):
        respx.get(GOOD_URL).mock(side_effect=httpx.ConnectError("boom with url " + GOOD_URL))
        with pytest.raises(MediaRejectedError) as info:
            await fetch_media(GOOD_URL, "image/jpeg", SETTINGS)
        assert info.value.code == "fetch_failed"
        assert GOOD_URL not in str(info.value)

    def test_only_images_can_be_turned_into_image_input(self):
        with pytest.raises(MediaRejectedError) as info:
            FetchedMedia(data=b"%PDF", mime="application/pdf").as_image()
        assert info.value.code == "not_an_image"
