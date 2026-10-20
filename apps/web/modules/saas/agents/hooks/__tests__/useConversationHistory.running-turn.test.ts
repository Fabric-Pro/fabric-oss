/**
 * A conversation read while one of its turns is still running shows that
 * turn's question only (the server's `inProgress` record). The detail query
 * reads it again until the finished turn replaces the record, and stops then.
 */
import { describe, expect, it } from "vitest";
import { hasRunningTurn } from "../useConversationHistory";

const detail = (executions: unknown) => ({
	metadata: { mode: "orchestrator", executions },
});

describe("hasRunningTurn", () => {
	it("is true while the read shows a turn still running", () => {
		expect(
			hasRunningTurn(
				detail([
					{ id: "done", finalResponse: "Earlier answer" },
					{ id: "running", inProgress: true },
				]),
			),
		).toBe(true);
	});

	it("is false once every turn has its result", () => {
		expect(
			hasRunningTurn(detail([{ id: "done", finalResponse: "Answer" }])),
		).toBe(false);
	});

	it("is false for a conversation with no records, no metadata or none at all", () => {
		expect(hasRunningTurn(detail(undefined))).toBe(false);
		expect(hasRunningTurn({ metadata: null })).toBe(false);
		expect(hasRunningTurn(null)).toBe(false);
	});
});
