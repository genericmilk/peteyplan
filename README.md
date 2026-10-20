# PeteyPlan

A personal Kanban board — columns, cards, drag-and-drop — built as a **Nuxt + SQLite** web app and meant to run in **Docker**.

This replaced an earlier Electron app; that source is kept only locally (not in this repo).

## Features

- Multiple independent boards with coloured emoji pills beside the logo; hover or focus a pill to reveal its name
- Manage board names, emojis and colours in **Board options → Settings**; the initial **Default Board** can be renamed but cannot be deleted
- Board emojis use a floating, searchable, categorised picker (`vue3-emoji-picker`) that closes on blur or outside click, with native emoji rendering and locally bundled emoji data
- Hover over a board pill while dragging to switch boards, then drop a card into a destination column or a column anywhere on the board
- Drop directly onto a pill to append a column or move a card into its first column; an empty board gets a **To Do** column for a dropped card
- Horizontal board-switch pan showing intervening boards whipping past (respects reduced-motion preferences), and remembered active board on this browser
- Columns and cards with drag-and-drop reordering
- Cards carry a stable number shown as `PP-n` (e.g. `PP-12`); refs work in the API and MCP tools anywhere a card ID does
- Optional card **description**, **Jira key**, and **due date**
- Work **kind** (development / chore / managing) with kind-specific progress stages
- Due dates auto-rank cards (sooner dues nearer the top)
- Soft-archive (including auto-archive of Done cards after 5 days)
- HTTP API + an MCP server so agents can drive the board

## Requirements

