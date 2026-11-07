import { describe, expect, it, vi } from "vitest";

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));

vi.mock("../../client", () => ({
	db: {
		project: { findMany },
		agentTask: { findMany },
		agentConversation: { findMany },
		projectDocument: { findMany },
		prompt: { findMany },
		aiChat: { findMany },
		workflow: { findMany },
		agent: { findMany },
		skill: { findMany },
		mCPConfig: { findMany },
		sDLCPipeline: { findMany },
	},
}));

import { getOrganizationRecentActivity } from "../dashboard";

describe("getOrganizationRecentActivity", () => {
	it("uses the prompt creator and caller id for private activity", async () => {
		findMany.mockResolvedValue([]);
		await getOrganizationRecentActivity("org-1", 10, "user-1");

		const promptCall = findMany.mock.calls.find(
			([input]) => input.select?.usageCount,
		);
		expect(promptCall?.[0].where).toMatchObject({
			organizationId: "org-1",
			createdBy: "user-1",
		});
		expect(promptCall?.[0].where).not.toHaveProperty("userId");

		const conversationCall = findMany.mock.calls.find(
			([input]) => input.select?.metadata && input.select?.title,
		);
		expect(conversationCall?.[0].where).toMatchObject({
			organizationId: "org-1",
			userId: "user-1",
		});
	});
});
