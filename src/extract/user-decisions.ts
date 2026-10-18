import type { NormalizedBlock } from "../types";
import { clip } from "../core/content";

export const ASK_TOOL = "ask_user_question";
export const ASK_TOOL_NAMES = new Set([ASK_TOOL, "ask_user", "ask"]);
/** Newest-wins cap on rendered decision lines per compile. */
export const MAX_DECISIONS = 8;
/** Question text clip: enough to identify the question, not its preamble. */
export const QUESTION_CLIP = 120;
/** Selected labels / custom answer clip: labels are short; this bounds a pasted essay. */
export const ANSWER_CLIP = 240;
/** User note clip: ~2-3 sentences of intent; the rest stays reachable via recall `#N`. */
export const NOTE_CLIP = 300;

interface ParsedAnswer {
  question: string;
  selected: string[];
  answer?: string;
  notes: string[];
}
interface Parsed {
  answers: ParsedAnswer[];
  globalNote?: string;
}

const flat = (s: string): string =>
  s
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const fromDetails = (d: unknown): Parsed | undefined => {
  if (!d || typeof d !== "object") return;
  const r = d as { cancelled?: boolean; answers?: unknown; globalNote?: unknown };
  if (r.cancelled) return { answers: [] };
  if (!Array.isArray(r.answers)) return;
  const answers: ParsedAnswer[] = [];
  for (const a of r.answers as Record<string, any>[]) {
    if (!a || typeof a.question !== "string") continue;
    const selected = Array.isArray(a.selected)
      ? a.selected.filter((x: unknown) => typeof x === "string")
      : [];
    const notes: string[] = [];
    if (typeof a.notes === "string" && a.notes.trim()) notes.push(a.notes);
    for (const n of Array.isArray(a.optionNotes) ? a.optionNotes : []) {
      if (n && selected.includes(n.label) && typeof n.notes === "string" && n.notes.trim())
        notes.push(`note on ${n.label}: ${n.notes}`);
    }
    answers.push({
      question: a.question,
      selected,
      answer: typeof a.answer === "string" && a.answer.trim() ? a.answer : undefined,
      notes,
    });
  }
  return {
    answers,
    globalNote: typeof r.globalNote === "string" && r.globalNote.trim() ? r.globalNote : undefined,
  };
};

const HEADER_RE = /^\d+\. (.+)$/;
const STATUS_RE = /^(?:Selected: |Answer: |No option selected\.)/;
const OPTION_NOTES_RE = /^Notes for (.+) \((selected|not selected)\):$/;

/** Parse the ask_user_question text result when structured `details` is unavailable. */
const fromText = (text: string): Parsed | undefined => {
  if (!text.startsWith("User answers:")) return; // cancelled / error text → nothing
  const lines = text.split("\n");
  const answers: ParsedAnswer[] = [];
  let cur: ParsedAnswer | undefined;
  // What the current free-text body belongs to.
  let mode: "none" | "preview" | "notes" | "optnote" | "skip" | "global" = "none";
  let optLabel = "";
  let buf: string[] = [];
  let globalNote: string | undefined;
  const flush = () => {
    const body = buf.join("\n").trim();
    buf = [];
    if (!body) return;
    if (mode === "notes" && cur) cur.notes.push(body);
    else if (mode === "optnote" && cur) cur.notes.push(`note on ${optLabel}: ${body}`);
    else if (mode === "global") globalNote = body;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const header = HEADER_RE.exec(line);
    // A numbered line is a question only when a status line follows; notes may contain "2. foo".
    if (
      header &&
      (mode === "none" || lines[i - 1]?.trim() === "") &&
      STATUS_RE.test(lines[i + 1] ?? "")
    ) {
      flush();
      cur = { question: header[1], selected: [], notes: [] };
      answers.push(cur);
      mode = "none";
      continue;
    }
    if (!cur) continue;
    if (mode === "none") {
      if (line.startsWith("Selected: ")) {
        cur.selected = line
          .slice(10)
          .split(", ")
          .map((s) => s.trim())
          .filter(Boolean);
        mode = "none";
        continue;
      }
      if (line.startsWith("Answer: ") || line.startsWith("Custom answer: ")) {
        cur.answer = line.slice(line.indexOf(": ") + 2);
        mode = "none";
        continue;
      }
    }
    if (line === "Selected preview:") {
      flush();
      mode = "preview";
      continue;
    }
    if (line === "User notes:") {
      flush();
      mode = "notes";
      continue;
    }
    if (line === "Global note:") {
      flush();
      mode = "global";
      continue;
    }
    const on = OPTION_NOTES_RE.exec(line);
    if (on) {
      flush();
      mode = on[2] === "selected" ? "optnote" : "skip";
      optLabel = on[1];
      continue;
    }
    if (/^Attached images: \d+$/.test(line) || line.startsWith("Questions without an answer:")) {
      flush();
      mode = "skip";
      continue;
    }
    if (mode === "notes" || mode === "optnote" || mode === "global") buf.push(line);
  }
  flush();
  return { answers, globalNote };
};

