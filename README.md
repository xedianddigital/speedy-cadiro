# SpeedyCadiro

![Portal](portal.png)

The shortest path from a Path of Exile trade listing to standing in the seller's
hideout to buy it.

Point it at one or more live trade searches. The moment a matching listing
appears, SpeedyCadiro travels you to the seller automatically, shows you what
you're buying, and pauses so you can complete the trade without being pulled
away. Then it waits for the next one.

Everything runs on your machine. Your session stays local and is sent nowhere
except pathofexile.com.

---

## Install (Windows)

1. Download **`SpeedyCadiro-Setup-x.y.z.exe`** from the
   [latest release](../../releases/latest).
2. Run it. It installs for your user and launches itself — no admin rights, no
   setup wizard, nothing else to install.

### "Windows protected your PC"

You'll see a blue **SmartScreen** notice the first time. Click **More info →
Run anyway**.

This is normal for software from an independent developer — it just means the
app isn't signed with a paid certificate, not that anything is wrong with it.
Big companies pay for code-signing certificates that Windows recognises; a small
free project doesn't. The whole thing is open source and built in public here on
GitHub if you'd like to see exactly what it does.

---

## Using it

1. **Sign in** — click *Sign in to pathofexile.com* and log in as usual. The
   window closes itself once you're in, and stays signed in across restarts.
2. **Add a search** — on the trade site, build a search with a **Buyout** price
   filter, copy its URL, and paste it in. Add it, and it starts watching.
3. **Wait** — when a listing matches, you're travelled to the seller, the
   purchase window opens, and you buy manually in game.

You can watch up to **5 searches** at once. They all feed one travel: whichever
matches first sends you, and every search pauses during the purchase window so a
second match can't yank you elsewhere mid-trade.

### Settings

- **Travel interval** (10–90s) — how long every search pauses after a travel, so
  you have time to finish buying. Also how long the current listing stays on
  screen.
- **File → Options** — pick a notification sound (or turn it off).

Only **instant-buyout** listings are used — the ones that offer a direct
Travel-to-Hideout. Negotiable-price listings are skipped.

---

## A note on fair use

SpeedyCadiro travels and whispers on your account automatically. GGG tolerates
live-search notifiers, but automated whispering sits in a grey area of their
terms. It is deliberately conservative — one connection per search, it obeys the
rate limits pathofexile.com publishes, and it never hammers reconnects — but
use it sensibly and don't leave it running unattended.

---

## How it works

A small Next.js server runs inside an Electron desktop shell. For each watched
search it holds one WebSocket to pathofexile.com's live-search endpoint. When
the server pushes a new listing it is fetched, and if it's an instant buyout the
app whispers the seller — the same Travel-to-Hideout request the trade site's
own button sends — then pauses every search for the travel interval. The UI is
driven over Server-Sent Events, so it updates the instant something happens.

Session cookies and settings live in `%APPDATA%\speedy-cadiro\` (Windows) or
`~/.config/speedy-cadiro/` (Linux) and are never committed or transmitted
anywhere but pathofexile.com.
