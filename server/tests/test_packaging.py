"""The packaging files, checked the way a reviewer would read them.

None of this starts Docker. It reads the Dockerfile, the compose file, the settings
example and the workflows, and fails when one of the promises they make to a
self-hoster is quietly dropped.
"""
import re
from pathlib import Path

import pytest
import yaml

REPO = Path(__file__).parent.parent.parent
DOCKERFILE = REPO / "Dockerfile"
COMPOSE = REPO / "docker-compose.yml"
ENV_EXAMPLE = REPO / ".env.example"
WORKFLOWS = sorted((REPO / ".github" / "workflows").glob("*.yml"))

pytestmark = pytest.mark.skipif(
    not COMPOSE.exists(), reason="packaging files are not part of this checkout"
)


def _compose() -> dict:
    return yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))


def _variables(text: str) -> set[str]:
    return set(re.findall(r"\$\{([A-Z][A-Z0-9_]*)", text))


# ---------------------------------------------------------------- settings


def test_every_setting_the_compose_file_reads_is_documented():
    documented = set(re.findall(r"^#?([A-Z][A-Z0-9_]*)=", ENV_EXAMPLE.read_text(), re.M))
    missing = _variables(COMPOSE.read_text()) - documented
    assert not missing, f".env.example does not explain: {sorted(missing)}"


def test_examples_with_a_space_are_quoted():
    # An unquoted value is cut at the first "#" and mangled by "$" or a quote.
    for line in ENV_EXAMPLE.read_text().splitlines():
        m = re.match(r"^#?[A-Z][A-Z0-9_]*=(.*)$", line)
        if m and " " in m.group(1):
            assert m.group(1).startswith("'") and m.group(1).endswith("'"), line


# ---------------------------------------------------------------- compose


def test_the_band_is_tied_to_a_name_and_not_to_the_folder():
    assert _compose()["name"] == "${BANDSTAND_PROJECT:-bandstand}"


def test_the_default_start_is_one_service():
    services = _compose()["services"]
    always_on = [n for n, s in services.items() if not s.get("profiles")]
    assert always_on == ["bandstand"]


@pytest.mark.parametrize("service", ["bandstand", "share"])
def test_every_service_is_locked_down_and_bounded(service):
    s = _compose()["services"][service]
    assert s["read_only"] is True
    assert s["cap_drop"] == ["ALL"]
    assert "no-new-privileges:true" in s["security_opt"]
    assert s["mem_limit"], "no memory ceiling"
    tmp = [t for t in s["tmpfs"] if t.startswith("/tmp")]
    assert tmp and "size=" in tmp[0], "/tmp is memory and must have a size"


def test_the_share_pages_run_as_their_own_user_with_their_own_settings():
    share = _compose()["services"]["share"]
    assert share["user"] == "1001:1000"
    assert share["profiles"] == ["share"]
    assert share["command"] == ["python", "-m", "server.serve_share"]
    assert share["pull_policy"] == "never"
    assert "build" not in share, "a second build could replace the image with another one"
    env = share["environment"]
    for name in ("BANDSTAND_SHARE_ATTRIBUTION", "BANDSTAND_BEHIND_CF", "BANDSTAND_NAME"):
        assert name in env, f"the share pages never receive {name}"
    assert env["BANDSTAND_HEALTH_URL"] == "http://127.0.0.1:7810/health"
    # Guests reach a proxy or a tunnel, not this port.
    assert share["ports"][0].startswith("${BANDSTAND_SHARE_BIND:-127.0.0.1}:")
    main = _compose()["services"]["bandstand"]["environment"]
    assert "BANDSTAND_SHARE_PAGES" in main


# ---------------------------------------------------------------- image


def test_everything_the_image_is_built_from_is_pinned_by_digest():
    text = DOCKERFILE.read_text()
    assert re.match(r"# syntax=docker/dockerfile:1@sha256:[0-9a-f]{64}\n", text)
    images = re.findall(r"^ARG [A-Z]+_IMAGE=(\S+)$", text, re.M)
    assert len(images) == 2
    for image in images:
        assert re.search(r"@sha256:[0-9a-f]{64}$", image), image
    stages = set(re.findall(r"^FROM .* AS (\w+)$", text, re.M))
    for line in re.findall(r"^FROM (?:--platform=\S+ )?(\S+)", text, re.M):
        assert line in stages or line == "scratch" or line.startswith("${"), (
            f"FROM {line} is a floating tag"
        )


def test_the_server_is_copied_file_by_file():
    text = DOCKERFILE.read_text()
    assert not re.search(r"^COPY server/ ", text, re.M), "the whole folder is copied again"
    assert not re.search(r"^COPY \. ", text, re.M)


def test_the_ignore_file_is_an_allow_list_at_every_level():
    lines = [
        l.strip() for l in (REPO / ".dockerignore").read_text().splitlines()
        if l.strip() and not l.startswith("#")
    ]
    assert lines[0] == "*"
    for folder in ("server", "server/api", "server/ingest", "server/migrations", "client", "charts"):
        assert f"{folder}/*" in lines, f"everything in {folder}/ is admitted"
        assert lines.index(f"!{folder}/") < lines.index(f"{folder}/*")


def test_the_chart_editor_is_built_from_the_same_tree_by_default():
    text = DOCKERFILE.read_text()
    assert "WITH_CHARTS" not in text
    charts_stage = text.split(" AS charts", 1)[1].split("\nFROM ", 1)[0]
    assert "COPY charts/package.json charts/package-lock.json ./" in charts_stage
    assert "npm run build:bandstand" in charts_stage
    assert "COPY --from=charts /src/server/static/charts/ /app/server/static/charts/" in text


def test_the_runtime_has_no_installer_and_nothing_to_climb_with():
    runtime = DOCKERFILE.read_text().split(" AS runtime", 1)[1]
    assert "pip uninstall --yes pip" in runtime
    assert "-perm /6000 -exec chmod a-s" in runtime


# ---------------------------------------------------------------- workflows


def test_workflow_actions_are_pinned_by_commit():
    assert WORKFLOWS
    for workflow in WORKFLOWS:
        for ref in re.findall(r"uses: (\S+)", workflow.read_text()):
            if ref.startswith("./"):
                continue
            assert re.fullmatch(r"[\w./-]+@[0-9a-f]{40}", ref), f"{workflow.name}: {ref}"


def test_the_smoke_test_never_pipes_curl_into_a_quiet_grep():
    for path in [*WORKFLOWS, REPO / "scripts" / "smoke-test.sh"]:
        for line in path.read_text().splitlines():
            if line.lstrip().startswith("#"):
                continue
            assert not re.search(r"curl[^|]*\|\s*grep -q", line), f"{path.name}: {line.strip()}"