/**
 * Deterministic user decisions from `ask_user_question` results. Selected
 * labels and custom answers are verbatim (clipped only against abuse); notes
 * are verbatim, flattened to one line, clipped and labelled "user note".
 * Option descriptions and previews are never emitted. Newest wins at the cap.
 */
type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined;
const asString = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v : undefined;
const asStrings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const renderDecision = (
  question: string,
  selected: string[],
  answer?: string,
  notes: string[] = [],
): string | undefined => {
  let value = selected.join(", ") || answer || "";
  if (selected.length && answer) value += `; custom: ${answer}`;
  const note = flat(notes.join(" / "));
  if (!value && !note) return;
  if (!value && note) value = "(no option selected)";
  let line = `User decided: ${clip(flat(question), QUESTION_CLIP)} → ${clip(flat(value), ANSWER_CLIP)}`;
  if (note) line += ` — user note: ${clip(note, NOTE_CLIP)}`;
  return line;
};
export type DecisionProjection = { lines: string[]; status?: string };

function projectOther(name: string, d: Obj): DecisionProjection {
  const lines: string[] = [];
  if (name === "ask" && d.timedOut === true)
    return { lines, status: "automatic timeout selection ignored as user intent." };
  if (name === "ask" && d.chatRedirect === true)
    return { lines, status: "chat redirect; answer-shaped text is not a confirmed choice." };
  if (d.cancelled === true || d.kind === "cancelled")
    return { lines, status: "cancelled; answer-shaped text is not a confirmed choice." };
  if (d.error !== undefined || d.kind === "error" || d.isError === true)
    return { lines, status: "error; answer-shaped text is not a confirmed choice." };
  if (name === "ask_user" && d.mode === "elaborate")
    return { lines, status: "elaboration request; answer-shaped text is not a confirmed choice." };
  if (name === "ask_user" && d.mode === "submit" && Array.isArray(d.questions)) {
    const answers = asObj(d.answers);
    for (const raw of d.questions) {
      const q = asObj(raw);
      const a = asObj(answers?.[String(q?.id)]);
      if (!q || !a || typeof q.prompt !== "string") continue;
      const values = asStrings(a.values);
      const selected = asStrings(a.labels);
      const notes: string[] = [];
      if (typeof a.note === "string" && a.note.trim()) notes.push(a.note);
      const optionNotes = asObj(a.optionNotes);
      if (optionNotes)
        for (const [key, value] of Object.entries(optionNotes))
          if (typeof value === "string" && value.trim())
            notes.push(
              `note on ${values.includes(key) ? "selected" : "unselected"} option value ${key}: ${value}`,
            );
      const line = renderDecision(q.prompt, selected, asString(a.customText), notes);
      if (line) lines.push(line);
    }
    return { lines };
  }
  if (
    name === "ask_user" &&
    d.kind === "batch" &&
    Array.isArray(d.questions) &&
    Array.isArray(d.answers)
  ) {
    d.questions.forEach((raw, i) => {
      const q = asObj(raw);
      const a = Array.isArray(d.answers) ? asObj(d.answers[i]) : undefined;
      const response = asObj(a?.response);
      if (!q || a?.status !== "answered" || !response) return;
      const question = asString(q.question) ?? asString(q.prompt);
      if (!question) return;
      const selected = response.kind === "selection" ? asStrings(response.selections) : [];
      const custom = response.kind === "freeform" ? asString(response.text) : undefined;
      const comment = asString(response.comment);
      const line = renderDecision(question, selected, custom, comment ? [comment] : []);
      if (line) lines.push(line);
    });
    return { lines };
  }
  if (name === "ask_user" && d.question !== undefined && asObj(d.response)) {
    const q = asString(d.question);
    const r = asObj(d.response);
    if (!q || !r) return { lines };
    if (["cancelled", "timed_out", "end_turn", "new_session"].includes(String(r.kind)))
      return {
        lines,
        status:
          r.kind === "timed_out"
            ? "automatic timeout selection ignored as user intent."
            : "control or cancellation result; answer-shaped text is not a confirmed choice.",
      };
    if (["selection", "combined", "freeform"].includes(String(r.kind))) {
      const selected = asStrings(r.selections);
      const custom = asString(r.text);
      if (selected.length || custom) {
        const comment = asString(r.comment);
        const line = renderDecision(q, selected, custom, comment ? [comment] : []);
        if (line) lines.push(line);
      }
    }
    return { lines };
  }
  if (
    name === "ask_user" &&
    (d.outcome === "submitted" || d.outcome === "needs_discussion") &&
    Array.isArray(d.questions) &&
    Array.isArray(d.responses)
  ) {
    const questions = new Map<string, Obj>();
    for (const raw of d.questions) {
      const q = asObj(raw);
      if (q && typeof q.id === "string") questions.set(q.id, q);
    }
    for (const raw of d.responses) {
      const r = asObj(raw);
      const answer = asObj(r?.answer);
      const q = questions.get(String(r?.questionId));
      if (
        !r ||
        answer?.answered !== true ||
        !q ||
        !["choice", "text"].includes(String(answer.kind))
      )
        continue;
      const notes: string[] = [];
      if (typeof r.questionComment === "string" && r.questionComment.trim())
        notes.push(r.questionComment);
      const selected: string[] = [];
      if (Array.isArray(answer.options))
        for (const rawOption of answer.options) {
          const o = asObj(rawOption);
          if (!o) continue;
          const label = asString(o.label) ?? asString(o.value);
          if (!label) continue;
          if (o.selected === true) selected.push(label);
          if (typeof o.comment === "string" && o.comment.trim())
            notes.push(
              `note on ${o.selected === true ? "selected" : "unselected"} option ${label}: ${o.comment}`,
            );
        }
      if (d.outcome === "needs_discussion")
        notes.push("form status: needs discussion before a complete decision");
      const question = asString(q.prompt) ?? asString(q.header);
      if (!question) continue;
      const line = renderDecision(
        question,
        selected,
        answer.kind === "text" ? asString(answer.value) : undefined,
        notes,
      );
      if (line) lines.push(line);
    }
    const formComment = asString(d.comment);
    if (formComment) lines.push(`User note (global): ${clip(flat(formComment), NOTE_CLIP)}`);
    return { lines };
  }
  if (name === "ask") {
    let timedOut = false;
    let chatRedirect = false;
    const results = Array.isArray(d.results) ? d.results : [d];
    for (const raw of results) {
      const r = asObj(raw);
      if (!r) continue;
      if (r.chatRedirect === true) {
        chatRedirect = true;
        continue;
      }
      if (r.timedOut === true) {
        timedOut = true;
        continue;
      }
      const q = asString(r.question);
      if (!q) continue;
      const selected = asStrings(r.selectedOptions);
      const custom = asString(r.customInput);
      const notes = typeof r.note === "string" && r.note.trim() ? [r.note] : [];
      const chosen = selected.length
        ? selected
        : r.multi === true && Array.isArray(r.selectedOptions)
          ? ["(selected none)"]
          : [];
      if (chosen.length || custom) {
        const line = renderDecision(q, chosen, custom, notes);
        if (line) lines.push(line);
      }
    }
    if (timedOut) return { lines, status: "automatic timeout selection ignored as user intent." };
    if (chatRedirect)
      return { lines, status: "chat redirect; answer-shaped text is not a confirmed choice." };
    return { lines };
  }
  return {
    lines,
    status: "unrecognized question result; raw answer-shaped text is not confirmed intent.",
  };
}

