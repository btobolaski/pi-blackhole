import { describe, expect, it, vi } from "vitest";
import type { UnifiedConfig } from "../src/core/unified-config.js";
import { DEFAULTS } from "../src/core/unified-config.js";

const captured = vi.hoisted(() => ({
  fields: undefined as undefined | ((cfg: UnifiedConfig) => Array<{ key: string; type: string }>),
}));
vi.mock("../src/pi-base/config-manager.js", () => ({
  ConfigManager: class {
    constructor(options: { fields: (cfg: UnifiedConfig) => Array<{ key: string; type: string }> }) {
      captured.fields = options.fields;
    }
  },
}));

describe("canonical reflection settings", () => {
  it.each(["reflectionTimestamps", "reflectionSupersedes"])(
    "registers %s as boolean",
    async (key) => {
      await import("../src/pi-base/blackhole-settings.js");
      expect(captured.fields?.(DEFAULTS).find((field) => field.key === key)?.type).toBe("boolean");
    },
  );
});
