import { describe, expect, it } from "vitest";
import { normalizeReasoningMode } from "../normalize-reasoning-mode";

describe("normalizeReasoningMode", () => {
	// The frontend's user-facing modes ("lite" | "balanced" | "deep" | "planner")
	// must collapse onto the backend's vocabulary ("lite" | "balanced" | "pro")
	// before the workflow input is built. Without this, "deep" silently falls
	// through to the activity's COMPLEX/medium default and the user never gets
	// a REASONING-class model.

	it.each([
		["lite", "lite"],
		["balanced", "balanced"],
		["deep", "pro"], // ← the fix
		["planner", "pro"], // ← planner is also a reasoning-style flow
	] as const)("maps %s -> %s", (input, expected) => {
		expect(normalizeReasoningMode(input)).toBe(expected);
	});

	it("falls back to balanced for unknown values (defense in depth)", () => {
		expect(normalizeReasoningMode("nonsense" as never)).toBe("balanced");
	});

	it("falls back to balanced for undefined input", () => {
		expect(normalizeReasoningMode(undefined)).toBe("balanced");
	});
});
