# The Brain — search, read, map

A local-first research workspace that searches public source indexes directly and then lets
you **read what those sources actually say inside the application**.

> **Search → read → save → connect → review**

There is **no AI in this application**. Nothing is generated, summarised or rewritten by a
model, there is no API key to buy or store, and no third-party application or embedded
widget is used for search, reading or playback. Every viewer is written in this repository.

## Run it

1. Install Node.js 20+.
2. Install dependencies:

   ```bash
   npm install
   ```

   If a prebuilt SQLite binary is unavailable on your platform, build it from the local
   Node headers: `npm_config_nodedir=/usr/local npm install`.

3. Start the application:

   ```bash
   npm start
   ```

4. Open `http://localhost:4173`.

`npm run dev` uses Node's watcher while developing. The server reads `PORT` (default 4173)
and binds `0.0.0.0`.

## What it does

### Search public indexes — no key, no account

| Type | Public index |
| --- | --- |
| Web / articles | Wikipedia |
| Wikipedia | Wikipedia article index (reader-first) |
| Dictionary | dictionaryapi.dev (Wiktionary-derived) |
| Images | Wikimedia Commons |
| Video | Internet Archive |
| Audio | Internet Archive |
| Papers | OpenAlex, Crossref |
| Documents / books | arXiv, Internet Archive |

Every result keeps its provider, original URL and provider-supplied metadata. A source that
cannot be collected is shown as unavailable — never invented or substituted.

### The search procedure (layered search)

The internet is the knowledge base; the map is the notebook. Nothing is pre-stored, so every
search grows a small, real mind map out of what public indexes actually say.

A search is a **procedure**, not a single query. Type `god` and the engine answers in four
passes, each drawn as map cards:

| Layer | What it shows | Example |
| --- | --- | --- |
| 0 | The main item and what it is | **God** — "a supreme being, worshipped in many traditions" |
| 1 | The aspects of it (max 4) | Names · Attributes · Religion · Church |
| 2 | The members named inside an aspect | *Names* → Yahweh · Allah · Elohim · *Religion* → Christianity · Islam · Judaism |
| 3 | Detail inside a member — **only when you open it** | *Attributes* → its own sub-parts and sources |

"Book" is only one example of a subject; the same procedure works for a person, a concept,
a place or a thing, because the aspects are read from the structure of the main item itself.

**Rules the engine follows**

1. **Relevance is a gate, not a ranking.** An aspect needs a real match on the main item's own
   text before it can enter a layer. Furniture headings ("See also", "References", "Bibliography",
   "Gallery") and index noise are rejected outright; a heading like "Types of books" is expanded
   into the entries it actually names instead of becoming a card itself.
2. **Layers are capped.** At most 4 aspects, and 5 members per aspect. A small correct web beats
   a large vague one.
3. **Members belong to their aspect.** A member has to be named by that aspect — as one of its
   sub-headings, one of its links, or a source that genuinely mentions it. A popular page that
   never names the aspect cannot join it.
4. **The subject is never its own member.** "God" does not appear under "Names", because level 2
   is for the things inside the aspect, not for the thing being searched.
5. **Popularity and freshness only break ties.** Citation counts and archive downloads are
   scaled so they can never outrank a genuine match — they order equally relevant candidates.
6. **A second word narrows the same search.** `god religion` keeps the main item and constrains
   the aspects to that facet; it does not start an unrelated search. A broad second word is
   labelled as such instead of being padded out.
7. **Branching is lazy.** The first search stays fast; the other members of an aspect are fetched
   when you open it (`POST /api/nodes/:id/expand`), and re-opening reuses existing cards.
8. **Failure is distinct from emptiness.** "No index could be reached" and "the indexes answered
   with nothing relevant" produce different messages, and neither writes to the map.

Tune it with `BRAIN_SEARCH_CONFIG`, for example
`BRAIN_SEARCH_CONFIG='{"MAX_TYPES":3,"MAX_MEMBERS_PER_ASPECT":4,"MIN_TYPE_SCORE":5}'`.

### Read it in the app

Nothing opens in a third-party embed. Each format has a viewer built here:

- **Dictionary reader** — headword, phonetics, audio pronunciation, parts of speech, senses,
  examples, synonyms/antonyms, and a Wikipedia cross-reference.
