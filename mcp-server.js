#!/usr/bin/env node
/**
 * PeteyPlan MCP server — talks to the Nuxt web app over HTTP.
 *
 * Configure the app's address with PETEYPLAN_API_URL (default http://localhost:3000).
 * All output goes to stderr except JSON-RPC traffic on stdout (stdio transport).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_URL = (process.env.PETEYPLAN_API_URL || "http://localhost:3000").replace(/\/+$/, "");

console.error(`[peteyplan] API base URL: ${API_URL}`);

/* ── HTTP helper ─────────────────────────────────────────────────────────── */

async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(`${API_URL}${path}`, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot reach PeteyPlan at ${API_URL} (${detail}). Is the server running?`);
  }

  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      if (data && typeof data.statusMessage === "string") message = data.statusMessage;
    } catch { /* keep generic message */ }
    throw new Error(message);
  }

  if (res.status === 204) return null;
  return res.json();
}

function boardText(board) {
  return JSON.stringify(board, null, 2);
}

const boardIdInput = z.string().optional().describe("Board ID (omit for Default Board)");
const boardPath = (boardId) => `/api/board${boardId ? `?boardId=${encodeURIComponent(boardId)}` : ""}`;

/* ── Server ──────────────────────────────────────────────────────────────── */

const server = new McpServer({
  name: "peteyplan",
  version: "2.0.0",
});

// ── Board ────────────────────────────────────────────────────────────────────

server.tool("get_boards", "List boards, including their IDs, emoji and colours", {}, async () => {
  return { content: [{ type: "text", text: boardText(await api("/api/boards")) }] };
});

server.tool("get_work_types", "List card work types and the progress stages each one uses (ids and labels)", {}, async () => {
  return { content: [{ type: "text", text: boardText(await api("/api/kinds")) }] };
});

server.tool("get_board", "Get the full Kanban board with all columns and cards", { boardId: boardIdInput }, async ({ boardId }) => {
  const board = await api(boardPath(boardId));
  return { content: [{ type: "text", text: boardText(board) }] };
});

server.tool("get_columns", "List all columns on the board", { boardId: boardIdInput }, async ({ boardId }) => {
  const board = await api(boardPath(boardId));
  const cols = board.columns.map((c) => ({ id: c.id, title: c.title, cardCount: c.cards.length }));
  return { content: [{ type: "text", text: JSON.stringify(cols, null, 2) }] };
});

server.tool(
  "get_cards",
  "Get all cards in a specific column",
  { columnId: z.string().describe("The column ID"), boardId: boardIdInput },
  async ({ columnId, boardId }) => {
    const board = await api(boardPath(boardId));
    const col = board.columns.find((c) => c.id === columnId);
    if (!col) return { content: [{ type: "text", text: `Column not found: ${columnId}` }], isError: true };
    return { content: [{ type: "text", text: boardText(col.cards) }] };
  }
);

// ── Cards ────────────────────────────────────────────────────────────────────

server.tool(
  "add_card",
  "Add a new card to a column. Cards with sooner due dates are auto-ranked nearer the top.",
  {
    columnId: z.string().describe("The column ID to add the card to"),
    title: z.string().describe("Card title"),
    description: z.string().optional().describe("Card description (optional)"),
    jiraKey: z
      .string()
      .optional()
      .describe("Jira issue key or browse URL (e.g. CX-1831 or https://kycglobal.atlassian.net/browse/CX-1831)"),
    dueBy: z
      .string()
      .optional()
      .describe("Due date as YYYY-MM-DD (optional). Sooner dues float higher in the column."),
    kind: z
      .string()
      .optional()
      .describe("Work type id or name from get_work_types (optional; defaults to the first type). Changes which progress pills apply."),
    progress: z
      .string()
      .optional()
      .describe("Progress stage id or name for the card's work type, see get_work_types (optional; defaults to todo)"),
    checklist: z
      .array(z.object({
        id: z.string().optional().describe("Existing item ID (keep to preserve the item)"),
        text: z.string().describe("Checklist item text"),
        done: z.boolean().optional().describe("Whether the item is ticked"),
      }))
      .optional()
      .describe("To-do items inside the card (optional)"),
  },
  async ({ columnId, title, description, jiraKey, dueBy, kind, progress, checklist }) => {
    const card = await api("/api/cards", {
      method: "POST",
      body: JSON.stringify({
        columnId,
        title,
        description: description || "",
        jiraKey: jiraKey || "",
        dueBy: dueBy || "",
        ...(kind ? { kind } : {}),
        ...(progress ? { progress } : {}),
        checklist: checklist || [],
      }),
    });
    return { content: [{ type: "text", text: boardText(card) }] };
  }
);

server.tool(
  "update_card",
  "Update a card's title, description, Jira key, due date, work type, progress stage, and/or checklist. Changing dueBy re-ranks the column. cardId accepts a card ID or PP-n ref (e.g. PP-12).",
  {
    columnId: z.string().describe("The column ID containing the card (kept for compatibility)"),
    cardId: z.string().describe("The card ID or PP-n ref to update (e.g. PP-12)"),
    title: z.string().optional().describe("New title (omit to keep current)"),
    description: z.string().optional().describe("New description (omit to keep current)"),
    jiraKey: z
      .string()
      .optional()
      .describe("New Jira key or browse URL (omit to keep current; empty string clears it)"),
    dueBy: z
      .string()
      .optional()
      .describe("New due date YYYY-MM-DD (omit to keep current; empty string clears it)"),
    kind: z
      .string()
      .optional()
      .describe("Work type id or name from get_work_types (changes status pills)"),
    progress: z
      .string()
      .optional()
      .describe("Progress stage id or name for the card's work type, see get_work_types"),
    checklist: z
      .array(z.object({
        id: z.string().optional().describe("Existing item ID (keep to preserve the item)"),
        text: z.string().describe("Checklist item text"),
        done: z.boolean().optional().describe("Whether the item is ticked"),
      }))
      .optional()
      .describe("Full replacement checklist (omit to keep current; pass existing item IDs to keep them; [] clears it)"),
  },
  async ({ cardId, title, description, jiraKey, dueBy, kind, progress, checklist }) => {
    const body = {};
    if (title !== undefined) body.title = title;
    if (description !== undefined) body.description = description;
    if (jiraKey !== undefined) body.jiraKey = jiraKey;
    if (dueBy !== undefined) body.dueBy = dueBy;
    if (kind !== undefined) body.kind = kind;
    if (progress !== undefined) body.progress = progress;
    if (checklist !== undefined) body.checklist = checklist;
    const card = await api(`/api/cards/${encodeURIComponent(cardId)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    return { content: [{ type: "text", text: boardText(card) }] };
  }
);

