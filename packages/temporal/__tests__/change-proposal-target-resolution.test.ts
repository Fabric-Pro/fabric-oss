import { describe, expect, it } from "vitest";
import { z } from "zod";
import { backlogChangeItemSchema } from "../src/activities/backlog-context/analyze-context";

const fullProposalSchema = z.object({
	changes: z.array(backlogChangeItemSchema),
});

describe("backlogChangeItemSchema.targetResolution", () => {
	it("accepts a change carrying a resolved targetResolution", () => {
		const parsed = fullProposalSchema.parse({
			changes: [
				{
					type: "feature",
					action: "update",
					title: { to: "X" },
					reasoning: "r",
					sourceContext: "teams_messages",
					targetResolution: {
						status: "resolved",
						resolvedBy: "identifier",
						resolvedIdentifier: "F-2",
						resolvedTitle: "Signup page",
					},
				},
			],
		});
		expect(parsed.changes[0].targetResolution?.status).toBe("resolved");
	});

	it("defaults targetResolution to undefined when omitted", () => {
		const parsed = fullProposalSchema.parse({
			changes: [
				{
					type: "bug",
					action: "create",
					title: { to: "Y" },
					reasoning: "r",
					sourceContext: "slack_messages",
				},
			],
		});
		expect(parsed.changes[0].targetResolution).toBeUndefined();
	});
});
