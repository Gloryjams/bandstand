# Releasing

How a version number becomes an image somebody can run.

## The version lives in one place

`server/pyproject.toml`, the `version` line, is the source of truth for each release.

| Where it shows up | How it gets there |
| --- | --- |
| `GET /api/health` | `server/version.py` reads `pyproject.toml` at start |
| The app's Settings page | it displays what `/api/health` reports |
| The image label `org.opencontainers.image.version` | the release workflow passes it as a build argument |
| The image tag | the release workflow reads it from `pyproject.toml` |

A test (`server/tests/test_version.py`) fails if a second, hardcoded copy of the
version appears in the server source.

Version numbers are three numbers, `MAJOR.MINOR.PATCH`:

- **PATCH** for fixes.
- **MINOR** for new features. Existing data and settings keep working.
- **MAJOR** when a self-hoster has to do something by hand to upgrade.

## Cutting a release

1. **Start from a green main.** CI must pass on the commit you release.

2. **Bump the version.** Edit `version` in `server/pyproject.toml`.
   Set the same default image tag in `docker-compose.yml` and
   `BANDSTAND_VERSION` in `.env.example`, and refresh the version examples in the
   README and self-hosting guide.

3. **Update [CHANGELOG.md](CHANGELOG.md)** with the release's changes and any upgrade steps.

4. **Refresh the dependency locks if dependencies changed.** From `server/`:

   ```
   uv pip compile pyproject.toml --universal --python-version 3.12 \
     --generate-hashes --no-header -o requirements.lock
   uv pip compile pyproject.toml --extra dev --universal --python-version 3.12 \
     --generate-hashes --no-header -o requirements-dev.lock
   ```

   The image installs from `requirements.lock` with hash checking, so a release
   always contains exactly the packages that were tested.

5. **Check it locally.**

   ```
   (cd client && npm ci && npx vitest run && npm run build && npm run check:copy)
   (cd charts && npm ci && npm test && npm run build:bandstand)
   (cd server && python -m pytest -q)
   python3 scripts/check-public-tree.py
   docker build --no-cache -t bandstand:candidate .
   sh scripts/smoke-test.sh bandstand:candidate
   ```

   `--no-cache` matters. A cached build can carry a layer from an earlier build,
   and a candidate has to be exactly what the commit produces. The release
   workflow builds without a cache for the same reason.

6. **Commit, tag, push.** The tag is the version with a `v` in front.

   ```
   git commit -am "Release 0.2.0"
   git tag v0.2.0
   git push origin main v0.2.0
   ```

## What the tag does

Pushing a tag named `vX.Y.Z` starts `.github/workflows/release.yml`:

1. It runs the full CI (client tests and build, server tests, image build and smoke
   test).
2. It compares the tag with the version in `server/pyproject.toml` and stops if
   they differ. A tag can never publish a version the code does not claim to be.
3. It builds the image for `linux/amd64` and `linux/arm64`. The second one is what
   a Raspberry Pi and an Apple Silicon Mac run.
4. It pushes two tags to the GitHub Container Registry of the repository:
   `ghcr.io/gloryjams/bandstand:X.Y.Z` and
   `ghcr.io/gloryjams/bandstand:latest`. The image carries a provenance record
   and a list of its contents.

Pre-release tags such as `v0.2.0-rc1` are informal markers. The release workflow
only builds tags in the form `vX.Y.Z`, and refuses a tag whose version differs
from `server/pyproject.toml`. An `rc` tag does not publish an image.

`:latest` moves with every release. Somebody who wants to stay on one version
uses the numbered tag.

The only credential is the `GITHUB_TOKEN` that GitHub creates for each run. There
is no secret to configure.

A new package on the registry starts out private. Making it public is a deliberate
step in the package's settings on GitHub.

## After the release

