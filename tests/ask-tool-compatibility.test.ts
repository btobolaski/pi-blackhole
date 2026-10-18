import { describe, expect, it } from "vitest";
import type { NormalizedBlock } from "../src/types.js";
import { extractUserDecisions, projectUserDecision } from "../src/extract/user-decisions.js";
import { serializeSourceAddressedBranchEntries } from "../src/om/serialize.js";
import { normalize } from "../src/core/normalize.js";
import { toolResult } from "./vcc-fixtures.js";

const result = (
  name: string,
  text: string,
  details?: unknown,
  isError = false,
): Extract<NormalizedBlock, { kind: "tool_result" }> => ({
  kind: "tool_result",
  name,
  text,
  details,
  isError,
  sourceIndex: 12,
});

describe("ask-tool compatibility", () => {
  it("captures pi-ask selected values and scopes comments without leaking previews", () => {
    expect(
      extractUserDecisions([
        result("ask_user", "summary", {
          mode: "submit",
          cancelled: false,
          questions: [
            {
              id: "deploy",
              prompt: "Should we deploy?",
              label: "Deploy",
              type: "single",
            },
          ],
          answers: {
            deploy: {
              indices: [1],
              labels: ["No"],
              values: ["no"],
              note: "Keep the change small",
              optionNotes: { yes: "Maybe after review", no: "Current behavior is safe" },
            },
          },
        }),
      ]),
    ).toEqual([
      "User decided: Should we deploy? → No — user note: Keep the change small / note on unselected option value yes: Maybe after review / note on selected option value no: Current behavior is safe",
    ]);
  });

  it("captures pi-ask custom text beside selected values", () => {
    expect(
      extractUserDecisions([
        result("ask_user", "summary", {
          mode: "submit",
          cancelled: false,
          questions: [{ id: "name", prompt: "What should it be called?" }],
          answers: { name: { values: ["custom"], labels: ["Custom"], customText: "Harbor" } },
        }),
      ]),
    ).toEqual(["User decided: What should it be called? → Custom; custom: Harbor"]);
  });

  it("captures explicit edlsh batch answers and ignores skipped questions", () => {
    expect(
      extractUserDecisions([
        result("ask_user", "batch summary", {
          kind: "batch",
          cancelled: false,
          questions: [{ question: "Deployment?" }, { question: "Region?" }],
          answers: [
            { status: "answered", response: { kind: "selection", selections: ["No"] } },
            { status: "skipped" },
          ],
        }),
      ]),
    ).toEqual(["User decided: Deployment? → No"]);
  });

  it("preserves comments on edlsh selections", () => {
    expect(
      extractUserDecisions([
        result("ask_user", "summary", {
          question: "Proceed?",
          cancelled: false,
          response: { kind: "selection", selections: ["No"], comment: "Keep rollback simple" },
        }),
      ]),
    ).toEqual(["User decided: Proceed? → No — user note: Keep rollback simple"]);
  });

  it("captures edlsh single freeform responses", () => {
    expect(
      extractUserDecisions([
        result("ask_user", "summary", {
          question: "What name?",
          cancelled: false,
          response: { kind: "freeform", text: "Harbor" },
        }),
      ]),
    ).toEqual(["User decided: What name? → Harbor"]);
  });

  it("captures edlsh batch freeform responses and their comments", () => {
    expect(
      extractUserDecisions([
        result("ask_user", "batch summary", {
          kind: "batch",
          cancelled: false,
          questions: [{ question: "What name?" }],
          answers: [
            {
              status: "answered",
              response: { kind: "freeform", text: "Harbor", comment: "Short and clear" },
            },
          ],
        }),
      ]),
    ).toEqual(["User decided: What name? → Harbor — user note: Short and clear"]);
  });

  it("captures UniPi combined answers", () => {
    expect(
      extractUserDecisions([
        result("ask_user", "User selected: Local and wrote: keep it offline", {
          question: "Where should data live?",
          response: { kind: "combined", selections: ["Local"], text: "keep it offline" },
        }),
      ]),
    ).toEqual(["User decided: Where should data live? → Local; custom: keep it offline"]);
  });

  it("excludes UniPi end-turn control results", () => {
    expect(
      extractUserDecisions([
        result("ask_user", "User chose to end the turn.", {
          question: "Continue?",
          response: { kind: "end_turn" },
        }),
      ]),
    ).toEqual([]);
  });

  it("excludes UniPi cancellation control results", () => {
    expect(
      extractUserDecisions([
        result("ask_user", "cancelled", {
          question: "Continue?",
          response: { kind: "cancelled" },
        }),
      ]),
    ).toEqual([]);
  });

  it("excludes UniPi timeout control results", () => {
    expect(
      extractUserDecisions([
        result("ask_user", "timed out", {
          question: "Continue?",
          response: { kind: "timed_out" },
        }),
      ]),
    ).toEqual([]);
  });

  it("preserves comments on UniPi selections", () => {
    expect(
      extractUserDecisions([
        result("ask_user", "summary", {
          question: "Region?",
          response: { kind: "selection", selections: ["eu"], comment: "Latency matters" },
        }),
      ]),
    ).toEqual(["User decided: Region? → eu — user note: Latency matters"]);
  });

  it("captures answered supi responses and labels comments on unselected options", () => {
    expect(
      extractUserDecisions([
        result("ask_user", "summary", {
          outcome: "needs_discussion",
          questions: [
            { id: "db", type: "choice", header: "Database", prompt: "Which database?" },
            { id: "scale", type: "text", header: "Scale", prompt: "Expected load?" },
          ],
          responses: [
            {
              questionId: "db",
              questionComment: "Prefer managed hosting",
              answer: {
                kind: "choice",
                answered: true,
                options: [
                  { value: "pg", label: "Postgres", selected: true, comment: "Existing expertise" },
                  { value: "my", label: "MySQL", selected: false, comment: "Would need migration" },
                ],
              },
            },
            { questionId: "scale", answer: { kind: "text", answered: false } },
          ],
        }),
      ]),
    ).toEqual([
      "User decided: Which database? → Postgres — user note: Prefer managed hosting / note on selected option Postgres: Existing expertise / note on unselected option MySQL: Would need migration / form status: needs discussion before a complete decision",
    ]);
  });

  it("captures an answered supi text response", () => {
    expect(
      extractUserDecisions([
        result("ask_user", "summary", {
          outcome: "submitted",
          questions: [{ id: "reason", prompt: "Why?", type: "text" }],
          responses: [
            {
              questionId: "reason",
              answer: { kind: "text", answered: true, value: "Keep it local" },
            },
          ],
        }),
      ]),
    ).toEqual(["User decided: Why? → Keep it local"]);
  });

  it("keeps supi form comments as global notes without inventing an answer", () => {
    expect(
      extractUserDecisions([
        result("ask_user", "Discussion needed", {
          outcome: "needs_discussion",
          comment: "Please resolve ownership first",
          questions: [{ id: "owner", prompt: "Who owns this?", type: "text" }],
          responses: [{ questionId: "owner", answer: { kind: "text", answered: false } }],
        }),
      ]),
    ).toEqual(["User note (global): Please resolve ownership first"]);
  });

  it("ignores unknown supi answer kinds even when the item carries comments", () => {
    expect(
      extractUserDecisions([
        result("ask_user", "summary", {
          outcome: "submitted",
          questions: [{ id: "q", prompt: "Question?" }],
          responses: [
            {
              questionId: "q",
              questionComment: "comment only",
              answer: { kind: "future_kind", answered: true },
            },
          ],
        }),
      ]),
    ).toEqual([]);
  });

  it("captures non-timeout oh-my-pi answers and leaves explicit select-none distinct", () => {
    expect(
      extractUserDecisions([
        result("ask", "User answers:\nregion: EU", {
          results: [
            {
              id: "region",
              question: "Which region?",
              multi: false,
              selectedOptions: ["EU"],
              timedOut: false,
            },
            {
              id: "features",
              question: "Which features?",
              multi: true,
              selectedOptions: [],
              timedOut: false,
            },
          ],
        }),
      ]),
    ).toEqual([
      "User decided: Which region? → EU",
      "User decided: Which features? → (selected none)",
    ]);
  });

  it("recognizes the rpiv success envelope", () => {
    expect(
      extractUserDecisions([
        result(
          "ask_user_question",
          'User has answered your questions: "Deployment?"="No". You can now continue with the user\'s answers in mind.',
        ),
      ]),
    ).toEqual(["User decided: Deployment? → No"]);
  });

  it("rejects ambiguous quoted fields in the rpiv success envelope", () => {
    expect(
      extractUserDecisions([
        result(
          "ask_user_question",
          'User has answered your questions: "Deployment?"="No, unless it says "manual".". You can now continue with the user\'s answers in mind.',
        ),
      ]),
    ).toEqual([]);
  });

  it("recognizes multiple exact rpiv answer segments", () => {
    expect(
      extractUserDecisions([
        result(
          "ask_user_question",
          'User has answered your questions: "Deploy?"="No". "Region?"="EU". You can now continue with the user\'s answers in mind.',
        ),
      ]),
    ).toEqual(["User decided: Deploy? → No", "User decided: Region? → EU"]);
  });

  it("rejects partial cancelled rpiv answers", () => {
    expect(
      extractUserDecisions([
        result("ask_user_question", "declined", {
          cancelled: true,
          answers: [{ question: "Q", selected: ["A"] }],
        }),
      ]),
    ).toEqual([]);
  });
  it("rejects cancelled UniPi selections", () => {
    expect(
      extractUserDecisions([
        result("ask_user", "User selected: Production", {
          question: "Deploy?",
          response: { kind: "selection", selections: ["Production"] },
          cancelled: true,
        }),
      ]),
    ).toEqual([]);
  });
  it("rejects failed UniPi selections", () => {
    expect(
      extractUserDecisions([
        result("ask_user", "User selected: Production", {
          question: "Deploy?",
          response: { kind: "selection", selections: ["Production"] },
          error: { message: "failed" },
        }),
      ]),
    ).toEqual([]);
  });
  it("rejects OMP timeout defaults", () => {
    expect(
      extractUserDecisions([
        result("ask", "User selected: Production", {
          question: "Deploy?",
          selectedOptions: ["Production"],
          timedOut: true,
        }),
      ]),
    ).toEqual([]);
  });
  it("does not parse an unknown ask_user shape", () => {
    expect(
      extractUserDecisions([result("ask_user", "User selected: Production", { unfamiliar: true })]),
    ).toEqual([]);
  });
  it("rejects UniPi session-control outcomes", () => {
    expect(
      extractUserDecisions([
        result("ask_user", "User selected: Production", {
          question: "Deploy?",
          response: { kind: "new_session", prefill: "ship" },
        }),
      ]),
    ).toEqual([]);
  });
  it("rejects tool results marked as errors", () => {
    expect(
      extractUserDecisions([
        result(
          "ask_user",
          "User selected: Production",
          { question: "Deploy?", response: { kind: "selection", selections: ["Production"] } },
          true,
        ),
      ]),
    ).toEqual([]);
  });

  it("projects a confirmed structured answer into observer input with its source id", () => {
    const cancelled = {
      role: "toolResult",
      toolName: "ask_user_question",
      toolCallId: "cancel-1",
      isError: false,
      timestamp: 1,
      content: [{ type: "text", text: "User answers:\n\n1. Deploy?\nSelected: Production" }],
      details: { cancelled: true, answers: [{ question: "Deploy?", selected: ["Production"] }] },
    };
    const confirmed = {
      ...cancelled,
      toolCallId: "confirmed-1",
      content: [{ type: "text", text: "summary omitted" }],
      details: { cancelled: false, answers: [{ question: "Deploy?", selected: ["No"] }] },
    };
    const { text, sourceEntryIds } = serializeSourceAddressedBranchEntries([
      { type: "message", id: "e2", message: confirmed },
    ]);
    expect(sourceEntryIds).toEqual(["e2"]);
    expect(text).toContain("User decided: Deploy? → No");
    expect(text).not.toContain("Production");
  });

  it("annotates cancelled answer-shaped text within its own source id", () => {
    const cancelled = {
      role: "toolResult",
      toolName: "ask_user_question",
      toolCallId: "cancel-1",
      isError: false,
      timestamp: 1,
      content: [{ type: "text", text: "User answers:\n\n1. Deploy?\nSelected: Production" }],
      details: { cancelled: true, answers: [{ question: "Deploy?", selected: ["Production"] }] },
    };
    const { text, sourceEntryIds } = serializeSourceAddressedBranchEntries([
      { type: "message", id: "e1", message: cancelled },
    ]);
    expect(sourceEntryIds).toEqual(["e1"]);
    expect(text).toContain(
      "Decision capture: cancelled; answer-shaped text is not a confirmed choice.",
    );
    expect(text).toContain("Selected: Production");
    expect(text).not.toContain("User decided: Deploy? → Production");
  });

  it("annotates oh-my-pi timeout selections so raw result text is not promoted", () => {
    const { text } = serializeSourceAddressedBranchEntries([
      {
        type: "message",
        id: "e3",
        message: {
          role: "toolResult",
          toolName: "ask",
          toolCallId: "timeout-1",
          isError: false,
          timestamp: 2,
          content: [{ type: "text", text: "User selected: Production" }],
          details: {
            question: "Deploy?",
            multi: false,
            selectedOptions: ["Production"],
            timedOut: true,
          },
        },
      },
    ]);
    expect(text).toContain("Decision capture: automatic timeout selection ignored as user intent.");
    expect(text).not.toContain("User decided: Deploy? → Production");
  });

  it("annotates timed-out OMP batch rows even when sibling answers are confirmed", () => {
    const projected = projectUserDecision(
      result("ask", "User answers: auto: Production", {
        results: [
          { id: "ok", question: "Region?", multi: false, selectedOptions: ["EU"], timedOut: false },
          {
            id: "auto",
            question: "Deploy?",
            multi: false,
            selectedOptions: ["Production"],
            timedOut: true,
          },
        ],
      }),
    );
    expect(projected.lines).toEqual(["User decided: Region? → EU"]);
    expect(projected.status).toContain("timeout");
  });

  it("annotates OMP chat redirects inside batch results", () => {
    const projected = projectUserDecision(
      result("ask", "chat redirect summary", {
        results: [
          { id: "handoff", question: "Continue?", chatRedirect: true, selectedOptions: ["yes"] },
        ],
      }),
    );
    expect(projected.lines).toEqual([]);
    expect(projected.status).toContain("chat redirect");
  });

  it("marks eko elaboration results as drafts for observer filtering", () => {
    const projected = projectUserDecision(
      result("ask_user", "User selected: Production", {
        mode: "elaborate",
        cancelled: false,
        questions: [{ id: "deploy", prompt: "Deploy?" }],
        answers: { deploy: { values: ["prod"], labels: ["Production"] } },
      }),
    );
    expect(projected.lines).toEqual([]);
    expect(projected.status).toContain("not a confirmed");
  });

  it("keeps legacy note-only answers explicit", () => {
    expect(
      extractUserDecisions([
        result(
          "ask_user_question",
          "User answers:\n\n1. Scope?\nNo option selected.\nUser notes:\nKeep the patch narrow",
        ),
      ]),
    ).toEqual(["User decided: Scope? → (no option selected) — user note: Keep the patch narrow"]);
  });

  it("carries third-party result details through normalize into extraction", () => {
    const details = {
      question: "Proceed?",
      response: { kind: "selection", selections: ["No"] },
    };
    const message = { ...toolResult("ask_user", "summary"), details };
    expect(extractUserDecisions(normalize([message]))).toEqual(["User decided: Proceed? → No"]);
  });
});
