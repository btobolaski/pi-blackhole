import { describe, expect, it } from "vitest";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { NormalizedBlock } from "../src/types.js";
import { extractUserDecisions, MAX_DECISIONS } from "../src/extract/user-decisions.js";
import { compile, extractSection } from "../src/core/summarize.js";

const result = (text: string, details?: unknown): NormalizedBlock => ({
  kind: "tool_result",
  name: "ask_user_question",
  text,
  details,
  isError: false,
});
const confirmed = "User answers:\n\n1. Deployment?\nSelected: Staging";

describe("questionnaire result trust boundaries", () => {
  it("treats structured cancellation as authoritative over answer-shaped text", () => {
    expect(extractUserDecisions([result(confirmed, { cancelled: true, answers: [] })])).toEqual([]);
  });
  it("does not replace a confirmed selection with a status line inside a preview", () => {
    expect(
      extractUserDecisions([result(confirmed + "\nSelected preview:\nSelected: Production")]),
    ).toEqual(["User decided: Deployment? → Staging"]);
  });
  it("does not invent a question from numbered preview content", () => {
    expect(
      extractUserDecisions([
        result(confirmed + "\nSelected preview:\n2. Hidden question\nAnswer: Production"),
      ]),
    ).toEqual(["User decided: Deployment? → Staging"]);
  });
  it("does not accept a status line inside an unselected option note", () => {
    expect(
      extractUserDecisions([
        result(confirmed + "\nNotes for Production (not selected):\nSelected: Production"),
      ]),
    ).toEqual(["User decided: Deployment? → Staging"]);
  });
  it("still recognizes a subsequent question after a preview section", () => {
    expect(
      extractUserDecisions([
        result(confirmed + "\nSelected preview:\npreview body\n\n2. Region?\nSelected: EU"),
      ]),
    ).toEqual(["User decided: Deployment? → Staging", "User decided: Region? → EU"]);
  });
  it("falls back to supported text when structured data has an unknown shape", () => {
    expect(extractUserDecisions([result(confirmed, { unfamiliar: true })])).toEqual([
      "User decided: Deployment? → Staging",
    ]);
  });
});

describe("decision retention across compactions", () => {
  const answer = (i: number): ToolResultMessage => ({
    role: "toolResult",
    toolName: "ask_user_question",
    toolCallId: `answer-${i}`,
    isError: false,
    timestamp: i,
    content: [{ type: "text", text: `User answers:\n\n1. Question ${i}\nSelected: Choice${i}` }],
  });
  it("keeps only the newest eight decision lines when merging two compactions", () => {
    const first = compile({ messages: Array.from({ length: MAX_DECISIONS }, (_, i) => answer(i)) });
    const merged = compile({ messages: [answer(MAX_DECISIONS)], previousSummary: first });
    expect(extractSection(merged, "User Decisions").split("\n")).toEqual(
      Array.from(
        { length: MAX_DECISIONS },
        (_, i) => `- User decided: Question ${i + 1} → Choice${i + 1}`,
      ),
    );
  });
});
