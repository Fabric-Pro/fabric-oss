import { describe, expect, it } from "vitest";
import { isWorkflowLive } from "../lib/workflow-status";

describe("isWorkflowLive", () => {
	it.each(["PUBLISHED", "ACTIVE"])(
		"treats %s as live: its schedule, webhook and run-now may start it",
		(status) => {
			expect(isWorkflowLive(status)).toBe(true);
		},
	);

	it.each(["DRAFT", "PAUSED", "ARCHIVED", "", "published"])(
		"does not treat %s as live",
		(status) => {
			expect(isWorkflowLive(status)).toBe(false);
		},
	);
});
