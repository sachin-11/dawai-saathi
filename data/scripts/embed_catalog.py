"""Embed the catalog for the vector fallback (M8): `make embed`.

  VECTOR_BACKEND=pinecone  upsert every catalog row into the Pinecone index (needs PINECONE_API_KEY,
                           PINECONE_INDEX_HOST and, for real embeddings, EMBEDDING_BASE_URL /
                           EMBEDDING_API_KEY / EMBEDDING_MODEL; without them a deterministic offline
                           embedder is used, which is only good for tests)
  VECTOR_BACKEND=memory    nothing to do: the service builds its in-memory index from the catalog at
                           first use. This command then only counts and validates the rows.

NOTE: the Pinecone and HTTP-embedding code is tested against mocked HTTP only, never the real services.
"""

import asyncio
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "apps" / "ai-service"))

from app.catalog.repository import PgCatalogRepository  # noqa: E402
from app.catalog.service import build_embedder  # noqa: E402
from app.catalog.vector import PineconeVectorStore  # noqa: E402
from app.config import load_settings  # noqa: E402
from app.db.session import Database  # noqa: E402


async def main() -> int:
    settings = load_settings()
    database = Database(settings)
    try:
        rows = await PgCatalogRepository(database.session_factory).all_rows()
    finally:
        await database.dispose()
    if not rows:
        print("the catalog is empty: run `make seed` first", file=sys.stderr)
        return 1
    if settings.vector_backend != "pinecone":
        print(f"{len(rows)} catalog rows are ready; VECTOR_BACKEND=memory builds its index at first use.")
        return 0
    if not (settings.pinecone_index_host and settings.pinecone_api_key):
        print("PINECONE_INDEX_HOST and PINECONE_API_KEY are required for VECTOR_BACKEND=pinecone", file=sys.stderr)
        return 1
    store = PineconeVectorStore(
        settings.pinecone_index_host, settings.pinecone_api_key.get_secret_value(), build_embedder(settings)
    )
    sent = await store.upsert(rows)
    print(f"upserted {sent} vectors into the Pinecone index")
    return 0


if __name__ == "__main__":
    os.environ.setdefault("NODE_ENV", "development")
    sys.exit(asyncio.run(main()))
