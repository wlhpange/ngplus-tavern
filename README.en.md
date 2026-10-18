[中文](./README.md) | English

# NG+ Guild (二周目协会)

A one-person guild. You talk to an AI guild master, turn the things you've always wanted to do into quests, and earn XP and gold when you finish them — level up, rank up, keep your streak alive. You can also switch to the tavern and just hang out in character.

Single-user, mobile-first, runs locally. Stack: Next.js 14 · React 18 · SQLite (drizzle + better-sqlite3) · any OpenAI-compatible model.

## License & content

- Non-commercial license: [PolyForm Noncommercial 1.0.0](./LICENSE). Use, modify and share freely, **no commercial use**.
- Includes an R18 toggle, off by default, **18+**.
- Single-user, no auth: **do not expose it to the internet**.
- Pixel assets under `public/sprites/lpc/` keep their own licenses; see [docs/CREDITS-lpc.md](./docs/CREDITS-lpc.md).

## Requirements

- Node.js **22+**
- pnpm (`npm i -g pnpm`) or npm
- An OpenAI-compatible API (DeepSeek / OpenCode Go / your own server)
- Optional image generation: local mflux (Apple Silicon), or a custom OpenAI-compatible image endpoint

## Install & run

```bash
git clone https://github.com/wlhpange/ngplus-tavern.git
cd ngplus-tavern
pnpm install
cp .env.example .env.local
pnpm db:migrate
pnpm dev
```

Open `http://localhost:3000`. To stop: press **Control + C** in that terminal.

On macOS you can also double-click `start-mac.command`; on Windows, `start.bat`. Both run in the foreground.

## Set up a model first

Go to Settings → Model & channel:

- **Custom API**: enter your OpenAI-compatible base URL, model name and key (key can be empty for local servers).
- **DeepSeek / OpenCode Go**: put the key in `.env.local` (see `.env.example`).
- Click "Test connection".

Image generation lives in Settings → Images: choose "local mflux" or "Custom API". **No port needed** — mflux is a local command.

## How to play

**First time**: push the door → pick a master (the fifth door lets the AI forge one from your description) → tell them one thing you've wanted to do → accept the first quest.

**Quest mode**: report progress, get judged, earn XP/gold/attributes. Level-ups, rank-ups and streaks happen here.

**Tavern mode**: pure role-play, no numbers. Multiple independent sessions, each with its own greeting and memory.

**Other pages**: quest board, character panel, shop (rest scrolls + gifts; affinity is per master), skill tree, world book, memory book (auto-remembered facts, editable), adventurer card (your own persona).

The **R18 toggle** is hidden by default: tap the settings title area 5 times to reveal it.

## Image generation (optional)

When enabled, each master message gets an "illustrate this scene" button. Turn it off and the button disappears. Use local mflux (Apple Silicon, slow on first load) or a custom OpenAI-compatible endpoint (`{base}/images/generations`). Image and text models share GPU memory — don't run both hard at once.

## Data & backup

Everything lives in `data/`: `ngplus.db` (database), `avatars/`, `scenes/`, `backgrounds/` (images). Copy the folder to back up; delete it to start fresh.

## FAQ

- **The master won't talk**: model/key not configured. Check Settings → Model & channel → Test connection.
- **Test times out / out of memory**: the local model may still be loading, or competing with image generation. Wait, or lower context/resolution.
- **Image generation seems stuck**: mflux is slow on first load; wait a minute or two, or hit Stop.
- **Can't find the R18 toggle**: tap the settings title area 5 times.
- **Moving machines**: `pnpm install && pnpm db:migrate`, and bring `data/` along.

## Development

```bash
pnpm test              # unit tests (LLMs are mocked, no real key needed)
pnpm exec tsc --noEmit # type check
pnpm build             # production build (don't run builds in parallel)
```
