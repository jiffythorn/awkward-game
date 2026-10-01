# The Awkward Game 🎲

v1.0

An adult party game about surviving awkward scenarios while your friends judge you.
Single-player vs AI bots, or multiplayer with a 6-letter room code.

---

## TL;DR — Can I play?

| You want… | What to do |
|---|---|
| **One download, zero setup** | Grab the latest file from [GitHub Releases](../../releases) — AppImage (Linux) or Windows zip. No PHP install needed. |
| **Play solo vs AI, no install** | Double-click `index.html`. Works in any browser, no server, no PHP. |
| **Multiplayer on your Wi-Fi** | Run one command (below), share the URL + room code. |
| **Multiplayer over the internet** | Host it on any PHP-capable host (see [Hosting](#-hosting-multiplayer-over-the-internet)). |

**Invite codes:** the 6-letter room code (like `XSEJFR`) is created *per server*, not globally — it's valid for anyone who can reach **your** server's URL. A code made on your PC won't work on someone else's server, and vice versa. Same URL + same code = same room.

---

## 📦 AppImage (Linux, one-file download)

Linux users can grab a single ready-to-run file instead of installing PHP:

1. **Build it** (once, on any Linux machine): `./packaging/build-appimage.sh` →
   `dist/The-Awkward-Game-1.0-x86_64.AppImage` (~8 MB).
2. **Run it**: make it executable (`chmod +x`), double-click, or run it from a terminal.
   It starts the server, prints the URLs, and opens the game in your browser.

```sh
chmod +x The-Awkward-Game-1.0-x86_64.AppImage
./The-Awkward-Game-1.0-x86_64.AppImage              # opens in your browser
AWKWARD_PORT=3000 ./The-Awkward-Game-1.0-x86_64.AppImage
AWKWARD_NO_BROWSER=1 ./The-Awkward-Game-1.0-x86_64.AppImage   # don't auto-open
```

- **What's inside:** the whole game + a bundled static PHP 8.3 — **no PHP install, no
  system dependencies** beyond x86_64 glibc (any distro from ~2019).
- **Writability:** AppImages mount read-only, so rooms, AI config, and rate-limit files
  live under `~/.local/share/awkward-game/` instead of `rooms/` (the backend picks this
  up automatically via `AWKWARD_DATA_DIR`; the normal server launchers are unchanged).
- **FUSE-less systems:** if it won't start (no `/dev/fuse`), run with `--appimage-extract`
  and execute the extracted `AppRun` — same game, same behavior.
- **Where it can host from:** same as `start-server.sh` — localhost, LAN, or behind a
  tunnel/cloud host (see [Hosting](#-hosting-multiplayer-over-the-internet)).
- Guests still need nothing but a browser.

### 🪟 Windows one-file zip

Same idea for Windows: download `The-Awkward-Game-<ver>-windows-x64.zip` from
[Releases](../../releases), **Extract All**, and double-click
**`Start Awkward Game.bat`**. The official php.net runtime is bundled in `php/` —
no PHP install, no admin rights. Rooms and AI settings go to
`%LOCALAPPDATA%\awkward-game\`. SmartScreen may ask about the downloaded
launcher: *More info → Run anyway*. Build it yourself with
`./packaging/build-windows-zip.sh`.

---

## ⚙️ Requirements

- **Single-player (vs AI):** any modern browser. That's it.
- **Multiplayer (host):** PHP **7.4+** (8.x recommended) on the machine that hosts.
- **Multiplayer (guests):** just a browser. No install, nothing to download.

PHP is the only dependency — there are no Composer packages, no Node build, no database. Rooms are stored as JSON files under `rooms/data/`.

### Install PHP

| OS | Command / link |
|---|---|
| Windows | `winget install PHP.PHP.8.4` (or [XAMPP](https://www.apachefriends.org)) |
| Ubuntu / Debian | `sudo apt install php-cli` |
| Fedora | `sudo dnf install php-cli` |
| Arch | `sudo pacman -S php` |
| macOS | `brew install php` |

---

## 🚀 Starting the server

**Windows:** double-click `start-server.bat`

**Linux / macOS:**
```sh
./start-server.sh
```

Different port:
```sh
AWKWARD_PORT=3000 ./start-server.sh       # Linux/macOS
set AWKWARD_PORT=3000 && start-server.bat # Windows
```

The launcher prints something like:

```
  Play here:        http://localhost:8080
  Friends on Wi-Fi: http://192.168.1.225:8080
```

1. You open **http://localhost:8080** → *Create room* → get your code.
2. Friends on the same Wi-Fi open the **Friends URL** → enter the code → play.
3. Stop the server with `Ctrl+C`.

> 💡 If a friend can't connect: they need the **LAN IP** URL (not localhost), and your OS firewall may ask permission to allow PHP — accept it. If you still can't connect, see the firewall notes below.

---

## 🌍 Hosting multiplayer over the internet

The code only travels as far as your server's reach. Three ways to widen it:

### Option A — Free PHP host (easiest, always-on)

1. Get any PHP web host (many free/cheap ones exist; it needs PHP 7.4+ and write access).
2. Upload the whole folder (all `.php` files, `index.html`, `style.css`, `game.js`, `data/`).
3. Make sure `rooms/data/` exists and is **writable** (this is where room JSON files live).
4. Share `https://your-site.example/` — the code works for anyone, anywhere.

### Option B — Cloud VM (DigitalOcean, Hetzner, AWS, …)

```sh
# On a fresh Ubuntu VM:
sudo apt update && sudo apt install -y php-cli
# copy this project to /var/www/awkward (scp, git clone, …), then:
cd /var/www/awkward
nohup php -S 0.0.0.0:80 -t . >server.log 2>&1 &
```

Point a domain at it (optional), open port 80/443 in the VM firewall, and share the URL. For real deployments prefer nginx + `php-fpm` over the dev server.

### Option C — Tunnel from your own PC (no cloud account)

Tools like **Cloudflare Tunnel**, **ngrok**, or **Tailscale Funnel** expose your `php -S` server to the internet:

```sh
php -S 0.0.0.0:8080            # terminal 1 (or start-server.sh)
cloudflared tunnel --url http://localhost:8080   # terminal 2
```

You get a public URL — share it, and room codes work for anyone on the internet.

### Firewall notes

- **Linux:** `sudo ufw allow 8080/tcp`
- **Windows:** allow PHP when the firewall prompt appears (first launch), or add an inbound rule for your chosen port.
- **macOS:** System Settings → Network → Firewall → allow `php`.

### A note on "peer-to-peer"

There is **no P2P mode** — multiplayer always flows through one server (that's also what makes anti-cheat possible: the deck order lives server-side only). The cheapest "peer" is one player's PC running `start-server` while everyone else opens the URL.

---

## 🎮 How to play

- Roll the die, move around the 54-tile loop, land on a tile, face the card.
- **Awkward Points** (AP) are good — **Shame Points** (SP) are bad.
- Tile types: Scenario, Choice, Risk, Sabotage, Group Vote, Safe, Chaos, Double Trouble, Final Combo.
- Most AP after 3 laps wins; SP breaks ties against you. Full rules: open `rules.html` or read `RULES.md`.

### Multiplayer flow

- **Create room** → you become `p0` and 3 AI bots fill the seats.
- Friends **Join** with the code (up to 8 players: 5 humans + 3 bots in the default setup).
- Game start, rolls, cards, and votes are all validated server-side — clients can't peek at the deck.
- **Watchable bot turns:** bots act on a visible timer (default 2.5s per step — roll, "thinking…", answer reveal) so everyone sees what each bot was asked and what it did, just like a human turn. Speed is tunable via the `AWKWARD_AI_STEP` env var (`0` = instant, for tests).
- Guests can reconnect any time during a game: Join with the code + their same name.

---

## 🤖 AI opponents

Personalities: **Chill, Chaotic, Brutal, Honest, Liar** — each with different bluff/risk/sabotage/vote tendencies plus a small chaos factor. The same AI runs in single-player (client-side) and in multiplayer rooms (server-side, deterministic per-room RNG).

### Making the bots talk (three tiers)

Bots speak in the chat box on every event they cause or react to: doing/bluffing scenarios, choices, risks, sabotage, votes, laps, wins, and greetings. Three tiers, tried in order:

| Tier | Cost | Needs | What you get |
|---|---|---|---|
| 1. **AI providers** (chain) | free tiers or paid | API key(s), or a local AI server | unique, in-character lines per bot |
| 2. **Local AI** on the host | free, your CPU | Ollama / llama.cpp / LM Studio | same as above, fully offline |
| 3. **Line pack** (built-in) | free, nothing | nothing — always works | 250+ hand-written personality one-liners |

Tier 3 is the default: bots are chatty out of the box with zero setup. Tiers 1–2 upgrade the same events to LLM-generated banter and automatically fall back to tier 3 whenever every provider fails (rate limit, no key, server down).

### The provider chain (failover)

Providers are tried **in order** until one answers. A provider that fails is benched temporarily (2 min for fast connect-failures, 30 s for HTTP 429/5xx — so a exhausted free tier doesn't get hammered), then the next one is tried, and so on down to the line pack:

```
keyed clouds (catalog order) → your custom providers → local servers (Ollama, llama.cpp, LM Studio) → line pack
```

### Admin area — `admin.html`

Open **http://your-server/admin.html** (host machine only by default) to configure everything:

- **Provider cards** for every known cloud + local option: paste a key, save, hit **Test**.
- **Live model fetch**: the ⟳ button pulls the provider's current model list into a **searchable dropdown** — model IDs change constantly, so never guess them. If listing fails, just type the model ID in the free-text box.
- **Custom providers**: add any OpenAI-compatible endpoint (another PC on your LAN, a proxy, anything).
- **Chain order & on/off**: disable providers, re-order failover, turn bot AI off entirely.
- **Bot pacing**: how long each bot "thinks" and how long its answer stays on the card before the game advances (default 2.5s; solo play follows the same setting). Set it in the admin area: the slider goes to 120s, and the text box accepts anything up to **600s** for slower tables — rooms and solo play both honor it.
- **Test whole chain**: probes every configured provider with one ping.

Keys are stored server-side in `rooms/config.php` (auto-managed, never committed, never sent to browsers). Set an `adminKey` in that file to protect the admin API from other machines; without it, admin works from localhost only.

### Built-in provider catalog

The catalog lives in `data/ai-providers.php` — the single place every provider is listed with URL, default model, key env var, and docs link. Highlights:

| Provider | Key env var | Free tier | Notes |
|---|---|---|---|
| Groq | `GROQ_API_KEY` | yes (rate-limited) | very fast small models |
| Google Gemini | `GEMINI_API_KEY` | yes (rate-limited) | generous free tier |
| Mistral | `MISTRAL_API_KEY` | yes (rate-limited) | |
| Cerebras | `CEREBRAS_API_KEY` | yes (generous) | |
| OpenRouter | `OPENROUTER_API_KEY` | several `:free` models | gateway to many vendors |
| OpenAI | `OPENAI_API_KEY` | no (prepaid) | |
| Together AI | `TOGETHER_API_KEY` | trial credit | |
| Ollama (local) | — | your machine | `ollama pull qwen2.5:0.5b` — 0.5B models run on weak PCs |
| llama.cpp server (local) | — | your machine | |
| LM Studio (local) | — | your machine | GUI app |

Keys can come from environment variables (the `keyEnv` above) or be saved via admin.html. **Weak host PC?** Skip local AI on the host: the chain skips an offline local server in under a second and bots still talk via clouds or the line pack. **Strong PC?** Install Ollama, pull a 7B+ model, add it in admin.html — done.

### How much AI is enough?

The line pack alone carries the game's humor for solo play. One free cloud key (Groq or Gemini) makes multiplayer bots feel genuinely table-talkative. Local models are for the no-internet LAN party — even a tiny 0.5B model writes passable trash talk at 15 words per line.

---

## 🗂 Project layout

```
index.html, rules.html   UI (single-player + multiplayer client)
style.css                5 themes, responsive layout, animations
game.js                  single-player engine, AI, save/load, MP client
data/board.js            54-tile loop
data/cards.js            180 cards (also exported to data/cards.json for PHP)
rooms/                   PHP multiplayer backend (lib.php + 8 endpoints)
rooms/data/              live room JSON files (writable, git-ignorable)
tests/                   engine tests + end-to-end API smoke test
start-server.sh / .bat   one-command launchers
packaging/               desktop packaging: AppImage + Windows zip (AppRun, launchers, build scripts)
```

---

## 🧪 Development

```sh
node tests/engine.test.js   # 193 engine assertions
bash tests/run-api.sh       # boots a PHP server, runs 26 API checks
for f in rooms/*.php; do php -l $f; done
```

Single-player games autosave to `localStorage`; multiplayer rooms live in `rooms/data/<CODE>.json` and survive server restarts until deleted.

---

## 🔒 Security notes

The bundled `php -S` dev server is fine for friends; if you put this on a public server, run it behind a real web server (nginx/Apache + php-fpm), keep `rooms/data` non-listable, and consider rate-limiting the room endpoints. Room state is plain JSON with no secrets — players only send names, verdicts, and chat text.
