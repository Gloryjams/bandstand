# Windows download

This packages the same server, reader, and included chart editor as the Docker
image. It reuses Bandstand's original portable demo approach with clean public
source, locked dependencies, and an external user data folder.

## Build and verify

Use a clean committed checkout on 64-bit Windows, Python 3.13 with pip, and
Node 22. From the repository root in PowerShell:

```powershell
./packaging/windows/build.ps1
./packaging/windows/verify.ps1
```

The download and its checksum are in `packaging/windows/dist/`. These are build
outputs and are not committed. `-SkipWebBuild` is restricted to CI, which downloads
the reader and editor artifacts built by the same run before using that option.
Local builds always build both web bundles from the current source.

Python's Windows runtime is pinned by version and the SHA-256 checksum from its
[official release page](https://www.python.org/downloads/release/python-31316/).
All Python packages are pinned and hash-checked in `requirements-windows.lock`.
The Windows SQLite DLL is separately pinned and hash-checked in
`python-runtime.json`. It comes from the [official SQLite downloads](https://www.sqlite.org/download.html)
and replaces Python's older bundled engine with a version containing the
[WAL-reset correction](https://www.sqlite.org/wal.html). The builder and finished
ZIP checks confirm the version actually loaded by the embedded Python.
To refresh the Python package lock from the server dependencies, use:

```sh
uv pip compile --generate-hashes --python-version 3.13 --python-platform windows \
  --constraint server/requirements.lock --no-header server/pyproject.toml \
  --output-file packaging/windows/requirements-windows.lock
```

The package includes an archive of the matching Git revision, all project and
font licences, Python's licence, and the dependencies' licence metadata. It
contains four generated exercises and a generated practice database with no
members. The build key is removed and checked against every file before zipping.
Each new user book gets its own key at launch. No real library is read.

The audit reads every file, including binaries and the nested source archive.
The verification script extracts into a new folder with spaces and brackets, starts
both real double-click entrypoints, verifies the default data folder, checks the real
server and guest reader, reserves a busy port, confirms ordinary startup is
loopback-only, then replaces the app and verifies the user's book survives.
A second data folder must have a different key and no data from the first.

For a browser playtest, `verify.ps1 -KeepForBrowser` keeps the last isolated
instance running and writes `browser-check.json` in its temporary directory.
The receipt contains process IDs and ports, never a key. Stop only that owned
instance and remove its temporary directory when the playtest is finished.

## Release

The Windows CI job builds and verifies the ZIP on every pull request. Its
`windows-download` artifact contains the ZIP and checksum. For a release, take
the artifact from the exact target revision and attach both files to the draft
release. Keep the release as a draft until its publication is approved.

Publication is a separate action. A workflow artifact is not a public download
link, and a source ZIP is not the Windows app.
