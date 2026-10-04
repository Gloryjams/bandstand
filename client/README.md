# Bandstand client

The web app that musicians use: a React and TypeScript app built with Vite. It is
built into `../server/static/`, and the Bandstand server serves it from there.

Three bundles come out of one build:

| Bundle | Served at | For |
| --- | --- | --- |
| `app` | `/app/` | The band: library, viewer, setlists, practice bar |
| `guest` | share pages | Guests who open a share link |
| `room` | `/room/` | Rehearsal room guests |

## Commands

```
npm ci              # install, exactly as locked
npm run dev         # development server, forwards /api to a server on port 7800
npx vitest run      # unit tests
npm run build       # strict type check (tsc -b), then all three bundles
npm run check:copy  # no em-dashes or en-dashes in anything the bundles show
npm run lint        # reports known problems, does not block
```

`npm run build` is the real type check. `tsc -b` is stricter than
`tsc --noEmit`.

## Where things are

| Folder | What is in it |
| --- | --- |
| `src/routes/` | One file per screen |
| `src/components/` | Shared parts of screens |
| `src/lib/` | Logic without a screen: sync, storage, navigation, sharing |
| `src/hooks/` | Gestures and annotations for the viewer |
| `src/tests/` | Unit tests |
| `public/` | Fonts and icons, shipped as they are. No font is loaded from the internet |

The project README one level up explains how to run the server that this app
talks to.
