# Playoff Fantasy

A web app for running an **NHL playoff fantasy hockey** pool. Draft rosters of real playoff
players, and the app pulls live stats from the public NHL API to compute fantasy points and
rank your teams in a live standings board that refreshes throughout the postseason.

## Features

- **Teams & rosters** — create teams with a name, owner, and tiebreaker; build a roster of
  up to **10 forwards, 5 defensemen, and 3 goalies**.
- **Roster constraints** — at most **3 forwards from the same NHL team** and **2 defensemen
  from the same NHL team**, enforced server-side when adding players.
- **Player search** — type-ahead search backed by the NHL player search API, with headshots,
  positions, and current NHL team.
- **Live standings** — fantasy points are calculated from real NHL playoff stats and teams are
  ranked automatically, with per-player score breakdowns.
- **Eliminated-team awareness** — players whose NHL team has been knocked out of the playoffs
  are flagged in the standings.
- **Admin password** — creating/editing teams and rosters is gated behind a shared password;
  the public can view standings without it.
- **Resilient to API hiccups** — stat snapshots and a stale-data fallback keep the board
  populated even when the NHL API is temporarily unreachable.

## Scoring

**Skaters**

| Stat | Points |
|------|--------|
| Goal | 2 |
| Assist | 1 |
| Power-play / short-handed goal or assist | +1 each (in addition to the above) |
| Penalty minute | 0.5 |
| Plus/minus | ±1 per |

**Goalies**

| Stat | Points |
|------|--------|
| Win | 2 |
| Shutout | 3 |
| GAA rank | rank-based across all rostered goalies (lower GAA = more points) |
| SV% rank | rank-based across all rostered goalies (higher SV% = more points) |

Goalie GAA and save percentage are scored by **rank** rather than raw value: every goalie in the
pool is ordered, and the best gets the most points down to the worst. Ranking points stay stable
across refreshes even if an individual stat fetch fails.

## Architecture

```
client/      React 18 + Vite single-page app (standings, team pages, modals)
server.js    Express + better-sqlite3 backend (used for the Render deployment)
worker/      Cloudflare Worker backend + D1 (used for the Cloudflare deployment)
migrations/  D1 SQL migrations (schema + incremental changes)
render.yaml  Render deployment config
wrangler.toml  Cloudflare deployment config
```

There are **two interchangeable backends** that expose the same `/api/*` surface:

- **`server.js`** — Node/Express with a local SQLite database (`better-sqlite3`). Simple to run
  locally and deploys to Render with a persistent disk.
- **`worker/index.js`** — Cloudflare Worker backed by D1. Adds an admin-password gate
  (`ADMIN_PASSWORD`), team tiebreakers, and an **hourly cron** that snapshots standings so the
  board stays warm. This is the primary deployment target.

All player and stat data comes from the public NHL API (`api-web.nhle.com`) and player search
(`search.d3.nhle.com`); there is no API key required.

## Local development

Install dependencies for both the root and the client:

```bash
npm install
npm install --prefix client
```

### Option A — Express backend (SQLite)

```bash
npm run dev
```

This runs the Express API (`server.js`, port 3001) and the Vite dev server concurrently. The
database is created automatically at `./data/fantasy.db`.

### Option B — Cloudflare Worker backend (D1)

```bash
npm run build
npx wrangler dev
```

This serves the built frontend and all `/api/*` endpoints through the Worker against a local D1
instance.

## Deploying to Cloudflare (Workers + D1)

The Cloudflare deployment uses:
- **Cloudflare Workers** for the API routes and app hosting
- **D1** for persistent database storage
- **Workers Assets** for serving the built Vite app

### 1) Build the frontend

```bash
npm run build
```

### 2) Create a D1 database

```bash
npx wrangler d1 create playoff-fantasy-db
```

Copy the returned `database_id` into `wrangler.toml` under `[[d1_databases]]`.

### 3) Run migrations

```bash
npx wrangler d1 migrations apply playoff-fantasy-db --local
npx wrangler d1 migrations apply playoff-fantasy-db --remote
```

### 4) Set the admin password

```bash
npx wrangler secret put ADMIN_PASSWORD
```

### 5) Deploy

```bash
npx wrangler deploy
```

An hourly cron trigger (`0 * * * *`, configured in `wrangler.toml`) refreshes standings
automatically.

## Deploying to Render (Express + SQLite)

`render.yaml` defines a Node web service that installs dependencies, builds the client, and runs
`npm start` with a persistent disk for the SQLite database. Connect the repo in Render and it will
pick up the config automatically.

## NPM scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Run the Express API and Vite dev server together |
| `npm run build` | Build the client (Vite) into `client/dist` |
| `npm start` | Start the production Express server |
| `npm run install:all` | Install root + client dependencies |
| `npm run dev:cf` | Build the client and run `wrangler dev` |
| `npm run deploy:cf` | Build the client and `wrangler deploy` |
