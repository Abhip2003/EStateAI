"""Local deterministic embeddings — a byte-for-byte port of the Fastify
``LocalHashEmbeddingProvider`` (apps/api/src/ai/embeddings/providers/
local-hash.provider.ts).

Keeping the algorithm identical means vectors written to
``KnowledgeDocument.embedding`` by the TypeScript indexer are directly
comparable to query vectors produced here, so Phase 31 RAG works against
the existing knowledge base with no re-indexing.

Algorithm:
  tokens   = lowercase(text).split(/[^a-z0-9]+/) filtered non-empty
  for each token:
      digest = sha256(token)                       # 32 bytes
      bucket = uint32_be(digest[0:4]) % DIMENSION
      sign   = +1 if digest[4] % 2 == 0 else -1
      vector[bucket] += sign
  return L2-normalize(vector)
"""

from __future__ import annotations

import hashlib
import math
import re

from langchain_core.embeddings import Embeddings

from app.config import get_settings

_TOKEN_SPLIT = re.compile(r"[^a-z0-9]+")


def local_hash_embed(text: str, dimension: int) -> list[float]:
    vector = [0.0] * dimension
    for token in _TOKEN_SPLIT.split(text.lower()):
        if not token:
            continue
        digest = hashlib.sha256(token.encode("utf-8")).digest()
        bucket = int.from_bytes(digest[0:4], byteorder="big") % dimension
        sign = 1.0 if digest[4] % 2 == 0 else -1.0
        vector[bucket] += sign
    magnitude = math.sqrt(sum(v * v for v in vector))
    if magnitude == 0.0:
        return vector
    return [v / magnitude for v in vector]


class LocalHashEmbeddings(Embeddings):
    """LangChain ``Embeddings`` adapter over :func:`local_hash_embed`."""

    def __init__(self, dimension: int | None = None) -> None:
        self.dimension = dimension or get_settings().embedding_dimension
        self.version = f"local-hash-v1-{self.dimension}"

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return [local_hash_embed(t, self.dimension) for t in texts]

    def embed_query(self, text: str) -> list[float]:
        return local_hash_embed(text, self.dimension)
