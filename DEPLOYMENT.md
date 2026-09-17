# Deploy The Brain

The Brain is a Node.js 20+ Express application. The browser app and all `/api` routes are served by one process, so no browser-facing code needs a `localhost` backend URL.

## Run locally

```bash
npm ci
cp .env.example .env       # optional: set GEMINI_API_KEY for AI features
PORT=4173 npm start
```

Open `http://localhost:4173`.

Direct public-source discovery works without Gemini. Gemini is used only for optional AI analysis, source-bounded synthesis, document creation, and file analysis.

## Deploy to a hosted Node platform

| Setting | Value |
| --- | --- |
| Runtime | Node.js 20 or later |
| Install command | `npm ci` |
| Start command | `npm start` |
| Port | Supplied by the platform as `PORT` |
| Bind address | `0.0.0.0` (already configured in `server.js`) |

Set these environment variables in the platform’s secret/environment settings, never in client code or Git:

```text
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-3.6-flash
```

`GEMINI_API_KEY` is optional if you only need public-source discovery and the knowledge map.

## Persistent files

The app writes its local state to:

- `data/brain.db` — SQLite projects, sources, map nodes, claims, and research trail.
- `uploads/` — files attached to the map.

For a persistent deployment, mount `data/` and `uploads/` on a persistent volume. Ephemeral/serverless filesystems will reset the Brain’s saved map after redeployments.

## GitHub preparation

The `.gitignore` intentionally excludes `.env`, database files, uploaded files, and `node_modules`. Commit `.env.example` only.

```bash
git init
git add package.json package-lock.json server.js lib public README.md DEPLOYMENT.md .env.example .gitignore
git commit -m "Initial The Brain application"
git branch -M main
git remote add origin https://github.com/YOUR-ACCOUNT/YOUR-REPOSITORY.git
git push -u origin main
```

Before publicly deploying, add authentication, secret management, rate limits, CSRF protection, upload malware scanning, backups, and a proper security review.
