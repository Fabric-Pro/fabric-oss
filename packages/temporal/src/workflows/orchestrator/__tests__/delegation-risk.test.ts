import { describe, expect, it } from "vitest";
import { assessToolCallRisk } from "../risk-assessment";

describe("delegation keyword provenance", () => {
	it("distinguishes quoted argument words from tool-name hits", () => {
		const result = assessToolCallRisk(
			{
				name: "delegate_to_analyst",
				args: { message: "Summarize: removed all obsolete code" },
			},
			"BALANCED",
			{ rules: "read-only-exempt-v1" },
		);
		expect(result).toMatchObject({
			requiresApproval: true,
			riskLevel: "critical",
			keywordHits: { name: [], args: ["remove", "all"] },
		});
	});
	it("retains a keyword found in both the name and arguments", () => {
		expect(
			assessToolCallRisk({
				name: "delegate_to_remove_agent",
				args: { message: "remove all" },
			}),
		).toMatchObject({
			keywordHits: { name: ["remove"], args: ["remove", "all"] },
		});
	});
});
