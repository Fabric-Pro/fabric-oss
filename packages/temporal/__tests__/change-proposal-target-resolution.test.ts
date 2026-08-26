import { describe, expect, it } from "vitest";
import { ChangeProposalSchema } from "../src/activities/backlog-context/analyze-context";

describe("ChangeProposalSchema.targetResolution", () => {
	it("accepts a change carrying a resolved targetResolution", () => {
		const parsed = ChangeProposalSchema.parse({
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
		const parsed = ChangeProposalSchema.parse({
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
