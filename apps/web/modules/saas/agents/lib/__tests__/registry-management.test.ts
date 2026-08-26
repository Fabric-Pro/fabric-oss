import { describe, expect, it } from "vitest";
import { computeAgentManagementView } from "../registry-management";

const items = [
	{
		id: "1",
		displayName: "System Planner",
		scope: "SYSTEM",
		status: "ACTIVE",
		conversationCount: 5,
	},
	{
		id: "2",
		displayName: "Org Analyst",
		scope: "ORGANIZATION",
		status: "ERROR",
		conversationCount: 1,
	},
	{
		id: "3",
		displayName: "Personal Helper",
		scope: "USER",
		status: "ACTIVE",
		conversationCount: 0,
	},
];

describe("computeAgentManagementView", () => {
	it("computes counts and attention buckets", () => {
		const result = computeAgentManagementView(items, "", "all");
		expect(result.counts.all).toBe(3);
		expect(result.counts.system).toBe(1);
		expect(result.counts.organization).toBe(1);
		expect(result.counts.personal).toBe(1);
		expect(result.counts.attention).toBe(2);
	});

	it("switches to search tab when query is present", () => {
		const result = computeAgentManagementView(items, "planner", "all");
		expect(result.resolvedTab).toBe("search");
		expect(result.items).toHaveLength(1);
		expect(result.items[0]?.displayName).toBe("System Planner");
	});
});
