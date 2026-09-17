# The Brain — AI research & knowledge mapping

A local-first, source-aware research application that turns a web research request into an inspectable knowledge graph.

> **Research → analyse → organise → connect → explain**

The application deliberately does **not** seed a demo graph, fabricate search results, or fake AI answers. It begins as an empty Brain. Direct Google discovery can run without Gemini; a Gemini API key is needed only for AI analysis, grounded research synthesis and file analysis.

## Run it

1. Install Node.js 20+.
2. Install dependencies:

   ```bash
   npm install
   ```

3. Configure Gemini server-side:

   ```bash
   cp .env.example .env
   # edit .env and set GEMINI_API_KEY
   ```

   Create an API key in Google AI Studio. `GEMINI_MODEL` defaults to `gemini-3.6-flash`, the current production model recommended by Gemini when the former 2.5 model is retired. The model is isolated in the provider layer for future upgrades.

4. Start the local application:

   ```bash
   npm start
   ```

5. Open `http://localhost:4173`.

`npm run dev` uses Node’s watcher while developing.

## What works now

### Knowledge map

- Create, edit, delete, manually connect and drag nodes.
- Semantic connections: related to, caused, influenced, supports, contradicts, evidence for / against, part of, and more.
- Clear visual node types: ideas, concepts, people, events, questions, evidence, tasks, sources and multimodal files.
- Independent **priority** and **confidence** values.
- A project picker and new-project flow.
- A local knowledge search over nodes, saved source extracts and assistant conversation.

### Free direct source discovery

- **Search web** searches real public-source indexes directly; it does not call Gemini and needs no customer account or API key. The built-in sources are Wikipedia (articles), Wikimedia Commons (images), OpenAlex and Crossref (academic papers), arXiv and Internet Archive (documents).
- The source type controls make focused requests to the relevant public index. The initial requests run in parallel and retain the provider name, original URL, author/date where supplied, snippet and thumbnail where available.
- **Save to Brain** collects the selected original URL locally. A collection timeout, blocked page or non-HTML source is kept transparent instead of fabricated. **Save URL** supports a real public website, image or document not in the free indexes.
- This is a free source-discovery layer, not an unrestricted general-web search engine. A commercial, full-web SERP provider could be added behind the same provider abstraction later if the product owner chooses to fund it.

### Gemini research pipeline

`POST /api/projects/:projectId/research` is a real research pipeline:

```text
User request / selected node context
  → context engine (selected node + direct graph neighbourhood + recent research)
  → Gemini research planner
  → Gemini Google Search grounding
  → grounded web result URLs
  → server-side public-page collection / metadata extraction
  → Gemini source-aware analysis
  → proposed nodes, relationships, claims, conflicts and research gaps
  → explicit user review
  → accepted knowledge graph + evidence chain
```

- Gemini is behind `lib/geminiProvider.js`; the rest of the app is not hard-wired to the model request implementation.
- Google Search grounding is enabled only for web-research calls. The server persists only URLs Gemini returned in its grounding metadata, then attempts to collect public HTML from those original pages.
- The collector stores title, website, author/date where discoverable, retrieved date, type, a transparent heuristic reliability signal, short extract, and collection status. A blocked or non-HTML source is shown as such rather than silently replaced.
- **Recheck** in the Sources view revisits an original page and retains an immutable SQLite snapshot when its collected extract changes, returning a visible `SOURCE UPDATED` result rather than silently overwriting the prior research trail.
- Research results are staged for review. The user can accept all or only selected proposed nodes.
- Accepted claims create a visual evidence layer: **source node → evidence node → research-root conclusion**, with support/against relationships and source cards in the inspector.
- Conflicts and gaps returned by Gemini are retained visibly; gaps become items in the research queue.

### Assistant and multimodal files

- **Ask Brain** uses the selected local graph context, rather than sending the whole database every time. Questions that explicitly request sources/evidence/search may use Gemini Search grounding.
- Upload image, document, text, audio or video material. It remains local until the user presses **Analyze with Gemini**. The analysis is real multimodal Gemini analysis, and can be saved as an evidence node connected to the uploaded-file node.
- Inline file analysis has an intentional 18 MB limit. A larger-media adapter can be added using Gemini Files API without changing the graph layer.

### Research trail

SQLite stores projects, nodes, connections, sources, evidence associations, research sessions, grounding search queries, assistant conversations, files, research queue, tags, timeline-event storage, collections and settings storage. The **Research trail** view displays successful and failed sessions as an auditable record.

## Architecture

```text
public/                 Browser UI: interactive canvas, inspector, command bar
server.js               Express API, validation, workflow orchestration
lib/geminiProvider.js   Dedicated Gemini service abstraction
lib/sourceCollector.js  Server-side page collector and transparent source classifier
lib/db.js               SQLite schema and data hydration helpers
data/brain.db           Created at runtime; local workspace data (ignored by git)
uploads/                Created at runtime; local uploaded material (ignored by git)
```

The frontend never sees the Gemini key. It talks only to same-origin `/api` routes. The key belongs in `.env`, which is ignored by git.

## Privacy model

The UI’s **Privacy & data** page describes this directly:

- Sent to public source indexes for direct discovery: the search query you enter in **Search web**. Gemini is not involved.
- Sent to Gemini: an AI-analysis request, a relevant local subgraph chosen by the context engine, and a file only after the user explicitly asks to analyse it.
- Not automatically sent: the entire database, unrelated uploaded files, or the Gemini API key.
- Stored locally: the graph, research history, collected-source records, conversations and uploaded files in this app’s workspace.

This is a local prototype application, not a multi-user hosted service. Before deploying it, add authentication, per-user encryption/key management, CSRF protection, request quotas, upload malware scanning, a robust web-fetch egress policy (including SSRF protection), consent/audit controls, retention policies, and an authenticated object store.

## Extending it

Useful next production steps:

1. Replace the simple local `LIKE` search with SQLite FTS and a vector-store adapter.
2. Add Gemini Files API for large video/audio/PDF handling and resumable upload.
3. Add a source revalidation worker with a content hash/diff table and a **Source updated** alert view.
4. Add an extraction worker with readability parsing, robots/terms policy and source-specific parsers.
5. Add source-quality review controls and user overrides instead of relying only on the displayed heuristic signal.
6. Add a structured JSON schema / retry path tailored to the configured Gemini model.
7. Add multi-user auth, encrypted database/file storage and a secure secret manager for deployment.

## Important limitations

- Built-in source discovery uses free public indexes and bounded live-web discovery; Gemini is optional for direct discovery but required for AI analysis, source synthesis and multimodal file analysis.
- External sites can block collection, require JavaScript, or return non-HTML content. Their grounded URL remains available, and the collection status reports the limitation.
- Gemini findings are proposals, not verified truth. Review the source cards, evidence chain, conflicts and confidence labels before accepting or relying on conclusions.