server.tool(
  "delete_card",
  "Soft-archive a card (recoverable from the Archive screen). Done cards also auto-archive after 5 days. cardId accepts a card ID or PP-n ref (e.g. PP-12).",
  {
    columnId: z.string().describe("The column ID containing the card (kept for compatibility)"),
    cardId: z.string().describe("The card ID or PP-n ref to archive (e.g. PP-12)"),
  },
  async ({ cardId }) => {
    await api(`/api/cards/${encodeURIComponent(cardId)}`, { method: "DELETE" });
    return { content: [{ type: "text", text: `Archived card ${cardId}` }] };
  }
);

server.tool(
  "move_card",
  "Move a card from one column to another (optionally at a specific position). cardId accepts a card ID or PP-n ref (e.g. PP-12).",
  {
    fromColumnId: z.string().describe("Source column ID"),
    boardId: boardIdInput,
    toColumnId: z.string().describe("Destination column ID"),
    cardId: z.string().describe("The card ID or PP-n ref to move (e.g. PP-12)"),
  },
  async ({ fromColumnId, toColumnId, cardId, position, boardId }) => {
    const board = await api(boardPath(boardId));
    const fromCol = board.columns.find((c) => c.id === fromColumnId);
    const toCol = board.columns.find((c) => c.id === toColumnId);
    if (!fromCol) return { content: [{ type: "text", text: `Source column not found: ${fromColumnId}` }], isError: true };
    if (!toCol) return { content: [{ type: "text", text: `Destination column not found: ${toColumnId}` }], isError: true };

    const cards = board.columns.flatMap((c) => c.cards);
    const card = cards.find((c) => c.id === cardId || c.ref === cardId || String(c.number) === String(cardId));
    if (!card) return { content: [{ type: "text", text: `Card not found: ${cardId}` }], isError: true };
    const resolvedId = card.id;

    const fromIndex = fromCol.cards.findIndex((c) => c.id === resolvedId);
    if (fromIndex === -1) return { content: [{ type: "text", text: `Card not found: ${cardId}` }], isError: true };

    // Compute the destination column's final ordering locally, then persist it.
    const fromId = fromCol.id;
    let target = toCol.cards.map((c) => c.id);
    if (fromId === toColumnId) {
      target = target.filter((id) => id !== resolvedId);
    }
    const pos = position !== undefined ? Math.min(position, target.length) : target.length;
    target.splice(pos, 0, resolvedId);
    await api("/api/cards/reorder", {
      method: "POST",
      body: JSON.stringify({ columnId: toColumnId, orderedIds: target }),
    });

    return { content: [{ type: "text", text: boardText({ moved: card, to: toCol.title, position: pos }) }] };
  }
);

