"""`VectorStore` interface for the fuzzy-match fallback (M8; CLAUDE.md §3: Pinecone behind an interface).

Local, tests and the eval use `InMemoryVectorStore` with `HashingEmbedder` (deterministic, offline,
character-trigram based: it behaves like a second fuzzy matcher, not like a semantic model).

Production can use Pinecone (`PineconeVectorStore`) with a real embedding model (`HttpEmbedder`, any
OpenAI-compatible /embeddings endpoint). NOTE: those two classes are only tested against mocked HTTP,
never against the real services.
"""

import hashlib
import math
import re
from collections.abc import Iterable
from typing import Protocol

import httpx

from app.catalog.repository import DrugRow

DIMENSIONS = 256


class Embedder(Protocol):
    async def embed(self, texts: list[str]) -> list[list[float]]: ...


class VectorStore(Protocol):
    async def query(self, text: str, top_k: int) -> list[tuple[str, float]]:
        """`(drug_id, cosine similarity)`, best first."""
        ...


def doc_text(row: DrugRow) -> str:
    """What a catalog row is embedded as: brand + salt + strength + form."""
    return f"{row.brand_name} {row.salt_key} {row.strength_key} {row.form_key}"


def query_text(name: str, strength: str | None, form: str | None) -> str:
    return " ".join(part for part in (name, strength, form) if part)


class HashingEmbedder:
    """Character 3-grams hashed into a fixed-size, L2-normalised vector."""

    async def embed(self, texts: list[str]) -> list[list[float]]:
        return [self._one(text) for text in texts]

    @staticmethod
    def _one(text: str) -> list[float]:
        cleaned = "  " + re.sub(r"[^a-z0-9]+", " ", text.lower()).strip() + " "
        vector = [0.0] * DIMENSIONS
        for i in range(len(cleaned) - 2):
            digest = hashlib.blake2b(cleaned[i : i + 3].encode(), digest_size=4).digest()
            vector[int.from_bytes(digest, "big") % DIMENSIONS] += 1.0
        norm = math.sqrt(sum(v * v for v in vector)) or 1.0
        return [v / norm for v in vector]


def cosine(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b, strict=True))


class InMemoryVectorStore:
    def __init__(self, embedder: Embedder, ids: list[str], vectors: list[list[float]]) -> None:
        self._embedder = embedder
        self._ids = ids
        self._vectors = vectors

    @classmethod
    async def build(cls, embedder: Embedder, rows: Iterable[DrugRow]) -> "InMemoryVectorStore":
        rows = list(rows)
        vectors = await embedder.embed([doc_text(r) for r in rows]) if rows else []
        return cls(embedder, [r.id for r in rows], vectors)

    async def query(self, text: str, top_k: int) -> list[tuple[str, float]]:
        if not self._ids:
            return []
        (vector,) = await self._embedder.embed([text])
        scored = [(i, cosine(vector, v)) for i, v in zip(self._ids, self._vectors, strict=True)]
        scored.sort(key=lambda pair: -pair[1])
        return scored[:top_k]


class HttpEmbedder:
    """OpenAI-compatible `POST {base_url}/embeddings` (untested against the real API)."""

    def __init__(
        self, base_url: str, api_key: str, model: str, client: httpx.AsyncClient | None = None
    ) -> None:
        self._url = base_url.rstrip("/") + "/embeddings"
        self._headers = {"Authorization": f"Bearer {api_key}"}
        self._model = model
        self._client = client or httpx.AsyncClient(timeout=20.0)

    async def embed(self, texts: list[str]) -> list[list[float]]:
        response = await self._client.post(
            self._url, headers=self._headers, json={"model": self._model, "input": texts}
        )
        response.raise_for_status()
        data = sorted(response.json()["data"], key=lambda item: item["index"])
        return [item["embedding"] for item in data]


class PineconeVectorStore:
    """Pinecone data-plane REST (untested against the real service): query now, upsert via `make embed`."""

    def __init__(
        self,
        host: str,
        api_key: str,
        embedder: Embedder,
        namespace: str = "drugs",
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._base = host if host.startswith("http") else f"https://{host}"
        self._headers = {"Api-Key": api_key, "Content-Type": "application/json"}
        self._embedder = embedder
        self._namespace = namespace
        self._client = client or httpx.AsyncClient(timeout=15.0)

    async def query(self, text: str, top_k: int) -> list[tuple[str, float]]:
        (vector,) = await self._embedder.embed([text])
        response = await self._client.post(
            f"{self._base}/query",
            headers=self._headers,
            json={"vector": vector, "topK": top_k, "namespace": self._namespace},
        )
        response.raise_for_status()
        return [(m["id"], float(m["score"])) for m in response.json().get("matches", [])]

    async def upsert(self, rows: list[DrugRow], batch: int = 100) -> int:
        sent = 0
        for start in range(0, len(rows), batch):
            chunk = rows[start : start + batch]
            vectors = await self._embedder.embed([doc_text(r) for r in chunk])
            payload = {
                "namespace": self._namespace,
                "vectors": [
                    {
                        "id": r.id,
                        "values": v,
                        "metadata": {"brand": r.brand_name, "salt_key": r.salt_key},
                    }
                    for r, v in zip(chunk, vectors, strict=True)
                ],
            }
            response = await self._client.post(
                f"{self._base}/vectors/upsert", headers=self._headers, json=payload
            )
            response.raise_for_status()
            sent += len(chunk)
        return sent