- **Wikipedia reader** — the article's own sections with a section jump bar, images, linked
  articles, and "read the original" as a fallback.
- **Web reader** — the page is fetched server-side and reduced to readable paragraphs and its
  outgoing links. Links open in the reader, not in a new tab.
- **Image viewer** — zoom, brightness, rotation, and PNG/JPG download converted in the browser.
- **Video and audio player** — the server resolves a direct playable file (Internet Archive
  metadata, Wikimedia Commons originals, or a direct media URL) and plays it with the
  browser's own `<video>`/`<audio>` controls. If a source only offers its own player, the app
  says so and shows the poster plus the original link instead of pretending to play it.
- **Document reader** — PDFs from a saved file or URL, and a plain-text reader for text files.
- **Local files** — images, video, audio, PDFs and text saved in the workspace open in the
  same viewers.

### Map the result

- Create, edit, delete, connect and drag nodes; priorities and confidence are yours.
- A search grows a 2D web: topic → keyword → evidence → source, with duplicate source
  quotations merged and a transparent relevance score for every candidate.
- Save any result to the map as a source branch, or save a page straight from the web reader.
- Saved sources reopen in the reader that fits them, and **Recheck** retains an immutable
  snapshot when a page's extract changes.
- Local knowledge search over nodes, sources and saved text (`⌘K`).

### When the internet is unavailable

Everything here is fetched from public indexes, so the server needs outbound internet access.
The app probes its indexes on load (`GET /api/connectivity`) and says so plainly:

- A banner appears when some or all indexes are unreachable, with a **Check again** button.
- A search against a dead network reports **"No source index could be reached"** with the names
  of the indexes that failed — never an empty result list, which would imply the indexes answered.
- The map, saved sources, local files and everything already stored keep working offline.

### Serendipity

The **Serendipity** chip reads Wikipedia's "Today's featured article" page and opens one of the
linked articles at random. The choice comes from a real public page — nothing is invented.

## Architecture

```text
public/                 Browser UI: canvas map, inspector, readers, command bar
  readers.css           Styling for the in-app viewers
server.js               Express API, validation, workflow orchestration
lib/reference.js        Dictionary, Wikipedia, web-page and media readers (server side)
lib/freeSourceSearch.js Public-index search adapters (keyless, no SDK)
lib/sourceCollector.js  Page collector and transparent source classifier
lib/researchEngine.js   Ranking, source quotations, duplicate and gap detection
lib/db.js               SQLite schema and data hydration helpers
data/brain.db           Created at runtime; local workspace data (ignored by git)
uploads/                Created at runtime; local files (ignored by git)
```

### API

| Route | Purpose |
| --- | --- |
| `GET /api/status` | Source indexes in use; confirms no key is needed |
| `GET /api/projects`, `POST /api/projects` | Projects |
| `GET /api/projects/:id/graph` | Nodes, connections, sources, open questions |
| `POST /api/projects/:id/nodes`, `PATCH/DELETE /api/nodes/:id` | Map editing |
| `GET /api/discovery?q=&type=` | Search public indexes |
| `GET /api/typing-suggestions?q=` | Real Wikipedia title suggestions and spelling hints |
| `POST /api/projects/:id/search-engine` | Run the layered search procedure (main item → aspects → members) |
| `POST /api/nodes/:id/expand` | Open an aspect: fetch the other members named inside it |
| `POST /api/projects/:id/neural-grow` | Classic radial source map from a search |
| `POST /api/projects/:id/sources/import` | Save one source (URL, metadata) |
| `POST /api/sources/:id/recheck` | Revisit a page and snapshot changes |
| `GET /api/read/dictionary?q=` | Dictionary entry + Wikipedia cross-reference |
| `GET /api/read/wikipedia?title=` | Article sections, images and links |
| `GET /api/read/page?url=` | Readable page text and links |
| `GET /api/read/playback?url=` | Direct playable media URL where one exists |
| `GET /api/files/:id/view`, `/text` | Inline preview of a saved local file |

## Design rules this codebase keeps

1. **No AI.** No model provider, no key, no generation.
2. **No third-party apps.** Public indexes are used as data sources only; every interface is
   built here. There are no embedded players, iframes to other products, or SDKs.
3. **No fabricated results.** Unavailable sources stay visibly unavailable.
4. **Local first.** Projects, sources, snapshots and files live in `data/` and `uploads/`.