// ── Columns ──────────────────────────────────────────────────────────────────

server.tool(
  "add_column",
  "Add a new column to the board",
  { title: z.string().describe("Column title"), boardId: boardIdInput },
  async ({ title, boardId }) => {
    const col = await api(`/api/columns${boardId ? `?boardId=${encodeURIComponent(boardId)}` : ""}`, { method: "POST", body: JSON.stringify({ title }) });
    return { content: [{ type: "text", text: boardText(col) }] };
  }
);

server.tool(
  "rename_column",
  "Rename an existing column",
  {
    columnId: z.string().describe("The column ID to rename"),
    title: z.string().describe("New column title"),
  },
  async ({ columnId, title }) => {
    await api(`/api/columns/${encodeURIComponent(columnId)}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    });
    return { content: [{ type: "text", text: boardText({ id: columnId, title }) }] };
  }
);

server.tool(
  "delete_column",
  "Delete a column and all its cards",
  { columnId: z.string().describe("The column ID to delete") },
  async ({ columnId }) => {
    await api(`/api/columns/${encodeURIComponent(columnId)}`, { method: "DELETE" });
    return { content: [{ type: "text", text: `Deleted column ${columnId}` }] };
  }
);

server.tool(
  "clear_column_cards",
  "Delete all cards in a column (keeps the column)",
  { columnId: z.string().describe("The column ID whose cards to delete") },
  async ({ columnId }) => {
    await api(`/api/columns/${encodeURIComponent(columnId)}/cards`, { method: "DELETE" });
    return { content: [{ type: "text", text: `Cleared cards from column ${columnId}` }] };
  }
);

server.tool(
  "reorder_columns",
  "Reorder columns left-to-right on the board",
  {
    boardId: boardIdInput,
    orderedIds: z
      .array(z.string())
      .describe("Complete list of column IDs in the desired left-to-right order"),
  },
  async ({ orderedIds, boardId }) => {
    await api(`/api/columns/reorder${boardId ? `?boardId=${encodeURIComponent(boardId)}` : ""}`, {
      method: "POST",
      body: JSON.stringify({ orderedIds }),
    });
    return { content: [{ type: "text", text: boardText({ orderedIds }) }] };
  }
);

/* ── Start ──────────────────────────────────────────────────────────────────── */

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("MCP server error:", err);
  process.exit(1);
});