export function projectUserDecision(
  block: Extract<NormalizedBlock, { kind: "tool_result" }>,
): DecisionProjection {
  if (!ASK_TOOL_NAMES.has(block.name)) return { lines: [] };
  if (block.isError)
    return { lines: [], status: "error; answer-shaped text is not a confirmed choice." };
  const d = asObj(block.details);
  if (block.name !== ASK_TOOL)
    return d
      ? projectOther(block.name, d)
      : {
          lines: [],
          status: "unrecognized question result; raw answer-shaped text is not confirmed intent.",
        };
  if (d?.cancelled === true)
    return { lines: [], status: "cancelled; answer-shaped text is not a confirmed choice." };
  if (d?.error !== undefined)
    return { lines: [], status: "error; answer-shaped text is not a confirmed choice." };
  if (!fromDetails(block.details) && block.text.startsWith("User has answered your questions:")) {
    const match =
      /^User has answered your questions: (.+)\. You can now continue with the user's answers in mind\.$/.exec(
        block.text,
      );
    if (match && !/unanswered:|global note:|preview:/i.test(match[1])) {
      const pairs = [...match[1].matchAll(/"([^"\n]+)"="([^"\n]*)"/g)];
      const residue = match[1].replace(/"([^"\n]+)"="([^"\n]*)"/g, "").replace(/[;,.\s]+/g, "");
      const exactMultiEnvelope = /^\s*(?:"[^"\n]+"="[^"\n]*"\.?\s*)+$/.test(match[1]);
      if (pairs.length && exactMultiEnvelope && !residue)
        return {
          lines: pairs.map((p) => renderDecision(p[1], [p[2]])).filter((x): x is string => !!x),
        };
      return {
        lines: [],
        status: "ambiguous question result; raw answer-shaped text is not confirmed intent.",
      };
    }
  }
  const parsed = fromDetails(block.details) ?? fromText(block.text);
  if (!parsed)
    return {
      lines: [],
      status: ASK_TOOL_NAMES.has(block.name)
        ? "unrecognized question result; raw answer-shaped text is not confirmed intent."
        : undefined,
    };
  const lines = parsed.answers
    .map((a) => renderDecision(a.question, a.selected, a.answer, a.notes))
    .filter((x): x is string => !!x);
  if (parsed.globalNote)
    lines.push(`User note (global): ${clip(flat(parsed.globalNote), NOTE_CLIP)}`);
  return { lines };
}

export const extractUserDecisions = (blocks: NormalizedBlock[]): string[] => {
  const out: string[] = [];
  for (const b of blocks) if (b.kind === "tool_result") out.push(...projectUserDecision(b).lines);
  return out.slice(-MAX_DECISIONS);
};
