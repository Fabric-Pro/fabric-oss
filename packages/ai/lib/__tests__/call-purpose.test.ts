import { describe, expect, it } from "vitest";
import { AI_CALL_PURPOSES } from "../call-purpose";

describe("operation purpose vocabulary", () => {
	it("reserves engine prefixes for the Direct main step", () => {
		expect(
			Object.values(AI_CALL_PURPOSES).filter((purpose) =>
				/^(direct|orchestrator)-/.test(purpose),
			),
		).toEqual(["direct-main"]);
	});

	it("rejects product prefixes in the closed set", () => {
		expect(
			Object.values(AI_CALL_PURPOSES).filter((purpose) =>
				/^(advisor|report|parlume|weave|fabric)-/.test(purpose),
			),
		).toEqual([]);
	});
});
