"""Graph-level failures that are not an `LLMError` (those keep their own HTTP mapping)."""


class NodeTimeoutError(Exception):
    """A node exceeded its time limit and has no fallback: the request fails (504)."""

    def __init__(self, node: str) -> None:
        super().__init__(f"node {node} timed out")
        self.node = node
