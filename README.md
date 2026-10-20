<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.png">
    <img src="docs/logo-light.png" alt="PeteyPlan" width="96" height="96">
  </picture>
</p>

<h1 align="center">PeteyPlan</h1>

<p align="center">
  A fast, self-hosted Kanban board for tracking your own work.<br>
  Multiple boards, checklists, release folders and an MCP server, in one small Docker container.
</p>

<p align="center">
  <a href="#install-with-docker">Install</a> ·
  <a href="#updating">Update</a> ·
  <a href="#features">Features</a> ·
  <a href="#mcp-server">MCP</a> ·
  <a href="#http-api">API</a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="docs/screenshot-light.png">
    <img src="docs/screenshot-dark.png" alt="PeteyPlan showing a Work board with Backlog, To Do, In Progress and Done columns" width="100%">
  </picture>
</p>

---

## Install with Docker

You need [Docker](https://docs.docker.com/get-docker/) with Docker Compose (included in Docker Desktop).

```bash
git clone https://github.com/pday-kyc360/peteyplan.git
cd peteyplan
docker compose up -d --build
```

Open **[http://localhost:3000](http://localhost:3000)**.

On first start PeteyPlan creates a SQLite database in the `peteyplan-data` Docker volume and seeds a **Default Board** with **Backlog**, **To Do**, **In Progress** and **Done** columns. The container restarts automatically with Docker and has a built-in health check.

<details>
<summary><strong>Run on a different port</strong></summary>

Change the left-hand side of the `ports` mapping in `docker-compose.yml`, for example to serve on 8080:

```yaml
ports:
  - "8080:3000"
```

Then apply it with `docker compose up -d`.
</details>

## Updating

Your board lives in the Docker volume, not the image, so updating never touches your data.

```bash
cd peteyplan
git pull
docker compose up -d --build
```

Database changes (new columns such as checklists) are applied automatically when the new version starts.

<details>
<summary><strong>Back up before updating (recommended)</strong></summary>

Snapshot the data volume to a file in the current folder:

```bash
docker compose stop
docker run --rm -v peteyplan_peteyplan-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/peteyplan-backup.tgz -C /data .
docker compose start
```

Restore it (this replaces the current board):

```bash
docker compose stop
docker run --rm -v peteyplan_peteyplan-data:/data -v "$PWD":/backup alpine \
  sh -c 'rm -rf /data/* && tar xzf /backup/peteyplan-backup.tgz -C /data'
docker compose start
```
</details>

<details>
<summary><strong>Roll back to an earlier version</strong></summary>

```bash
git log --oneline            # find the commit you want
git checkout <commit>
docker compose up -d --build
```

Return to the latest version with `git checkout main && git pull`.
</details>

### Everyday commands

| Task | Command |
| ---- | ------- |
| Stop (keeps your board) | `docker compose down` |
| Start again | `docker compose up -d` |
| View logs | `docker compose logs -f` |
| **Delete everything**, including your board | `docker compose down -v` |

## Features

**Boards and cards**
- Multiple boards, each with its own emoji and colour. Click a pill in the top bar to switch, or hover a pill while dragging to carry a card or column across.
- Hover the board list or focus a pill to reveal every name. Inactive pills are greyscale, showing 50% colour on hover. When the list overflows, wheel up scrolls left and wheel down scrolls right, with the scrollbar hidden.
- Drag-and-drop columns and cards. Cards dropped into **Done** are marked complete and auto-archive after 5 days.
- Every card gets a stable reference like `PP-12` that works in the UI, API and MCP tools.
- Optional description (Markdown), Jira key and due date. Sooner due dates float to the top; overdue and due-today dates are highlighted.
- **Checklists** inside cards: tick items on the card, quick-add from the card footer, or edit and reorder them in the card dialog.
- Work types (development, chore, managing) with their own progress stages, shown as a stage track. Hover a segment to see the stage, click to set it.
- **Release folders** group cards into a weekly release with preprod and prod Jira tickets.
- Soft-delete to an archive you can restore from. An unread dot marks cards nobody has opened yet.

**Built for speed**
- Add cards inline at the bottom of a column: type, press <kbd>Enter</kbd>, keep going.
- Press <kbd>/</kbd> to filter every card on the board by title, description, Jira key, stage or checklist item.
- Jira keys like `CX-1831` link straight to the issue wherever they appear.

**Looks the way you like**
- Frosted-glass interface lit by the active board's colour.
- **Settings → Appearance**: Day, Night or System theme (or the sun/moon button), Glass or Solid surfaces, transition speed, and comfortable or compact density. Respects your OS reduced-motion and reduced-transparency settings.

## MCP server

[`mcp-server.js`](mcp-server.js) lets AI agents read and update your board. It runs over stdio and talks to the running app over HTTP, so start PeteyPlan first.

| Tools | |
| ----- | - |
| Boards | `get_boards`, `get_board`, `get_columns`, `get_cards` |
| Cards | `add_card`, `update_card`, `delete_card`, `move_card` |
| Columns | `add_column`, `rename_column`, `delete_column`, `clear_column_cards`, `reorder_columns` |

Board reads, `move_card`, `add_column` and `reorder_columns` take an optional `boardId` (omit it for the default board). `add_card` and `update_card` accept a `checklist`. Set `PETEYPLAN_API_URL` if the app isn't at `http://localhost:3000`.

<details>
<summary><strong>OpenCode</strong></summary>

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
</details>

<details>
<summary><strong>Cursor, Claude Code and other MCP clients</strong></summary>

Add a stdio server that runs `node /path/to/peteyplan/mcp-server.js` with `PETEYPLAN_API_URL` set to your running app. Run `npm install` in the repo once so the MCP SDK is available.
</details>

## HTTP API

Card routes accept either a card ID or a `PP-n` ref. Routes marked † take an optional `?boardId=` and default to the default board.

<details>
<summary><strong>Route reference</strong></summary>

| Method | Route | Body |
| ------ | ----- | ---- |
| GET | `/api/boards` | |
| POST | `/api/boards` | `{ name, emoji?, color? }` |
| PATCH | `/api/boards/:id` | `{ name?, emoji?, color? }` |
| DELETE | `/api/boards/:id` | Deletes the board and its contents (default board protected) |
| POST | `/api/boards/:id/items` | `{ fromBoardId, type: "card" \| "column", itemId, targetColumnId?, targetPosition? }` |
| GET | `/api/board` † | |
| POST | `/api/columns` † | `{ title }` |
| PATCH | `/api/columns/:id` | `{ title }` |
| DELETE | `/api/columns/:id` | |
| DELETE | `/api/columns/:id/cards` | Archives every card in the column |
| POST | `/api/columns/reorder` † | `{ orderedIds }` |
| POST | `/api/cards` | `{ columnId, title, description?, jiraKey?, dueBy?, kind?, progress?, checklist? }` |
| PATCH | `/api/cards/:id` | `{ title?, description?, jiraKey?, dueBy?, kind?, progress?, checklist? }` |
| DELETE | `/api/cards/:id` | Soft-archives the card |
| POST | `/api/cards/reorder` | `{ columnId, orderedIds }` |
| GET | `/api/archive` † | |
| POST | `/api/archive/restore` | `{ cardId, columnId? }` |
| DELETE | `/api/archive/:id` | Permanently deletes an archived card |
| GET | `/api/releases` † | |
| POST | `/api/releases` † | `{ title?, weekStart?, preprodKey?, prodKey? }` |
| PATCH | `/api/releases/:id` | `{ title?, weekStart?, preprodKey?, prodKey? }` |
| DELETE | `/api/releases/:id` | Cards stay on the board |
| POST | `/api/releases/:id/cards` | `{ cardId }` |
| DELETE | `/api/releases/:id/cards/:cardId` | |

A `checklist` is an array of `{ id?, text, done? }`. Sending one replaces the card's whole list; keep existing `id`s to preserve items.

Moving a card between boards keeps its ID and number and drops its release. Moving a column carries its archived cards too. Dropping a card on an empty board creates a **To Do** column for it.
</details>

## Development

Needs Node `^22.19`, `^24.11` or `>=26` (Node 24 LTS recommended, see `.nvmrc`).

```bash
npm install
npm run dev          # http://localhost:3000
npm test             # migrations, persistence, boards, transfers, checklists
npm run build        # production build
```

Without Docker the database is created at `./data/peteyplan.db` (gitignored). Point it elsewhere with `DATA_DIR=/path/to/dir`.

<details>
<summary><strong>Data and schema</strong></summary>

| | |
| - | - |
| Engine | SQLite via `better-sqlite3`, WAL mode |
| File | `peteyplan.db` inside `DATA_DIR` (`/data` in Docker, `./data` locally) |
| Migrations | Applied automatically on startup; older databases are upgraded in place |

- `boards(id, name, emoji, color, position)`
- `columns(id, board_id, title, position)`
- `cards(id, column_id, number, title, description, jira_key, due_by, kind, progress, position, completed_at, archived_at, release_id, viewed_at, checklist)`
- `releases(id, board_id, title, week_start, preprod_key, prod_key, position)`
- `card_counter(id, next)` hands out `PP-n` numbers, which are never reused

No database files are committed, so a fresh clone always starts with an empty board.
</details>

<details>
<summary><strong>Project layout</strong></summary>

```
├── app.vue                  # Board UI
├── assets/css/main.css      # Visual system: tokens, glass surfaces, themes
├── composables/             # Appearance preferences
├── shared/                  # Progress stages and checklists (client + server)
├── server/
│   ├── db.ts                # SQLite schema, migrations, queries
│   └── api/                 # Nitro API routes
├── mcp-server.js            # MCP stdio server → HTTP API
├── Dockerfile               # Multi-stage build
└── docker-compose.yml       # App + named data volume
```
</details>

## License

Private. All rights reserved unless otherwise noted.
