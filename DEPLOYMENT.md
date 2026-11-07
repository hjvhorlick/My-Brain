# Deploy The Brain

The Brain is a Node.js 20+ Express application that searches public source indexes and reads
the results in its own viewers. There is **no AI provider and no API key**. The browser app
and all `/api` routes are served by one process, so no browser-facing code needs a backend URL.

## Run locally

```bash
npm ci
PORT=4173 npm start
```

If `better-sqlite3` has no prebuilt binary for your platform, build it from the local Node
headers: `npm_config_nodedir=/usr/local npm install`.

Open `http://localhost:4173`.

## Deploy to a hosted Node platform

| Setting | Value |
| --- | --- |
| Runtime | Node.js 20 or later |
| Install command | `npm ci` |
| Start command | `npm start` |
| Port | Supplied by the platform as `PORT` |
| Bind address | `0.0.0.0` (already configured in `server.js`) |

No environment variables are required. There is no key to configure.

The server must be able to reach these public endpoints outbound:

```text
en.wikipedia.org, commons.wikimedia.org, upload.wikimedia.org
en.wiktionary.org / api.dictionaryapi.dev
api.openalex.org, api.crossref.org, export.arxiv.org, archive.org
```

Anything a reader or search fetches is fetched by the server, not the browser, so a network
policy only needs to allow the server.

## Persistent files

The app writes its local state to:

- `data/brain.db` — SQLite projects, sources, map nodes, claims, reader history.
- `uploads/` — files attached to the map.

For a persistent deployment, mount `data/` and `uploads/` on a persistent volume. Ephemeral
filesystems reset the saved map after redeployments.

## GitHub preparation

`.gitignore` excludes `node_modules`, `.env`, database files, uploaded files and build output.

```bash
git add package.json package-lock.json server.js lib public README.md DEPLOYMENT.md .env.example .gitignore
git commit -m "The Brain: search and reader application"
git push
```

Before publicly deploying, add authentication, rate limits, CSRF protection, upload malware
scanning, backups and a proper security review.
