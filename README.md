# 3RTC signaling server

The signaling server of [3RTC](https://3rtc.me), a peer-to-peer watch party: up to four people watch, talk, share screens and play
together, with video, voice, chat and files going directly between them (WebRTC). This server only introduces them: it
keeps rooms in memory, passes offers, answers and ICE candidates between peers, and signs the tokens that let someone
take their seat back after a dropped connection. **No video, voice, chat or files pass through it**, and it stores nothing
about anyone.

This repository's **Releases** also hold the 3RTC desktop app for Windows (the app updates itself from them).

## What it does
- Rooms with 5-digit codes, created and joined over one WebSocket; at most `MAX_ROOM_USERS` (4) people each.
- Seat tokens (`HMAC-SHA256`) so a peer whose network drops gets the same seat back; host tokens with generations, so a
  host that handed over can't take it back.
- Hangout Circles: permanent room codes with an optional PIN (stored only as a hash), and stateless circle tokens.
- Two servers can share one signing secret, so clients fail over between them without losing their seats.
- Limits against abuse: room-code guessing bans an address, frames are capped at 16 KB, bursts are throttled.
- `GET /api/link-preview?url=…`: a page's title and image for chat links, fetched only from public addresses on ports 80
  and 443 (every address and redirect is checked against private, loopback, link-local and cloud metadata ranges).
- Optional: YouTube "quick picks" (popular videos), with a YouTube Data API key.
- WebSocket `Origin` checks against cross-site use.

## Run it
Node.js 20 or newer.

```sh
npm ci
node server.js          # ws://localhost:8080
npm test                # node --test
npm run typecheck
```

| Variable | Default | |
|---|---|---|
| `PORT`, `HOST` | `8080`, all | where it listens |
| `SIGNAL_SECRET` | a file `.signal-secret` next to the server, made on first start | the signing secret; the same on every server of one deployment |
| `NODE_ENV=production`, `APP_URL` | `https://3rtc.me` | production: which web origin may connect |
| `MAX_ROOM_USERS` | 4 | |
| `SIGNAL_CIRCLES_FILE` | `.reserved-circles.json` next to the secret | where reserved circles are kept |
| `RATE_LIMIT_CREATE_ROOMS`, `RATE_LIMIT_JOINS_PER_SEC`, `RATE_LIMIT_INVALID_JOINS`, `LINK_PREVIEW_PER_MINUTE` | see the code | limits |
| `YOUTUBE_API_KEY`, `QUICK_PICKS_REGIONS`, `QUICK_PICKS_DAILY_UNITS`, `QUICK_PICKS_REFRESH_MINUTES` | off | quick picks |

Never commit `.signal-secret`, `.reserved-circles.json` or an API key (`.gitignore` keeps them out).

## Deploying
`deploy_oracle.py` and `deploy_gcp.py` set up a free-tier VM on Oracle Cloud or Google Cloud: Node behind Caddy (automatic
TLS, ports 443 and 8443), a systemd service under its own user (`webrtc-signaling.service`), a swap file and the firewall.
They use your own cloud CLI sign-in and SSH keys, and the domain names in them are 3RTC's: change them for your own.

## About this repository
It is exported from 3RTC's main (private) repository, which also holds the web and desktop apps; changes are made there and
copied here. Issues are welcome.

## Licence
MIT, see `LICENSE`.
