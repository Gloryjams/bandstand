# Changelog

## 0.1.0

First public release of Bandstand, a sheet music reader and gig book you run
yourself.

- The code is available under AGPL-3.0-or-later. The Bones, Bonito and Pinch
  mascots and their artwork are reserved under [NOTICE](NOTICE). See
  [LICENSE](LICENSE) for the code licence.
- A ready-made Docker image and compose file let you run a server for your band
  on your own computer, including a 64-bit Raspberry Pi or an Apple Silicon Mac.
- Band members have their own sign-in links and private notes. Opening a sign-in
  link asks you to confirm before adding or replacing a band's sign-in.
- Rehearsal rooms are off until you switch them on. By default, one room can be
  open, with up to 60 guests and five song suggestions per guest per minute.
- Live updates now use a short-lived ticket that opens one connection, so your
  sign-in key stays out of the address. The old `?key=` address is deprecated:
  existing installs can keep it working for this release while devices update.
  New installs refuse it, and it will be removed in the release after 0.1.0.
- iPhone and iPad fixes use the PDF.js legacy build for wider support. Offline
  charts have a storage fallback, and the PDF worker that reads the pages is
  saved for offline use too.
- App icons make Bandstand easy to find on your home screen.
- Signing in checks the key with the server first: a key the server does not
  accept now says so, instead of signing in with the wrong role. Your tunes and
  sets show on the home screen straight after you sign in, and reloading the app
  keeps you on the page you were reading.
- The sign-in fields no longer zoom the page or autocorrect the key on an iPhone,
  and pressing Enter signs in.
- Uploads work when the data folder is reached through a symbolic link, also
  called a symlink.

If you are upgrading an older install, this release updates the database and
makes a backup first. Going back needs that backup as well as the older program.
Existing installs that use rehearsal rooms must switch them on again. See the
[upgrade notes](RELEASING.md#notes-for-an-install-that-already-exists) and the
[self-hosting guide](docs/SELF-HOSTING.md#update).
