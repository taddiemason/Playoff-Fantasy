# Playoff Fantasy

## Deploying to Cloudflare (Workers + D1)

This project is now set up to run on Cloudflare using:
- **Cloudflare Workers** for API routes and app hosting
- **D1** for persistent database storage
- **Workers Assets** for serving the built Vite app

### 1) Install dependencies

```bash
npm install
```

> Root `postinstall` also installs `client` dependencies automatically, which matches Cloudflare build behavior.

### 2) Build the frontend

```bash
npm run build
```

### 3) Create a D1 database

```bash
npx wrangler d1 create playoff-fantasy-db
```

Copy the returned `database_id` into `wrangler.toml` under `[[d1_databases]]`.

### 4) Run initial migration

```bash
npx wrangler d1 migrations apply playoff-fantasy-db --local
npx wrangler d1 migrations apply playoff-fantasy-db --remote
```

### 5) Deploy

```bash
npm run deploy:cf
```

### Local Cloudflare dev

```bash
npm run dev:cf
```

This serves the built frontend and all `/api/*` endpoints through the Worker.
