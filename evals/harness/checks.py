"""PR checks (CLAUDE.md §8.3, M14 §3): prompt versions and eval evidence.

Both compare the working tree with the merge base of a base ref (default `origin/main`, then `main`).
With no base ref at all (first push of a new repo) they print a warning and pass: nothing to compare.
"""

import fnmatch
import json
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

import yaml

from evals.harness import ROOT

PROMPTS = "apps/ai-service/app/prompts/files"
TEMPLATES = "apps/ai-service/app/prompts/templates"
REPORTS = "evals/reports"
WAIVER = re.compile(r"eval-waiver", re.IGNORECASE)


def _git(*args: str) -> str:
    done = subprocess.run(  # noqa: S603 - fixed argv, no shell
        ["git", *args],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    return done.stdout


def merge_base(base: str) -> str | None:
    for ref in (base, "main", "master"):
        out = _git("merge-base", ref, "HEAD").strip()
        if out:
            return out
    print(f"warning: no base ref ({base}) found, nothing to compare against", file=sys.stderr)
    return None


def changed(base_sha: str, path: str = "") -> dict[str, str]:
    """{path: status letter} for the working tree vs the merge base (staged, unstaged, committed)."""
    args = ["diff", "--name-status", "--no-renames", base_sha]
    if path:
        args += ["--", path]
    out: dict[str, str] = {}
    for line in _git(*args).splitlines():
        status, _, name = line.partition("\t")
        if name:
            out[name.strip()] = status[0]
    # new, never-added files count as added
    for name in _git("ls-files", "--others", "--exclude-standard", "--", path or ".").splitlines():
        out.setdefault(name.strip(), "A")
    return out


def _show(base_sha: str, name: str) -> str | None:
    done = subprocess.run(  # noqa: S603
        ["git", "show", f"{base_sha}:{name}"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    return done.stdout if done.returncode == 0 else None


def prompt_version_problems(base: str) -> list[str]:
    problems: list[str] = []
    # 1. every prompt file's version must equal its file name (also on a repo with no base).
    for path in sorted((ROOT / PROMPTS).glob("*.md")):
        match = re.search(r"^version:\s*(\S+)\s*$", path.read_text(encoding="utf-8"), re.MULTILINE)
        if not match or match.group(1) != path.stem:
            problems.append(f"{path.name}: front-matter `version` must equal the file name")
    base_sha = merge_base(base)
    if base_sha is None:
        return problems
    # 2. an existing prompt file may not change in place: create the next version instead.
    for name, status in changed(base_sha, PROMPTS).items():
        if status in {"M", "D"}:
            problems.append(
                f"{name}: changed in place ({status}). A prompt change = a NEW file with a bumped version "
                "(e.g. rx_extract_v2.md); then run the evals and note the result in the Decisions Log."
            )
    # 3. reply templates: any change needs a new `version:` in the yaml.
    template_changes = changed(base_sha, TEMPLATES)
    if template_changes:
        for lang in ("en", "hi"):
            name = f"{TEMPLATES}/{lang}.yaml"
            old = _show(base_sha, name)
            if old is None:
                continue
            old_version = yaml.safe_load(old).get("version")
            new_version = yaml.safe_load((ROOT / name).read_text(encoding="utf-8")).get("version")
            if old_version == new_version:
                problems.append(
                    f"templates changed but {name} still has version {new_version}: bump it"
                )
    return problems


@dataclass(frozen=True, slots=True)
class Rule:
    pattern: str
    suites: tuple[str, ...]
    needs_real: (
        bool  # True: real-mode report if the suite has a real mode; False: offline report is enough
    )


REAL_SUITES = {"emergency", "rx", "lab", "voice", "redteam"}
RULES: tuple[Rule, ...] = (
    Rule(f"{PROMPTS}/emergency_classify*", ("emergency", "redteam"), True),
    Rule(f"{PROMPTS}/image_classify*", ("rx", "redteam"), True),
    Rule(f"{PROMPTS}/rx_*", ("rx",), True),
    Rule(f"{PROMPTS}/lab_*", ("lab",), True),
    Rule(f"{PROMPTS}/intent_text*", ("redteam",), True),
    Rule(f"{PROMPTS}/generic_query*", ("redteam", "matcher"), True),
    Rule(f"{PROMPTS}/interaction_query*", ("redteam", "interactions"), True),
    Rule(f"{PROMPTS}/judge_*", ("rx",), False),
    Rule(f"{TEMPLATES}/*", ("rx", "lab", "redteam"), False),
    Rule("apps/ai-service/app/**/pricing.yaml", ("rx", "lab", "voice"), True),
    Rule(
        "evals/thresholds.yaml",
        ("emergency", "matcher", "interactions", "rx", "lab", "voice", "redteam"),
        False,
    ),
    Rule("apps/ai-service/app/safety/no_substitute.yaml", ("matcher", "rx"), False),
    Rule("apps/ai-service/app/safety/critical_values.yaml", ("lab",), False),
    Rule(
        "packages/contracts/safety/emergency-keywords.json",
        ("emergency", "voice", "redteam"),
        False,
    ),
)


def _matches(name: str, pattern: str) -> bool:
    return fnmatch.fnmatch(name, pattern) or fnmatch.fnmatch(name, pattern.replace("**/", ""))


def _model_default_changed(base_sha: str) -> bool:
    diff = _git("diff", "-U0", base_sha, "--", ".env.example", "apps/ai-service/app/config.py")
    return any(re.search(r"^[+-].*(VISION|TEXT|CHEAP)_MODEL", line) for line in diff.splitlines())


def required_evidence(base_sha: str) -> dict[str, tuple[str, bool]]:
    """{suite: (reason, needs_real)} for every suite the diff can affect."""
    need: dict[str, tuple[str, bool]] = {}
    files = changed(base_sha)
    for name in files:
        for rule in RULES:
            if _matches(name, rule.pattern):
                for suite in rule.suites:
                    previous = need.get(suite)
                    need[suite] = (name, rule.needs_real or (previous[1] if previous else False))
    if _model_default_changed(base_sha):
        for suite in ("emergency", "rx", "lab", "voice", "redteam"):
            need[suite] = ("model env default", True)
    return need


def _report_modes(base_sha: str) -> set[tuple[str, str]]:
    """(suite, mode) pairs covered by report JSON files added or changed in this diff."""
    covered: set[tuple[str, str]] = set()
    for name, status in changed(base_sha, REPORTS).items():
        if status == "D" or not name.endswith(".json"):
            continue
        try:
            data = json.loads(Path(ROOT / name).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        for run in data.get("runs", []):
            if run.get("passed"):
                covered.add((run["suite"], run["mode"]))
    return covered


def _waived(base_sha: str) -> bool:
    diff = _git("diff", "-U0", base_sha, "--", "CLAUDE.md")
    return any(line.startswith("+|") and WAIVER.search(line) for line in diff.splitlines())


def evidence_problems(base: str) -> list[str]:
    base_sha = merge_base(base)
    if base_sha is None:
        return []
    need = required_evidence(base_sha)
    if not need:
        return []
    if _waived(base_sha):
        print("eval evidence waived by a Decisions Log `eval-waiver` entry", file=sys.stderr)
        return []
    covered = _report_modes(base_sha)
    problems: list[str] = []
    for suite, (reason, needs_real) in sorted(need.items()):
        wants_real = needs_real and suite in REAL_SUITES
        accepted = {"real"} if wants_real else {"fake", "fake-noisy", "rules", "real"}
        if not any(s == suite and m in accepted for s, m in covered):
            kind = "real-mode" if wants_real else "offline"
            problems.append(
                f"{suite}: {reason} changed but this PR has no passing {kind} {suite} report under "
                f"{REPORTS}/. Run `make eval SUITE={suite}{' MODE=real' if wants_real else ''}` and commit "
                "the report, or add an `eval-waiver` Decisions Log row explaining why not."
            )
    return problems
