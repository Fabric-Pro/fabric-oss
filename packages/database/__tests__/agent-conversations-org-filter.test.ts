/**
 * `buildOrgFilter` used to treat `undefined` as "legacy: match by userId only",
 * which let a caller in one tenant context read, append to, archive or delete
 * the same user's conversations from another organization. It now collapses to
 * the personal scope (`organizationId: null`), the XOR shape the rest of the
 * file enforces. These tests pin the where-clause each entry point builds.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findFirst: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		agentConversation: {
			findFirst: mocks.findFirst,
			update: vi.fn(),
			delete: vi.fn(),
		},
	},
}));

import {
	deleteAgentConversation,
	getAgentConversationById,
	updateAgentConversation,
} from "../prisma/queries/agent-conversations";

function firstWhere() {
	return mocks.findFirst.mock.calls[0]?.[0]?.where;
}

describe("agent conversation org filter", () => {
	beforeEach(() => {
		mocks.findFirst.mockReset();
		mocks.findFirst.mockResolvedValue(null);
	});

	it("scopes a lookup to the organization when one is given", async () => {
		await getAgentConversationById({
			id: "conv-1",
			userId: "user-1",
			organizationId: "org-a",
		});
		expect(firstWhere()).toMatchObject({
			id: "conv-1",
			userId: "user-1",
			organizationId: "org-a",
		});
	});

	it("collapses an omitted organization to the personal scope instead of matching any tenant", async () => {
		await getAgentConversationById({ id: "conv-1", userId: "user-1" });
		const where = firstWhere();
		expect(where).toMatchObject({ id: "conv-1", userId: "user-1" });
		expect(where.organizationId).toBeNull();
	});

	it("treats an explicit null the same as omitted", async () => {
		await getAgentConversationById({
			id: "conv-1",
			userId: "user-1",
			organizationId: null,
		});
		expect(firstWhere().organizationId).toBeNull();
	});

	it("does not update a conversation from another tenant when the organization is omitted", async () => {
		await expect(
			updateAgentConversation({
				id: "conv-1",
				userId: "user-1",
				title: "renamed",
			}),
		).rejects.toThrow(/not found or access denied/);
		expect(firstWhere().organizationId).toBeNull();
	});

	it("does not delete a conversation from another tenant when the organization is omitted", async () => {
		await expect(
			deleteAgentConversation({ id: "conv-1", userId: "user-1" }),
		).rejects.toThrow(/not found or access denied/);
		expect(firstWhere().organizationId).toBeNull();
	});
});
