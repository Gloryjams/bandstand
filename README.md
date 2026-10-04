# Bandstand

A sheet music reader and gig book for working musicians, that you run yourself.

Put your charts on a computer you own. Read them on a tablet on stage. Build
setlists, mark up pages, loop the hard bar of a recording at half speed. Share the
book with your band, each member with their own sign-in. No account with anybody,
no subscription, nothing stored on somebody else's computer.

## What it does

**Reading**

- PDF charts with fast page turns: tap, swipe, keyboard or a Bluetooth pedal
- Half-page turns, two pages side by side in landscape, automatic margin cropping
- Pinch to zoom, and you can keep writing while zoomed in
- A dark stage mode that dims everything except the chart
- Bookmarks and jump links for repeats, D.S. and coda

**Marking up**

- Pen, highlighter, eraser and typed labels, with undo
- Markings are saved with the chart and appear on all your devices

**Setlists**

- Ordered sets with breaks, "up next" and reprises
- Play straight through a set without going back to the library

**Practice**

- Attach recordings to a tune
- Loop between two points, slow down without changing pitch, built-in metronome

**The band**

- The director owns the library. Members get their own key and can read, play and
  keep private notes, but cannot change the book
- Share links give a guest a read-only look at one chart or one set
- Rehearsal rooms let a group pick tunes together from their phones

**Built for bad connections**

- Changes made while the server is out of reach are kept on the device and sent
  when the connection comes back
- A change on one device shows up on the others without a manual refresh
- Charts can be stored on the device, so a gig with no signal is a normal gig.
  Browsers allow that only on a secure (`https://`) address. On the plain
  `http://` address of a first install the tablet needs to reach the server to
  show a chart. The guide explains both, under "Before your first gig"

## How it is put together

One server is one band. Each server has its own data folder, its own database and
its own key. Two bands are two servers, and they share nothing.

| Part | What it is |
| --- | --- |
| `server/` | Python 3.12, FastAPI, SQLite. Serves the API and the built web app |
| `client/` | React and TypeScript, built with Vite. An installable web app |
| `docs/` | The self-hosting guide |
| `Dockerfile`, `docker-compose.yml` | The packaged server |

There is no cloud service behind it and no third-party account to create.

## Quick start

Get Bandstand from [GitHub](https://github.com/gloryjams/bandstand). For a ZIP,
choose **Code, Download ZIP** on that page, or choose a version on the
[releases page](https://github.com/gloryjams/bandstand/releases).

You need Docker, with its `compose` and `buildx` parts. Then:

```
git clone https://github.com/gloryjams/bandstand.git bandstand
cd bandstand
docker compose up -d
```

Compose uses `ghcr.io/gloryjams/bandstand:0.1.0` by default. Set
`BANDSTAND_VERSION` to choose another numbered tag. It uses a cached copy if present,
otherwise tries to download the image and builds from this folder if the image
is missing. To build from source yourself, use `docker compose up -d --build`.

Open `http://localhost:7800/app/` and sign in with the key the server made for you:

```
docker compose exec bandstand sh -c "cat /data/.key; echo"
```

The full walk-through, written for musicians and not for programmers, covers
pairing a tablet, adding band members, backups and updates:

**[docs/SELF-HOSTING.md](docs/SELF-HOSTING.md)**

## Settings

Everything is optional. [`.env.example`](.env.example) lists every setting with an
explanation.

## Working on the code

```
# server, with automatic reload
cd server
python3.12 -m venv .venv
.venv/bin/pip install --require-hashes -r requirements-dev.lock
cd ..
BANDSTAND_DATA_DIR=./dev-data server/.venv/bin/python -m uvicorn server.main:app --reload --port 7800

# client, in a second terminal (it forwards /api to the server above)
cd client
npm ci
npm run dev
```

The development server above keeps its data in `./dev-data`. Always give a
development server a data folder of its own: without `BANDSTAND_DATA_DIR` it uses
`Bandstand` in your home folder, which may be a real library.

Tests:

```
(cd client && npx vitest run && npm run build && npm run check:copy)
(cd server && .venv/bin/python -m pytest -q)
python3 scripts/check-public-tree.py
```

Build the client first: one server test reads the built share page bundle.

`npm run build` runs the strict type check (`tsc -b`) before it builds, and writes
the web app into `server/static/`, which is where the server serves it from.

Releases are described in [RELEASING.md](RELEASING.md).

## The chart editor

Bandstand can carry SaltyCharts, a chord chart editor, at `/charts/`. It is a
separate project and optional, and is not available for download yet. See
"Adding the chart editor" in the self-hosting guide.

## Licence

Bandstand's code is licensed under [AGPL-3.0-or-later](LICENSE): you are free to
use, change and share it; if you run a changed version for other people, you
share your changes with them.

The Bones, Bonito and Pinch mascots are excluded from the AGPL and may only be
included unmodified in Bandstand builds that keep its name, as set out in
[NOTICE](NOTICE).

See [TRADEMARKS.md](TRADEMARKS.md) for the rules on names and official versions.
