"""Validation + identity helpers for native chord charts (Saltycharts JSON).

The server treats the chart body as opaque JSON — it never interprets sections, bars,
or the arrangement. It only checks the envelope (an object with a string title and an
array of sections) and enforces a size ceiling so a runaway payload can't be inlined
into a piece row and mirrored to every device.
"""
import re

# Charts are tiny (a few KB of text); 1 MB is a generous ceiling that still refuses a
# runaway/abusive payload before it lands in the DB and rides the manifest to devices.
MAX_CHART_BYTES = 1_000_000

CHART_SUFFIX = ".saltychart.json"

_UNSAFE = re.compile(r"[^A-Za-z0-9_-]")


def is_chart_file(name: str) -> bool:
    """True for a dropped/authored chart file (matched on the compound extension —
    Path.suffix only sees `.json`)."""
    return name.lower().endswith(CHART_SUFFIX)


def validate(chart: object, size_bytes: int) -> tuple[bool, str]:
    """Validate the chart envelope. Returns (ok, error_message)."""
    if size_bytes > MAX_CHART_BYTES:
        return False, "Chart is too large"
    if not isinstance(chart, dict):
        return False, "Chart must be a JSON object"
    if not isinstance(chart.get("title"), str):
        return False, "Chart 'title' must be a string"
    if not isinstance(chart.get("sections"), list):
        return False, "Chart 'sections' must be an array"
    return True, ""


def chart_id(chart: object) -> str:
    """The chart's Saltycharts id, stripped. Empty string if absent/blank — callers
    require a non-empty id (it's the UPSERT identity and the on-disk stem)."""
    if not isinstance(chart, dict):
        return ""
    return str(chart.get("id") or "").strip()


def safe_stem(source_id: str) -> str:
    """A filesystem-safe stem derived from the Saltycharts chart id, so a re-sent chart
    overwrites its own file instead of piling up duplicates."""
    return _UNSAFE.sub("_", source_id)[:80]
