# Third-party notices

Bandstand and SaltyCharts use these runtime dependencies. Licence texts and
notices are included in `licenses/npm/`. Dependencies are unmodified; the npm
lockfiles identify the exact source distributions. Optional native packages for
other platforms are not included in the browser bundles.

| Package | Version | Licence | Used by |
| --- | --- | --- | --- |
| `@dnd-kit/accessibility` | 3.1.1 | MIT | client |
| `@dnd-kit/core` | 6.3.1 | MIT | client |
| `@dnd-kit/sortable` | 10.0.0 | MIT | client |
| `@dnd-kit/utilities` | 3.2.2 | MIT | client |
| `@napi-rs/canvas` | 1.0.10 | MIT | client |
| `@napi-rs/canvas-darwin-arm64` | 1.0.10 | MIT | client |
| `@types/react` | 19.3.0 | MIT | charts, client |
| `ansi-regex` | 5.0.1 | MIT | client |
| `ansi-styles` | 4.3.0 | MIT | client |
| `camelcase` | 5.3.1 | MIT | client |
| `cliui` | 6.0.0 | ISC | client |
| `color-convert` | 2.0.1 | MIT | client |
| `color-name` | 1.1.4 | MIT | client |
| `cookie` | 1.1.1 | MIT | client |
| `csstype` | 3.2.3 | MIT | charts, client |
| `decamelize` | 1.2.0 | MIT | client |
| `dexie` | 4.4.6 | Apache-2.0 | client |
| `dijkstrajs` | 1.0.3 | MIT | client |
| `emoji-regex` | 8.0.0 | MIT | client |
| `find-up` | 4.1.0 | MIT | client |
| `fuse.js` | 7.5.0 | Apache-2.0 | client |
| `get-caller-file` | 2.0.5 | ISC | client |
| `is-fullwidth-code-point` | 3.0.0 | MIT | client |
| `locate-path` | 5.0.0 | MIT | client |
| `p-limit` | 2.3.0 | MIT | client |
| `p-locate` | 4.1.0 | MIT | client |
| `p-try` | 2.2.0 | MIT | client |
| `path-exists` | 4.0.0 | MIT | client |
| `pdfjs-dist` | 6.4.299 | Apache-2.0 | client |
| `pngjs` | 5.0.0 | MIT | client |
| `qrcode` | 1.5.4 | MIT | client |
| `react` | 19.3.0 | MIT | charts, client |
| `react-dom` | 19.3.0 | MIT | charts, client |
| `react-router` | 7.18.4 | MIT | client |
| `react-router-dom` | 7.18.4 | MIT | client |
| `require-directory` | 2.1.1 | MIT | client |
| `require-main-filename` | 2.0.0 | ISC | client |
| `scheduler` | 0.28.0 | MIT | charts, client |
| `set-blocking` | 2.0.0 | ISC | client |
| `set-cookie-parser` | 2.7.2 | MIT | client |
| `soundtouchjs` | 0.3.0 | LGPL-2.1 | client |
| `string-width` | 4.2.3 | MIT | client |
| `strip-ansi` | 6.0.1 | MIT | client |
| `tslib` | 2.8.1 | 0BSD | client |
| `ulid` | 3.0.2 | MIT | client |
| `which-module` | 2.0.1 | ISC | client |
| `wrap-ansi` | 6.2.0 | MIT | client |
| `y18n` | 4.0.3 | ISC | client |
| `yargs` | 15.4.1 | MIT | client |
| `yargs-parser` | 18.1.3 | ISC | client |
| `zustand` | 5.0.15 | MIT | charts, client |

## Fonts

Space Grotesk and Baloo 2 are distributed unmodified under the SIL Open Font
License 1.1. Their copyright and licence texts are in `licenses/space-grotesk-OFL.txt`
and `licenses/baloo2-OFL.txt`. They come from the official Google Fonts repository:
[Space Grotesk](https://github.com/google/fonts/tree/main/ofl/spacegrotesk) and
[Baloo 2](https://github.com/google/fonts/tree/main/ofl/baloo2).

## SoundTouchJS

SoundTouchJS is under LGPL-2.1. Its licence is in `licenses/npm/soundtouchjs/`.
The unmodified library source is available in the npm package pinned by
`client/package-lock.json` and at [SoundTouchJS](https://github.com/cutterbl/SoundTouchJS).
To replace or modify it, install your version of `soundtouchjs` in `client/`,
then run `npm run build` or rebuild the Docker image from this source.
The app is delivered as JavaScript and carries no restriction on debugging or
replacing this library for your own use.
