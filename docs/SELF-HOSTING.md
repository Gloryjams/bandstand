# Run your own Bandstand

This guide is for a musician with a spare computer. No programming needed. You will
copy a few commands into a terminal window and that is all.

When you finish you will have:

- a Bandstand server running on your computer, for one band
- your tablet signed in and showing your charts
- a backup you know how to restore

Time needed: about 20 minutes, most of it waiting for downloads.

> **Public beta.** Bandstand is a public beta. Run it on your home network or behind Tailscale or WireGuard. If you put it on the internet, use https (a reverse proxy) and set `BANDSTAND_LIBRARY_QUOTA_MB`. Anyone who can watch your network traffic on plain http can read the director key. Only add bands, open sign-in links and import band copies from people you trust. Rehearsal rooms let anyone holding the room QR code post to your server while the room is open: close the room when rehearsal ends.

## What you need

- A computer that can stay switched on while you use Bandstand. An old laptop, a
  Mac mini, a small Linux box or a Raspberry Pi 4 or 5 all work.
- On a Raspberry Pi, the 64-bit system. To check, type `uname -m` in a terminal. It
  must print `aarch64`. If it prints `armv7l`, install the 64-bit Raspberry Pi OS
  first: Bandstand cannot be built on the 32-bit one.
- About 2 GB of free disk space, plus room for your charts and recordings.
- The tablet or phone you read charts on, connected to the same Wi-Fi.

## The idea in one paragraph

One Bandstand server is one band. It keeps everything in one data folder: your
charts, the database with your setlists and markings, and one secret key. Nothing is
sent to anybody else's computer. If you play in two bands, you run two servers and
each has its own folder and its own key.

## Step 1. Install Docker

Docker runs Bandstand in a sealed box, so you do not have to install anything else.

- **Mac or Windows:** install Docker Desktop from <https://www.docker.com/get-started/>
  and start it once.
- **Linux or Raspberry Pi:** follow <https://docs.docker.com/engine/install/> for
  your system, then the "Linux post-install" page so you can run Docker without
  `sudo`.

Check that it works. Open a terminal and type:

```
docker --version
docker compose version
docker buildx version
```

All three should print a version number. If the third one says that `buildx` is not
a docker command, see "buildx is missing" under "When something is wrong".

## Step 2. Get Bandstand

