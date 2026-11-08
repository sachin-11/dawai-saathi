"""One object the pipeline talks to for catalog work (M8): match a medicine, find generics."""

import asyncio

import structlog
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.catalog.repository import CatalogRepository, PgCatalogRepository
from app.catalog.vector import (
    Embedder,
    HashingEmbedder,
    HttpEmbedder,
    InMemoryVectorStore,
    PineconeVectorStore,
    VectorStore,
)
from app.config import Settings
from app.safety.no_substitute import NoSubstitutePolicy, load_policy
from app.schemas.catalog import DrugMatch, GenericSuggestion
from app.tools.drug_matcher import MatcherConfig, match_drug
from app.tools.generic_finder import FinderConfig, MedicineFacts, find_generic

log = structlog.get_logger("catalog")


def build_embedder(settings: Settings) -> Embedder:
    if settings.embedding_base_url and settings.embedding_api_key and settings.embedding_model:
        return HttpEmbedder(
            settings.embedding_base_url,
            settings.embedding_api_key.get_secret_value(),
            settings.embedding_model,
        )
    return HashingEmbedder()


class CatalogService:
    def __init__(
        self,
        repo: CatalogRepository,
        *,
        matcher: MatcherConfig | None = None,
        finder: FinderConfig | None = None,
        policy: NoSubstitutePolicy | None = None,
        vector: VectorStore | None = None,
        embedder: Embedder | None = None,
        use_memory_vector: bool = True,
    ) -> None:
        self.repo = repo
        self.matcher = matcher or MatcherConfig()
        self.finder = finder or FinderConfig()
        self.policy = policy or load_policy()
        self._vector = vector
        self._embedder = embedder or HashingEmbedder()
        self._use_memory_vector = use_memory_vector
        self._lock = asyncio.Lock()

    @classmethod
    def from_settings(
        cls, settings: Settings, sessions: async_sessionmaker[AsyncSession]
    ) -> "CatalogService":
        embedder = build_embedder(settings)
        vector: VectorStore | None = None
        if (
            settings.vector_backend == "pinecone"
            and settings.pinecone_index_host
            and settings.pinecone_api_key
        ):
            vector = PineconeVectorStore(
                settings.pinecone_index_host, settings.pinecone_api_key.get_secret_value(), embedder
            )
        return cls(
            PgCatalogRepository(sessions),
            matcher=MatcherConfig(
                settings.drug_trgm_min, settings.drug_match_min, settings.drug_vector_min
            ),
            finder=FinderConfig(settings.drug_match_min, settings.min_savings_pct),
            vector=vector,
            embedder=embedder,
            use_memory_vector=settings.vector_backend == "memory",
        )

    async def _vector_store(self) -> VectorStore | None:
        if self._vector is not None or not self._use_memory_vector:
            return self._vector
        async with self._lock:
            if self._vector is None:
                self._vector = await InMemoryVectorStore.build(
                    self._embedder, await self.repo.all_rows()
                )
        return self._vector

    async def match(self, name: str, strength: str | None, form: str | None) -> DrugMatch:
        """Never raises: a catalog problem is logged and the medicine is simply unmatched."""
        try:
            return await match_drug(
                name,
                strength,
                form,
                repo=self.repo,
                vector=await self._vector_store(),
                config=self.matcher,
            )
        except (
            Exception
        ) as error:  # DB down, bad index ...: the reply still works without the catalog
            log.warning("catalog_match_failed", error_type=type(error).__name__)
            return DrugMatch(note="catalog_unavailable")

    async def generic(self, match: DrugMatch, facts: MedicineFacts) -> GenericSuggestion:
        try:
            return await find_generic(
                match, facts, repo=self.repo, policy=self.policy, config=self.finder
            )
        except Exception as error:
            log.warning("generic_finder_failed", error_type=type(error).__name__)
            return GenericSuggestion(reason_if_none="no_match")
