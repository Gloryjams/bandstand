# Get Bandstand

Bandstand is a gig book and sheet music reader with the SaltyCharts chord chart
editor included. Use it in a browser or install the reader's icon on your device.
Your book has a server: it can run on your own computer, or be the private server
your band has given you access to.

## Download for Windows

On the [releases page](https://github.com/Gloryjams/bandstand/releases), look for
`Bandstand-VERSION-windows-x64.zip`. A release's source ZIP is for developers;
the Windows ZIP includes the runtime and the built app.

1. Download the Windows ZIP, right-click it, and choose **Extract All**.
2. Open the extracted **Bandstand** folder, then **Start Bandstand**.
3. Confirm the sign-in in the browser. Try the four original practice charts,
   or choose **New chart** to use the included editor.

No Python, Node, or Docker installation is needed. The download is an unsigned
public beta for 64-bit Windows 10 and 11. An ordinary start runs on that computer
only. **Share Bandstand on Wi-Fi** is a separate option for a trusted private
network; close the ordinary window before opening it.

Your book and daily backups live in `%LOCALAPPDATA%\Bandstand`, outside the app
folder. Updating the app opens the same book. Close Bandstand and back up the
whole data folder before updating. Keep the older app until you have checked
your book with the new version.

If the release has no Windows ZIP yet, the download is still being prepared.
You can build it using [the Windows packaging instructions](../packaging/windows/README.md),
or use the [Docker setup](SELF-HOSTING.md).

## Open or install the web app

Open the address your band gave you, sign in, then install the reader:

| Device | Install |
| --- | --- |
| iPhone or iPad | Open in Safari, tap Share, then Add to Home Screen |
| Android | Open in Chrome, use its Install app or Add to Home Screen option |
| Windows | Open in Edge or Chrome, use Install app in the browser menu |
| Mac | Use a browser that offers installation; the browser tab also works |

Use your band's **HTTPS** address. On the computer running the Windows download,
its **localhost** address works too. On a tablet, a plain Wi-Fi HTTP address
supports connected reading but cannot install the app or save charts offline.

The installed icon is the reader. The server still needs to run when you fetch
charts or sync changes. Before a gig, save your charts offline and test opening
them after disconnecting. See [Before your first gig](SELF-HOSTING.md#before-your-first-gig-charts-without-a-connection).

Each band has a separate book. Keep director sign-in links private; band members
get their own sign-in and cannot change the director's library. A shared public
demo is for trying the app, and is not a place to keep your own band's charts.

## Mac, Linux, or Raspberry Pi server

The same web app runs from the [Docker setup](SELF-HOSTING.md). That is the current
server package for Mac, Linux, Raspberry Pi, and Windows. The Windows ZIP is a
second way to run the server, with no Docker installation.
