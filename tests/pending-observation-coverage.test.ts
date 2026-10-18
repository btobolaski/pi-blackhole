import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { agentDir } = vi.hoisted(() => {
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  return { agentDir: join(tmpdir(), `pi-blackhole-pending-coverage-${process.pid}`) };
});

vi.mock("@earendil-works/pi-coding-agent", () => ({ getAgentDir: () => agentDir }));

import { readPendingState, savePendingObservationCoverage } from "../src/om/pending.js";

const pendingPath = () => join(agentDir, "pi-blackhole", "coverage-test-pending.json");

beforeEach(() => mkdirSync(join(agentDir, "pi-blackhole"), { recursive: true }));
afterEach(() => rmSync(agentDir, { recursive: true, force: true }));

describe("pending delivered coverage validation", () => {
  it("rejects unknown observation batch custom types before flush", () => {
    writeFileSync(
      pendingPath(),
      JSON.stringify({
        observationBatches: [
          {
            coversUpToId: "source-1",
            customType: "foreign-custom-entry",
            data: { coversFromId: "source-1", coversUpToId: "source-1" },
          },
        ],
      }),
    );

    expect(readPendingState("coverage-test").observationBatches).toEqual([]);
  });

  it("keeps a legacy single observation when appending empty coverage", () => {
    const priorObservation = {
      coversUpToId: "source-0",
      data: {
        observations: [
          {
            id: "aaaaaaaaaaaa",
            content: "legacy pending fact",
            timestamp: "2026-05-02 10:00",
            relevance: "medium",
            sourceEntryIds: ["source-0"],
            tokenCount: 4,
          },
        ],
        coversUpToId: "source-0",
      },
    };
    writeFileSync(pendingPath(), JSON.stringify({ observation: priorObservation }));

    savePendingObservationCoverage("coverage-test", {
      coversUpToId: "source-1",
      data: { coversFromId: "source-1", coversUpToId: "source-1" },
    });

    expect(readPendingState("coverage-test").observationBatches).toEqual([
      priorObservation,
      {
        coversUpToId: "source-1",
        data: { coversFromId: "source-1", coversUpToId: "source-1" },
        customType: "om.observations.coverage",
      },
    ]);
  });
});