The public source is [gloryjams/bandstand](https://github.com/gloryjams/bandstand).
ZIP downloads are under **Code, Download ZIP** there, or on the
[releases page](https://github.com/gloryjams/bandstand/releases).

Compose defaults to `ghcr.io/gloryjams/bandstand:0.2.0`. A self-hoster chooses
a numbered image tag in `.env`:

```
BANDSTAND_VERSION=0.2.0
```

Change that number to the release being installed, then run
`docker compose pull bandstand` followed by `docker compose up -d`. The share
profile uses the same image. `BANDSTAND_VERSION=latest` follows the newest release
and is also pulled on each `docker compose up`. `BANDSTAND_IMAGE` can override
the full image name and tag, taking the place of `BANDSTAND_VERSION`.

Compose keeps both `image` and `build`: for a numbered tag it reuses a cached
image, otherwise tries to pull it, then builds from source if the image is
missing. For a source build, including the bundled chart editor, update the source and run
`docker compose up -d --build`. This forces a build even if an image is present.
For the exact rules, see Docker's [build specification](https://docs.docker.com/reference/compose-file/build/)
and [compose up options](https://docs.docker.com/reference/cli/docker/compose/up/).

## Database changes

Schema changes are numbered files in `server/migrations/`. The server applies any
that are missing when it starts, in order. Rules:

- Number them without gaps. A test checks this.
- Each file records its own version in `schema_version`, inside the same
  transaction as the change. A test checks this too.
- Never edit a migration that has been released. Add a new one.
- A release that adds a migration gets a test for it, upgrading a database that
  holds data.

There are no down-migrations. Two things make the way back possible:

- Before the server upgrades an existing database it saves a copy of it, under
  `backups/library.db.before-upgrade-vN-to-vM-<time>` in the data folder, and says
  so in the log. These copies are never deleted automatically.
- An older server refuses to start on a database that a newer one has changed.
  It does not open it and damage it.

The self-hosting guide describes going back, under "Going back after a bad
update". Say in the release notes whenever a release contains a migration.

## What is pinned, and how it moves

| What | Pinned by | Moved by |
| --- | --- | --- |
| Python packages | hash, in `server/requirements.lock` | step 4 above |
| Base images and the Dockerfile frontend | digest, in `Dockerfile` | Dependabot |
| GitHub Actions | commit, in `.github/workflows/` | Dependabot |

`.github/dependabot.yml` asks for both kinds of update weekly. A server test fails
when a floating tag comes back.

## The chart editor

SaltyCharts is included in `charts/`, under the repository licence and artwork
exceptions in NOTICE. Every normal Docker build includes it. Source installs
also run `(cd charts && npm ci && npm run build:bandstand)`.

Version 0.2.0 adds the editor to the reader as one app. The earlier 0.1.0 tag had
no published release page. Release notes should lead with creating a chart and
seeing it enter the band's book, and include the sign-in fixes in this tree.

## Notes for an install that already exists

Things that behave differently from the code that ran before packaging. Put them
in the release notes of the first public version.

- **One server per data folder.** A second server on the same folder refuses to
  start. The share pages and the members command are not servers in this sense and
  keep working next to it.
- **The default data folder is `Bandstand` in the home folder.** It used to be a
  fixed Windows path. Every install should set `BANDSTAND_DATA_DIR`.
- **A blank `BANDSTAND_DATA_DIR` is refused.** Other blank settings count as not
  set: a blank name is "Bandstand", a blank port is 7800.
- **Share links need `BANDSTAND_PUBLIC_BASE`.** Without it the app answers that
  share pages are not set up. It used to mint links to `127.0.0.1:7810`.
- **The credit line on share pages** is `BANDSTAND_SHARE_ATTRIBUTION`, default
  "Shared from a gig book". It is read by the share pages process, so it has to be
  set there.
- **`python -m server.serve` makes an existing key owner-only** (mode 600).
- **`/api/health` answers 503** when the director key is missing or damaged.
- **`/charts` without the editor** answers 404 with a page for people. It used to
  be a JSON 404. Asset addresses under `/charts` keep the JSON 404.
- **`/`** leads to `/app/`.
- **Uploads are refused before they are read** when the key is missing or the size
  is over the limit. A chunked request no longer passes the size ceilings.
- **Rehearsal rooms are off until `BANDSTAND_ROOMS=1`.** An install that used rooms
  must set it to keep them. While off, every rooms route and the `/room` page answer
  404. When on, `BANDSTAND_ROOMS_MAX_OPEN` (default 1),
  `BANDSTAND_ROOMS_MAX_GUESTS` (default 60) and
  `BANDSTAND_ROOMS_PROPOSALS_PER_MINUTE` (default 5, 0 for none) bound them, and the
  director can remove any posted song. Migration 8 drops the database index that
  hard-wired one open room; the server enforces the cap instead. It is the first
  schema change since the baseline, so once this version has started, an older
  version refuses the database: going back means restoring the automatic
  before-upgrade copy (see "Going back after a bad update" in SELF-HOSTING.md).
  Say so in the release notes.
- **The live update stream opens with a ticket.** The app asks
  `POST /api/events/ticket` with its key in the header and opens
  `GET /api/events?ticket=...`; a ticket lives one minute and opens one stream, so
  nothing lasting is in the address any more. This holds at every door: the band's
  own address, the HQ front door (`/bands/<band>/api/...` for the director) and the
  public member door (the same path on the share process, for members over the
  tunnel). The old `?key=` address still works when `BANDSTAND_EVENTS_KEY_IN_URL=1`,
  and, with the setting unset, on a data folder that already had data when it first
  met this version (a fresh install refuses it, at every door). The server
  remembers that answer in its database; the member door reads the band's answer.
  Remove the setting and the old address, at all three doors, in the release after
  this one.

## Licence

Bandstand's code is licensed under AGPL-3.0-or-later. The full terms are in
[LICENSE](LICENSE). The Bones, Bonito and Pinch mascots and their artwork are
reserved as described in [NOTICE](NOTICE), including the app icons. See
[TRADEMARKS.md](TRADEMARKS.md) for the rules on names and official versions.

## Not decided yet

- **What goes into the public tree.** `.gitattributes` holds a proposal: the files
  marked `export-ignore` stay private. `python3 scripts/check-public-tree.py`
  checks the rest for private names and for dashes.
- **Screenshots for the README.** The existing ones show a real library with other
  people's sheet music in it. New ones need a library made for the purpose.