Open [Bandstand on GitHub](https://github.com/gloryjams/bandstand), choose
**Code, Download ZIP**, and unzip it. To get a particular version, use its source
ZIP on the [releases page](https://github.com/gloryjams/bandstand/releases).
Open a terminal inside the unzipped folder.

If you use git, these commands download Bandstand and enter its folder:

```
git clone https://github.com/gloryjams/bandstand.git bandstand
cd bandstand
```

All the commands below are typed inside that folder.

## Step 3. Start it

If the 0.2.0 image has not been published publicly yet, use the source build
`docker compose up -d --build` instead. Both reader and editor are built together.

This is the one command:

```
docker compose up -d
```

The first time, Docker downloads the ready-made image
`ghcr.io/gloryjams/bandstand:0.2.0`. It has versions for both ordinary Intel or
AMD computers (`linux/amd64`) and Apple Silicon Macs and 64-bit Raspberry Pis
(`linux/arm64`). Docker chooses the right one. The download needs an internet
connection and can take a few minutes. Later starts reuse the downloaded copy.

The compose file includes both an image name and a way to build from source.
For a numbered tag, Compose uses a cached copy if present, otherwise tries the
registry first. If the image is not found, it builds from this folder. A "pull
access denied" message is not expected for the public image; see "When something
is wrong" below.

To build from the source in this folder yourself, use:

```
docker compose up -d --build
```

`--build` forces a source build even if a ready-made image is available. It can
take a few minutes. To choose another published version, see "Update".

Check that it is running:

```
docker compose ps
```

You are looking for the word `healthy`. If it says `starting`, wait half a minute
and look again.

## Step 4. Open the address

On the same computer, open a browser and go to:

```
http://localhost:7800/app/
```

You should see the Bandstand sign-in page.

From your tablet you need the computer's address on your network instead of
`localhost`. To find it:

- **Mac:** System Settings, Network, your Wi-Fi, Details. Look for "IP address".
- **Windows:** Settings, Network and internet, your connection, Properties. Look
  for "IPv4 address".
- **Linux or Raspberry Pi:** type `hostname -I` in a terminal.

It looks like `192.168.1.20`. On the tablet, open:

```
http://192.168.1.20:7800/app/
```

(with your own numbers in place of `192.168.1.20`).

Tip: ask your router to always give this computer the same address. Routers call
this a "reserved" or "static" address. Otherwise the address can change after a
restart and the tablet will not find the server.

## Step 5. Find the director key

The first time Bandstand started, it made a secret key for you. The key is the
password for the whole band library. Whoever has it can change everything.

Bandstand never prints the key in its logs. It only tells you where the key is. To
read it, type:

```
docker compose exec bandstand sh -c "cat /data/.key; echo"
```

You will see one line of 64 letters and numbers. Copy exactly that line, all 64 and
nothing else, somewhere safe, for example a password manager.

Keep it private:

- Do not post it in a group chat.
- Do not put it in a screenshot.
- Band members do not need it. They get their own keys (see "Add band members").

## Step 6. Pair a tablet

1. On the tablet, open the address from Step 4.
2. Leave "Server URL" as it is.
3. Paste the director key into "Key" and tap **Sign in**.

The tablet is now paired. To add your phone without typing the key again, open
**Settings** on the tablet and show the sign-in code, then scan it with the phone's
camera. The phone shows which band and which server the code is for, and asks you to
confirm before it signs in. Tap **Add band**, or **Cancel** if it is not the one you
expected.

A sign-in link or code never signs a device in on its own. If you open one by
mistake, or one for a band this device is already in, the app says what would change
first: a new band to add, or a sign-in it would replace. **Cancel** leaves everything
as it was.

To make Bandstand feel like an app, use your browser's "Add to Home Screen" or
"Install" option.

## Step 7. Add your charts

In the app, open **Library** and tap **Add chart**. PDF files work best.

You can add recordings to a tune too. They show up as a practice bar with looping
and slow-down.

## Before your first gig: charts without a connection

Read this before you rely on Bandstand on a stage.

With the setup from this guide, your address starts with `http://`. On an address
like that, the tablet shows charts only while it can reach the server. It does not
keep them for later. This is a rule of web browsers, not a choice Bandstand made:
they allow a web app to store files only on a secure address.

So for a gig, one of these has to be true:

- **The server comes along.** The computer and the tablet are on the same network
  at the gig, for example a small travel router or a laptop you bring.
- **The tablet has a secure address for the server.** Then "Pre-cache for offline" in a
  setlist works, and a gig with no signal at all is fine. The two ways to get a
  secure address are described in "Reaching Bandstand from outside your home".

If you try "Pre-cache for offline" on a plain `http://` address, the app tells you that
offline storage needs a secure connection. Nothing is broken when it says that.

## Add band members

Band members get their own key. A member can read charts and setlists, play the
recordings and keep private notes. A member cannot change or delete anything in the
library.

The easy way is in the app. Open **People**, type the player's name and press
**Make sign-in link**. The app shows a link and a QR code. Send the link to that
person privately, or let them scan the code. They open it on their phone or tablet,
check that it names your band, tap **Add band**, and they are in. The link is shown
once. If it gets lost, press
**New link** next to their name: that makes a fresh one and the old one stops
working.

That is what the app means by a "sign-in link": your server's address with the
player's key attached. Anybody who has the link has the key, so send it the way you
would send a password.

You can do the same from the command line:

```
docker compose exec bandstand python -m server.members add "Rea"
```

The member's key is shown once. Send it to that person privately, together with the
address of the server. They open the address and sign in the same way you did in
Step 6, with their own key. Or build the sign-in link yourself, on one line, with
your own address and their key:

```
http://192.168.1.20:7800/app/#url=http://192.168.1.20:7800&key=THEIR-KEY
```

Other commands:

```
docker compose exec bandstand python -m server.members list
docker compose exec bandstand python -m server.members revoke <id>
docker compose exec bandstand python -m server.members rotate <id>
```

`revoke` switches a key off, for example after a lost phone. `rotate` switches the
old key off and makes a new one for the same person. Their private notes come along
with the new key.

If somebody got a new key on an older version of Bandstand and their notes went
missing, the notes are still there under their old id. Find both ids with `list`
(the old one shows as revoked) and reattach them:

```
docker compose exec bandstand python -m server.members reattach-notes <old-id> <new-id>
```

The old id must be one that is revoked, and the two ids must carry the same name.
If the person was added again under a different spelling, add
`--allow-different-name` to the end of the command.

## Rehearsal rooms (off until you switch them on)

A rehearsal room is a QR code on the wall of the room. Everyone scans it with their
phone, posts the songs they want to play, votes, and says which part they can cover.
The director sees the pool on the tablet, builds the order and calls each tune.

Anyone who can see that QR code can join. A photo of it is enough. That is fine in a
rehearsal room with the door shut and a risk anywhere else, so rooms are switched
off on a new install. To switch them on, add this line to `.env` and type
`docker compose up -d`:

```
BANDSTAND_ROOMS=1
```

While a room is open, anyone holding the code can post to your server, so close the
room when rehearsal ends. Guests usually join your Wi-Fi to reach the room, so
prefer a secure `https://` address for rooms (see "Reaching Bandstand from outside
your home").

While rooms are off, the "Start rehearsal" button in the app says that rooms are
switched off, and an old room QR code opens a page that says the same.

**If your install had rooms before this setting existed**, you must add that line
to keep them. Nothing is deleted while rooms are off: the room and its songs come
back the moment the setting is on.

Rooms have limits, so a QR code that ends up somewhere it should not cannot flood
the band's screen:

| Setting | What it does | If you leave it alone |
| --- | --- | --- |
| `BANDSTAND_ROOMS_MAX_OPEN` | How many rooms may be open at once | 1 |
| `BANDSTAND_ROOMS_PROPOSALS_PER_MINUTE` | How many songs one guest may post per minute, 0 means no limit | 5 |
| `BANDSTAND_ROOMS_PARTICIPATION_PER_MINUTE` | How many new votes and volunteer choices one guest may make per minute, counted together, 0 means no limit | 30 |
| `BANDSTAND_ROOMS_MAX_GUESTS` | How many guests one room takes | 60 |

The app shows one room at a time, so leave the first one at 1 unless you have a
reason. A guest who posts more than the limit is told to wait a moment. A song a
guest has posted and then had removed still counts. When a room is full, the next
person to scan the code is told so; closing the room and starting a new one makes
space again.

Each room takes at most 200 songs, including songs the director has removed.
When it reaches that limit, start a new room. Each guest can volunteer for at most
4 instruments on one song. Votes and volunteer choices share a minute's allowance;
repeating the same choice uses no allowance. Choices on removed songs still count
for that minute. A musical key can have at most 16 characters.

A room's link expires after 12 hours. An expired room makes space for a new room
just like a closed one. The director cannot change the queue after a room closes
or its link expires.

The director keeps control in the room itself. Each song in the pool has a
**Remove** button, which takes it off every phone at once, including the queue if
it was already promoted. **Close rehearsal** ends the room: guests see that it has
ended, and the QR code stops working. A room's QR code also stops working on its
own 12 hours after the room opened.

## Back up the data folder

Everything lives in one place inside the box, called `/data`. A backup is a copy of
that folder.

```
docker compose stop
docker compose cp bandstand:/data ./bandstand-backup
docker compose start
```

You now have a folder called `bandstand-backup` inside the Bandstand folder. Copy
it to an external drive or another computer. A backup that sits on the same disk as
the original does not protect you from a broken disk.

Four things to know:

- If a folder called `bandstand-backup` is already there from last time, rename it
  first, for example to `bandstand-backup-january`. Otherwise the new copy lands
  inside the old one.
- Stop the server first, as shown. Copying the database while it is being written
  to can give you a damaged copy.
- The backup contains the director key. Treat the backup as a secret.
- Bandstand also saves a snapshot of the database once a day and keeps the last 14,
  inside the data folder under `backups`. These rescue you from a mistake, such as
  a deleted setlist. They do not replace your own backup, because they sit on the
  same disk.

Do a backup before every update, and any time you have added a lot of charts.

## Restore a backup

A restore **replaces everything**: charts, setlists, markings, members and the key
all go back to what they were when the backup was made. Anything added after the
backup is gone afterwards.

There are two situations. Pick the one that is yours.

### On a new computer

1. Install Docker and get Bandstand (Steps 1 and 2). Do not start it yet.
2. Put your `bandstand-backup` folder inside the Bandstand folder, next to the file
   `docker-compose.yml`.
3. Type these four commands:

```
docker compose up --no-start
docker compose cp ./bandstand-backup/. bandstand:/data/
docker compose run --rm --no-deps --user root --cap-add CHOWN --cap-add DAC_OVERRIDE --entrypoint chown bandstand -R 1000:1000 /data
docker compose up -d
```

### On the same computer, where Bandstand is or was running

The data that is there now has to go first. If you copy a backup on top of a
running server you get a mix of old and new, which is worse than either.

1. If anything in the current data matters to you, make a backup of it now, under
   another name (see "Back up the data folder").
2. Put the backup you want to restore inside the Bandstand folder, named
   `bandstand-backup`.
3. Type these five commands. The first one **deletes the current data**:

```
docker compose down --volumes
docker compose up --no-start
docker compose cp ./bandstand-backup/. bandstand:/data/
docker compose run --rm --no-deps --user root --cap-add CHOWN --cap-add DAC_OVERRIDE --entrypoint chown bandstand -R 1000:1000 /data
docker compose up -d
```

### About the long command

The long command in the middle is important. Copied files arrive belonging to the
wrong user, and it hands them back to the server. If you skip it, the server will
refuse to start and its log will say that it "cannot use its data folder". Run the
long command and start again.

Your tablets stay paired after a restore, because the key came back with the
backup.

## Update

First make a backup, as described above, and read the version's notes in
[CHANGELOG.md](../CHANGELOG.md). Get the updated files:

```
git pull
```

`git pull` fetches the new version. If you downloaded a ZIP instead of using git,
download the new ZIP and copy its contents over the old folder. Your own files,
`.env` and `docker-compose.override.yml`, are not part of the download and stay as
they are.

For the published image, set `BANDSTAND_VERSION` in `.env` to the release number
you want, without the leading `v`, such as `0.2.0`. See "Settings" below if you
have not made that file yet. A numbered tag stays on that version until you
change it. The tag `latest` follows the newest release and is also pulled each
time you run `docker compose up`. If you set `BANDSTAND_IMAGE`, change its full
image name and tag instead; it takes the place of `BANDSTAND_VERSION`.

Then download that image and start it:

```
docker compose pull bandstand
docker compose up -d
```

If the pull fails, follow the image troubleshooting entry below before starting.
The optional share pages use the same image, so they need no separate download.

If you build from source, including a build with the chart editor, use this
instead of the two image commands above:

```
docker compose up -d --build
```

Your data is kept. If the new version needs to change the database, it does so by
itself when it starts. Before it changes anything it saves a copy of the database
as it was, and the log tells you where:

```
Database upgraded from version 6 to 7. A copy from before the upgrade is at /data/backups/library.db.before-upgrade-v6-to-v7-20260929-201637
```

Those copies are never deleted automatically.

To see which version is running, open `http://localhost:7800/api/health` in a
browser.

### Going back after a bad update

An older Bandstand cannot use a database that a newer one has changed. It refuses
to start and says that the data "was written by a newer Bandstand". So going back
is two steps: the old program, and the old data.

1. Get the old program back. With git, `git checkout` the version you had. With a
   ZIP, use the ZIP of that version. For the published image, also set
   `BANDSTAND_VERSION` in `.env` to that version and run
   `docker compose pull bandstand`. If you set `BANDSTAND_IMAGE`, change its tag
   instead.
2. Get the old data back. Either restore your own backup from before the update
   (see "Restore a backup"), or, if you have none, put back the copy that Bandstand
   saved:

```
docker compose stop
docker compose run --rm --no-deps --entrypoint sh bandstand -c "ls /data/backups"
docker compose run --rm --no-deps --entrypoint sh bandstand -c "cp /data/backups/NAME-OF-THE-COPY /data/library.db && rm -f /data/library.db-wal /data/library.db-shm"
docker compose up -d
```

For a source build, use `docker compose up -d --build` as the last command to
build the old source again.

The second command lists the copies. Use the name that starts with
`library.db.before-upgrade` in the third command. Charts you added after the update
stay in the library folder and are picked up again when the server starts. Setlists
and markings made after the update are lost.

## Settings

Settings are optional. To change one, copy the file `.env.example` to a new file
called `.env` in the same folder, edit it, then type `docker compose up -d`.

The ones most people use:

| Setting | What it does | If you leave it alone |
| --- | --- | --- |
| `BANDSTAND_NAME` | The band name shown in the app | Bandstand |
| `BANDSTAND_PORT` | The number after the colon in the address | 7800 |
| `BANDSTAND_VERSION` | The published image tag to run | 0.2.0 |
| `BANDSTAND_MAX_UPLOAD_MB` | Largest file you can upload | 50 |
| `BANDSTAND_LIBRARY_QUOTA_MB` | Ceiling for the whole library, 0 means none | 0 |
| `BANDSTAND_ROOMS` | Switches rehearsal rooms on, see "Rehearsal rooms" | off |

Put a name in single quotes. Without them, a name with `#`, `$` or a quote mark in
it is silently cut short:

```
BANDSTAND_NAME='The #1 Band'
```

A name with an apostrophe in it goes in double quotes:

```
BANDSTAND_NAME="Rea's Trio"
```

`.env.example` lists all settings with explanations.

Do not edit `docker-compose.yml` itself. An update replaces it, and with git an
edited file stops the update.

## Do not rename the band's project

Docker finds your band's data by a name, the "project". It is `bandstand` unless
you set `BANDSTAND_PROJECT` in `.env`.

- You may rename or move the Bandstand **folder**. The data stays attached.
- Do not change `BANDSTAND_PROJECT` once the band has data. With a new project
  name Docker starts an empty library with a new key. Your data is not deleted. It
  comes back when you set the old name again.

## A second band

Make a second copy of the Bandstand folder. In that copy, create a `.env` file
with a different project, a different name and a different port:

```
BANDSTAND_PROJECT=lockups
BANDSTAND_NAME='The Lockups'
BANDSTAND_PORT=7801
```

All three lines matter. `BANDSTAND_PROJECT` is small letters, numbers and dashes.
If two folders use the same project, Docker treats them as one band: starting the
second one takes over the first band's server and shows the first band's charts.
Nothing is lost if that happens. Give the second folder its own project and start
both again.

Then type `docker compose up -d` inside that folder. The second band has its own
data, its own key and its own address (ending in `:7801`). The two bands cannot see
each other's charts.

## Create a chord chart

SaltyCharts is included with Bandstand. Sign in as a director and choose **New
chart**. The editor uses your current sign-in when the reader and editor are on
the same server and browser. On another device, or when the reader lives on
another origin, enter the band's director key once under **Bandstand sync**.

Make a chart and wait for **Synced with Bandstand**. It appears in the band's
library; members can read it with their own sign-in. Later edits update the same
chart. If a connection drops, edits remain on the device until it reconnects.

No extra checkout, build flag or Compose override is needed. If **New chart** is
unavailable on a source install, build `charts/` as well as `client/` using the
commands in "Without Docker" below.

## Share links (optional, advanced)

A share link lets somebody who is not in the band look at one chart or one setlist,
read-only, on their phone. Share pages are served by a second, separate program so
that strangers never reach the main app. That program runs as its own user. It can
read the library. It cannot read the director key and it cannot change the
database.

This needs a web address that guests can open, which means a reverse proxy or a
tunnel. If that sentence means nothing to you, skip this section. Bandstand works
without it. Until share pages are set up, the app does not make share links and
says so.

Add these three lines to `.env`, with the web address your guests will use:

```
COMPOSE_PROFILES=share
BANDSTAND_SHARE_PAGES=1
BANDSTAND_PUBLIC_BASE=https://share.example.com
```

Then type:

```
docker compose up -d
```

`docker compose ps` now shows two lines, `bandstand` and `share`, both `healthy`.
Point your proxy or tunnel at port 7810 on this computer. The share pages listen
on this computer only, because the proxy is what guests reach.

Settings that belong to the share pages, all in `.env`:
`BANDSTAND_SHARE_ATTRIBUTION` (the credit line at the bottom of each page),
`BANDSTAND_BEHIND_CF`, `BANDSTAND_SHARE_PORT`.

The share pages never log requests, because every share address contains its own
secret token. Make sure your proxy does not log them either.

Everything else in this guide covers the share pages too: stop, start, update,
backup and "Stop and remove" all act on both programs.

To switch share pages off again, type this first:

```
docker compose rm --stop --force share
```

Then remove the three lines from `.env` and type `docker compose up -d`. Links you
handed out stop working. They work again, until they expire, if you switch share
pages back on.

## Reaching Bandstand from outside your home

At home, on your own Wi-Fi, the plain `http://` address works for reading charts
while the server is on, as long as you trust everyone on that network. On plain
`http://` every device sends its key unencrypted, so anyone who can watch the
network traffic can read it, including the director key. On a shared or guest
network, and whenever you run rehearsal rooms, use one of the secure options
below.

Only add bands, open sign-in links and import band copies from people you trust.

For rehearsals and gigs elsewhere you have two good options:

- **A private network app** such as Tailscale or WireGuard on the server and on
  each device. The server stays invisible to the rest of the internet. This is the
  safer choice. Tailscale can also give the server a secure `https://` address of
  its own, which is what the tablet needs to keep charts for offline use.
- **A reverse proxy with https.** This gives you a normal web address, and it lets
  tablets store charts for offline use. There is a short note about this at the
  bottom of `docker-compose.yml`.

If you open a server to the internet, set `BANDSTAND_LIBRARY_QUOTA_MB` to a real
number first.

## When something is wrong

**See what the server is saying:**

```
docker compose logs --tail 50
```

**"buildx is missing", or "Docker Compose requires buildx plugin to be installed",
or "failed to parse platform"**
Docker's build tool is not installed. Docker Desktop includes it. On Linux install
the package `docker-buildx-plugin` (it comes from the same place as Docker). On a
Mac without Docker Desktop: `brew install docker-buildx`, then follow the two lines
it prints. Check with `docker buildx version`, then start again.

**"pull access denied", "denied", or "manifest unknown" when downloading the image**
These are not expected for the public image. Check your internet connection and
the image settings in `.env`. The default is
`ghcr.io/gloryjams/bandstand:0.2.0`. `BANDSTAND_VERSION` must name a published
tag without a leading `v`; `BANDSTAND_IMAGE`, if set, replaces the whole name and
tag. Try `docker compose pull bandstand` again. If the name and tag are right,
the package may not yet be public or the tag may not have been published.
Compose may fall back to building from this folder, but the download problem
still needs attention. To build from source yourself, use
`docker compose up -d --build` as in Step 3.

**"Cannot start: The server cannot use its data folder"**
Files in the data folder belong to the wrong user. Run the long `chown` command from
"Restore a backup", then `docker compose up -d`.

**"Cannot start: The director key ... is empty or damaged"**
The key file was cut short, usually by a full disk or a crash. Restore the file
`.key` from your backup. If you have no backup, see "I lost the director key".

**"Cannot start: Another Bandstand server is already running on the data folder"**
Two servers were pointed at the same data. Stop the other one, or give this one its
own folder. With Docker this means two folders share one project: see "A second
band".

**"Cannot start: This data was written by a newer Bandstand"**
You started an older version on data that a newer version has changed. See "Going
back after a bad update".

**"Cannot start: The database could not be upgraded"**
An update failed halfway and was undone. Your data is as it was. Go back to the
version you had (see "Going back after a bad update", step 1 is enough) and report
the message.

**`docker compose ps` says `unhealthy`**
Look at the log. If it says the director key is missing or damaged, nobody can sign
in until the key is restored from a backup.

**The tablet cannot find the server**
Check that the tablet is on the same Wi-Fi. Check that the computer's address has
not changed (Step 4). Check that the computer is awake: switch off sleep in its
power settings. Check the firewall on the computer: it must allow incoming
connections on port 7800. On Windows, allow Docker Desktop when Windows asks. On
Linux with `ufw`: `sudo ufw allow 7800/tcp`.

**I typed the address and see `{"detail":"Not Found"}`**
The address needs `/app/` at the end. Newer versions take you there by themselves.

**"port is already allocated"**
Another program is using port 7800. Set `BANDSTAND_PORT=7801` in `.env` and type
`docker compose up -d`. Your address then ends in `:7801`.

**I updated the chart editor and the old one is still there**
Build everything from the start, then start again:

```
docker compose build --no-cache
docker compose up -d
```

**After an update, a chart added on one device no longer appears on the others by
itself**
The way the app listens for changes was made safer in this version. A server that
already had data keeps the old way working on its own, so this only happens when
`BANDSTAND_EVENTS_KEY_IN_URL=0` is in your `.env`: a tablet that still shows the old
app then cannot listen the old way. Close the app on that tablet and open it again:
it loads the new version and listening works again. Tapping Sync also works in the
meantime. If you cannot reach every device right away, take the `=0` line out of
`.env` (or set it to `1`) and type `docker compose up -d`. That keeps the old way
working for this version only, so put `=0` back once every device has been opened.

**The app says share pages are not set up**
That is the app telling you that share links need the section "Share links" first.

**I lost the director key**
If the server still runs, read the key again with the command in Step 5. It does
not change by itself.

**I think somebody else has the director key**
Make a new one. Every device will have to sign in again. Member keys keep working.

```
docker compose stop
docker compose run --rm --no-deps --entrypoint rm bandstand /data/.key
docker compose up -d
```

Then read the new key as in Step 5.

## Stop and remove

Stop the server and keep your data:

```
docker compose down
```

Stop the server and **delete all your data for good**:

```
docker compose down --volumes
```

There is no undo for the second one. Make a backup first.

If you started anything by hand with `docker run` that uses the same data, stop and
remove it first. Docker will not delete data that something is still using, and
says "Resource is still in use".

## Moving an existing library into Docker

If you already run Bandstand without Docker and want to move that library into the
container, treat your current data folder as the backup: copy it to a folder named
`bandstand-backup` inside the Bandstand folder and follow "Restore a backup", "On a
new computer".

Two things change on the way:

- The director key becomes readable by the server's own user only. A helper
  program that reads the key as a different user has to run as the same user, or
  read the key through `docker compose exec`.
- A setting that is present but blank counts as not set. The one exception is
  `BANDSTAND_DATA_DIR`: blank is refused.

## Without Docker

Bandstand is a Python program with a web app in front. If you would rather run it
directly, you need Python 3.12 and Node 22.

Choose the data folder yourself and say so with `BANDSTAND_DATA_DIR`. One data
folder belongs to one server: if a Bandstand server already runs on this computer,
this one needs a folder of its own, and it refuses to start on a folder that is in
use.

On a Mac or on Linux:

```
cd client
npm ci
npm run build
cd ../charts
npm ci
npm run build:bandstand
cd ../server
python3.12 -m venv .venv
.venv/bin/pip install --require-hashes -r requirements.lock
cd ..
export BANDSTAND_DATA_DIR="$HOME/my-band"
export BANDSTAND_HOST=0.0.0.0
server/.venv/bin/python -m server.serve
```

On Windows, in PowerShell:

```
cd client
npm ci
npm run build
cd ..\charts
npm ci
npm run build:bandstand
cd ..\server
py -3.12 -m venv .venv
.venv\Scripts\pip install --require-hashes -r requirements.lock
cd ..
$env:BANDSTAND_DATA_DIR = "$HOME\my-band"
$env:BANDSTAND_HOST = "0.0.0.0"
server\.venv\Scripts\python -m server.serve
```

The Windows commands are written from the Mac and Linux ones and have not been run
on a Windows computer for this guide.

If you leave `BANDSTAND_DATA_DIR` out, the data folder is `Bandstand` in your home
folder. The server prints the folder it uses as its second line.

To read the key: open the file `.key` in the data folder with a text editor.

Member commands work the same way, without the `docker compose exec bandstand`
part, and they say which data folder they are working on:

```
server/.venv/bin/python -m server.members --data-dir "$HOME/my-band" list
```

## Licence

Bandstand is free software under the GNU Affero General Public License, version 3
or later. The full text is in the file `LICENSE`.

What that means for you:

- You may run Bandstand for your own band, for as many bands as you like, for free.
- You may change it. If you run a changed version that other people use over the
  network, for example your band members, you must offer them the source code of
  your changed version.
- The Bones and Bonito characters are not covered by that licence. You may keep
  them in a copy that is still called Bandstand. See `NOTICE` and `TRADEMARKS.md`.

Bandstand comes with no warranty. Keep your own backups (see "Back up the data
folder").
