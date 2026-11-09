"""Cost-guard helpers (M15). The gateway owns the daily budget and sends its state with each request.

States: normal < economy (70%) < essential (90%) < exhausted (100%).

  economy    text-role calls use the CHEAP model; no spoken replies
  essential  only prescription extraction, the emergency classifier and templates still run: voice
             notes, lab reports and text questions get a "busy" template
  exhausted  templates and the emergency RULES only (the classifier is skipped, nothing is read)

The emergency rules, the emergency templates and the pure-CPU nodes never look at the state: an
emergency is answered in every state (CLAUDE.md §2.2).
"""

from typing import Any

from app.graph.state import GraphState
from app.observability.metrics import METRICS
from app.schemas.process import BudgetState, Intent

_RESTRICTED: frozenset[BudgetState] = frozenset({"essential", "exhausted"})


def budget_state_of(state: GraphState) -> BudgetState:
    return state.request.options.budget_state


def is_restricted(state: GraphState) -> bool:
    return budget_state_of(state) in _RESTRICTED


def busy_update(state: GraphState, key: str, reason: str) -> dict[str, Any]:
    """End the request with a busy template and count it. Lazy import: avoids a cycle with _util."""
    from app.graph.nodes._util import static_reply

    METRICS.budget_limited(budget_state_of(state), reason)
    return static_reply(key, Intent.other)