| Mode | Needs |
| ---- | ----- |
| **Docker** (recommended) | [Docker](https://docs.docker.com/get-docker/) + Docker Compose |
| **Local dev** | Node `^22.19 \|\| ^24.11 \|\| >=26` (Node 24 LTS recommended — see `.nvmrc`) |

## Quick start (Docker)

```bash
git clone https://github.com/pday-kyc360/peteyplan.git
cd peteyplan
docker compose up -d --build
```

Open [http://localhost:3000](http://localhost:3000).

On first start the app creates a fresh SQLite database in the `peteyplan-data` Docker volume and seeds the default columns (**Backlog**, **To Do**, **In Progress**, **Done**). The volume keeps your board across restarts and rebuilds.

```bash
docker compose down          # stop; keep the board
docker compose down -v       # stop and delete the board volume
```

To publish on another host port (example: 8080), edit the `ports` mapping in `docker-compose.yml` to `"8080:3000"`, then recreate the container.

## Run locally (dev)

```bash
npm install
npm run dev          # http://localhost:3000
```

The DB is created under `./data/peteyplan.db` by default (that directory is gitignored). Override with:

```bash
DATA_DIR=/path/to/dir npm run dev
```

Production build + local preview:

```bash
npm run build
npm run preview
```

## Database

| Setting | Value |
| ------- | ----- |
| Engine | SQLite (`better-sqlite3`) |
| File | `peteyplan.db` inside `DATA_DIR` |
| Docker | `DATA_DIR=/data` → named volume `peteyplan-data` |
| Local | `DATA_DIR` defaults to `./data` |

**Nothing under `data/` or any `*.db` / `*.sqlite*` file is committed.** A clone + fresh Docker (or local) start always gets a new DB and the default seeded columns.
Schema (simplified):

- `columns(id, title, position)`
- `boards(id, name, emoji, color, position)` — existing columns and releases migrate to the protected default board
- Columns and releases each carry a `board_id`; archives follow their column's board
- `cards(id, column_id, number, title, description, jira_key, due_by, kind, progress, position, completed_at, archived_at)`
- `card_counter(id, next)` — monotonic allocator for card numbers (`PP-n` refs never reuse deleted numbers)

Jira keys (and pasted Atlassian browse URLs) deep-link to `https://kycglobal.atlassian.net/browse/<KEY>`. Keys mentioned in the title or description are also auto-linked.

## MCP server

[`mcp-server.js`](mcp-server.js) exposes board tools over stdio and talks to the running web app over HTTP. Set `PETEYPLAN_API_URL` (default `http://localhost:3000`).

**Tools:** `get_boards`, `get_board`, `get_columns`, `get_cards`, `add_card`, `update_card`, `delete_card`, `move_card`, `add_column`, `rename_column`, `delete_column`, `clear_column_cards`, `reorder_columns`.

Board reads, `move_card`, `add_column`, and `reorder_columns` accept an optional `boardId`; omit it for the default board. Card numbers remain globally unique across boards.

### OpenCode

```json
{
  "mcp": {
    "peteyplan": {
      "type": "local",
      "command": ["node", "mcp-server.js"],
      "enabled": true,
      "env": { "PETEYPLAN_API_URL": "http://localhost:3000" }
    }
  }
}
```

A ready-made config lives in [`opencode.json`](opencode.json).

### Cursor

Add an MCP server entry pointing at `node mcp-server.js` with `PETEYPLAN_API_URL` set to your running app (same as above). The app must be up (Docker or `npm run dev`) before MCP tools will work.

## API overview

| Method | Route | Body |
| ------ | ----- | ---- |
| GET | `/api/board` | — |
| GET | `/api/boards` | — |
| POST | `/api/boards` | `{ name, emoji?, color? }` — creates an empty board |
| PATCH | `/api/boards/:id` | `{ name?, emoji?, color? }` |
| DELETE | `/api/boards/:id` | — (permanently deletes contents; default board protected) |
| POST | `/api/boards/:id/items` | `{ fromBoardId, type: "card" \| "column", itemId, targetColumnId?, targetPosition? }` |
| GET | `/api/archive` | — |
| POST | `/api/archive/restore` | `{ id, columnId? }` |
| DELETE | `/api/archive/:id` | — (permanent delete) |
| POST | `/api/columns` | `{ title }` |
| PATCH | `/api/columns/:id` | `{ title }` |
| DELETE | `/api/columns/:id` | — |
| DELETE | `/api/columns/:id/cards` | — (soft-archive all cards in column) |
| POST | `/api/columns/reorder` | `{ orderedIds: string[] }` |
| POST | `/api/cards` | `{ columnId, title, description?, jiraKey?, dueBy?, kind?, progress? }` |
| PATCH | `/api/cards/:id` | `{ title?, description?, jiraKey?, dueBy?, kind?, progress? }` — `:id` accepts a card ID or `PP-n` ref |
| DELETE | `/api/cards/:id` | — (soft-archive; `:id` accepts a card ID or `PP-n` ref) |
| POST | `/api/cards/reorder` | `{ columnId, orderedIds: string[] }` — ids accept card IDs or `PP-n` refs |

`GET /api/board`, `GET /api/archive`, `GET /api/releases`, `POST /api/columns`, `POST /api/columns/reorder`, and `POST /api/releases` accept `?boardId=...`; omitting it keeps the original default-board behavior. Other item routes identify their board through the column, card or release ID.

Cross-board transfers preserve card IDs/numbers and remove release assignments from the source board. Moving a column carries both active and archived cards. Card transfers require a destination column unless the destination board is empty, when **To Do** is created automatically. Dropping into **Done** preserves the usual completion and auto-archive behavior.

## Tests

```bash
npm test             # Node 24+: migration, persistence, board isolation, transfers, default-board protection
npm run build        # Production client and server build
```

## Project layout

```
├── app.vue              # Board UI
├── server/
│   ├── db.ts            # SQLite schema, seeding, queries
│   └── api/             # Nitro API routes
├── mcp-server.js        # MCP stdio server → HTTP API
├── Dockerfile           # Multi-stage Nuxt build
├── docker-compose.yml   # App + named data volume
└── opencode.json        # Sample MCP config
```

## License

Private — all rights reserved unless otherwise noted.
