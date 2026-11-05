import { describe, expect, it } from "vitest";
import {
	AGENT_RUN_POLL_WINDOW_MS,
	canPollAgentRun,
} from "../agent-run-polling";

describe("visible run observation policy", () => {
	it.each([
		"UNKNOWN",
		"COMPLETED",
		"FAILED",
		"CANCELLED",
		"TIMED_OUT",
		undefined,
	])(
		"does not repeatedly query an unverifiable or terminal run: %s",
		(status) => {
			expect(canPollAgentRun(status, 1000, 1001)).toBe(false);
		},
	);
	it.each(["PENDING", "RUNNING"])(
		"bounds verified %s observations and permits a fresh explicit refresh window",
		(status) => {
			expect(canPollAgentRun(status, 1000, 1001)).toBe(true);
			expect(
				canPollAgentRun(status, 1000, 1000 + AGENT_RUN_POLL_WINDOW_MS),
			).toBe(false);
			expect(
				canPollAgentRun(
					status,
					1000 + AGENT_RUN_POLL_WINDOW_MS,
					1001 + AGENT_RUN_POLL_WINDOW_MS,
				),
			).toBe(true);
		},
	);
});
