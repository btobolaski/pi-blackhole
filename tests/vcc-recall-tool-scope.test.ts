import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { registerRecallTool } from "../src/tools/recall.js";

const OBSERVATION_ID = "a1b2c3d4e5f6";
const OFF_BRANCH_OBSERVATION_ID = "0f1e2d3c4b5a";

const register = (): ToolDefinition => {
  let tool: ToolDefinition | undefined;
  registerRecallTool({
    registerTool: (t: ToolDefinition) => {
      tool = t;
    },
  } as any);
  if (!tool) throw new Error("recall tool was not registered");
  return tool;
};

const fileWrite = (path: string, content: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "toolCall", id: content, name: "write", arguments: { path, content } }],
  api: "openai-completions",
  provider: "test",
  model: "test",
  stopReason: "toolUse",
  timestamp: 0,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
});

let dir: string;
let session: SessionManager;
let tool: ToolDefinition;

const recordObservation = (id: string, sourceEntryIds: string[]) =>
  session.appendCustomEntry("om.observations.recorded", {
    coversUpToId: sourceEntryIds.at(-1),
    observations: [
      {
        id,
        sourceEntryIds,
        content: "Observed evidence",
        timestamp: "2026-01-01 12:00",
        relevance: "medium",
        tokenCount: 3,
      },
    ],
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "recall-rewind-"));
  session = SessionManager.create(dir, join(dir, "sessions"));
  // Assistant messages force persistence. Rewind leaves #1/#2 on disk,
  // but the current branch has sparse global indices #0, #3, #4.
  const root = session.appendMessage(fileWrite("src/on.ts", "needle early-content"));
  const abandoned = session.appendMessage({
    role: "user",
    content: "off lineage secret",
    timestamp: 0,
  });
  session.appendMessage(fileWrite("src/off.ts", "needle abandoned-content"));
  recordObservation(OFF_BRANCH_OBSERVATION_ID, [abandoned]);
  session.branch(root);
  session.appendMessage(fileWrite("src/on.ts", "needle later-content"));
  const tip = session.appendMessage({ role: "user", content: "branch tip message", timestamp: 0 });
  recordObservation(OBSERVATION_ID, [root, abandoned, tip]);
  tool = register();
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const invoke = async (params: Record<string, unknown>) => {
  const result = await tool.execute("call", params, undefined, undefined, {
    sessionManager: session,
  });
  const text = result.content.find((block) => block.type === "text");
  if (!text) throw new Error("recall returned no text");
  return text.text;
};

it("removes scope from the tool schema", () => {
  expect(tool.parameters).not.toHaveProperty("properties.scope");
});

const cases: [string, Record<string, unknown>, string][] = [
  ["search excludes abandoned entries", { query: "secret" }, 'No matches for "secret"'],
  ["search retains the new branch", { query: "branch tip" }, "branch tip message"],
  [
    "legacy command text is ordinary query text",
    { query: "secret scope:all" },
    'No matches for "secret scope:all"',
  ],
  ["recent entries stay on the branch", {}, "Session history (3 entries)"],
  ["file search stays on the branch", { query: "needle", mode: "file" }, "src/on.ts"],
  ["touched files stay on the branch", { mode: "touched" }, "src/on.ts"],
  [
    "expand blocks abandoned entries",
    { expand: [2] },
    "Cannot expand indices outside active lineage: 2",
  ],
  [
    "mixed search and expand cannot bypass lineage",
    { query: "needle", expand: [2] },
    "Cannot expand indices outside active lineage: 2",
  ],
  [
    "#N blocks abandoned entries",
    { query: "#2" },
    "Cannot expand indices outside active lineage: 2",
  ],
  [
    "file drill-down blocks abandoned entries",
    { query: "#2:file" },
    "Cannot expand indices outside active lineage: 2",
  ],
  [
    "text drill-down blocks abandoned entries",
    { query: "#1:text:full" },
    "Cannot expand indices outside active lineage: 1",
  ],
  ["first-entry drill-down retains its payload", { query: "#0:on.ts" }, "needle early-content"],
  [
    "sparse-index drill-down retains its own payload",
    { query: "#3:on.ts:full" },
    "needle later-content",
  ],
  ["active expand preserves global indices", { expand: [3] }, "#3 [assistant]"],
  ["active #N expansion works", { query: "#3" }, "#3 [assistant]"],
  ["active message drill-down works", { query: "#4:text" }, "branch tip message"],
  ["memory sources advertise only active indices", { query: OBSERVATION_ID }, "(at index #0, #4)"],
  [
    "memory IDs cannot reach abandoned ledger entries",
    { query: OFF_BRANCH_OBSERVATION_ID },
    `No observation or reflection with id ${OFF_BRANCH_OBSERVATION_ID}`,
  ],
];

describe.each([{}, { scope: "all" }])("real rewind with extra parameters %j", (extra) => {
  it.each(cases)("%s", async (_name, params, expected) => {
    const out = await invoke({ ...params, ...extra });
    expect(out).toContain(expected);
    expect(out).not.toContain("off lineage secret");
    expect(out).not.toContain("src/off.ts");
    expect(out).not.toContain("needle abandoned-content");
  });
});

describe.each(["empty", "throwing"])("%s lineage fails closed", (state) => {
  beforeEach(() => {
    // Keep getEntries populated so falling back to it would expose history.
    if (state === "empty") session.resetLeaf();
    else
      vi.spyOn(session, "getBranch").mockImplementation(() => {
        throw new Error("unavailable");
      });
  });
  it.each([
    [{}, "Session history (0 entries)"],
    [{ query: "needle" }, 'No matches for "needle"'],
    [{ expand: [0] }, "Cannot expand indices outside active lineage: 0"],
    [{ query: "#0:file" }, "Cannot expand indices outside active lineage: 0"],
  ] satisfies [Record<string, unknown>, string][])("blocks %j", async (params, expected) => {
    expect(await invoke(params)).toContain(expected);
  });
});
