/**
 * Unit tests for the `chat-agent-selection` queries module.
 *
 * Mocks at the Prisma client boundary; exercises the org-id normalization
 * and personal-vs-org isolation behavior of the queries module without
 * touching a live database.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { findUnique, upsert, deleteFn } = vi.hoisted(() => ({
	findUnique: vi.fn(),
	upsert: vi.fn(),
	deleteFn: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		userChatAgentSelection: {
			findUnique,
			upsert,
			delete: deleteFn,
		},
	},
}));

import {
	deleteChatAgentSelection,
	getChatAgentSelection,
	upsertChatAgentSelection,
} from "../prisma/queries/chat-agent-selection";

describe("chat-agent-selection queries", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		findUnique.mockResolvedValue(null);
		upsert.mockResolvedValue({});
		deleteFn.mockResolvedValue({});
	});

	describe("getChatAgentSelection", () => {
		it("returns null when no row exists", async () => {
			const result = await getChatAgentSelection("user_a", null);
			expect(result).toBeNull();
		});

		it("normalizes null organizationId to empty string sentinel", async () => {
			await getChatAgentSelection("user_a", null);
			expect(findUnique).toHaveBeenCalledExactlyOnceWith({
				where: {
					userId_organizationId: {
						userId: "user_a",
						organizationId: "",
					},
				},
				select: { version: true, selectedAgents: true },
			});
		});

		it("normalizes undefined organizationId to empty string", async () => {
			await getChatAgentSelection("user_a");
			expect(findUnique).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({
					where: {
						userId_organizationId: {
							userId: "user_a",
							organizationId: "",
						},
					},
				}),
			);
		});

		it("passes through a real organizationId", async () => {
			await getChatAgentSelection("user_a", "org_x");
			expect(findUnique).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({
					where: {
						userId_organizationId: {
							userId: "user_a",
							organizationId: "org_x",
						},
					},
				}),
			);
		});

		it("filters out entries that fail the persisted Zod schema", async () => {
			// Mix one valid + two invalid entries; the helper should keep
			// only the valid one.
			findUnique.mockResolvedValue({
				version: 1,
				selectedAgents: [
					{ agentId: "agent_a", name: "A" },
					{ agentId: "" }, // fails .min(1)
					"scalar", // fails object check
				],
			});
			const result = await getChatAgentSelection("user_a", null);
			expect(result?.selectedAgents).toEqual([
				{ agentId: "agent_a", name: "A" },
			]);
			expect(result?.version).toBe(1);
		});

		it("treats a non-array selectedAgents column as empty (defensive)", async () => {
			findUnique.mockResolvedValue({
				version: 1,
				selectedAgents: { not: "array" },
			});
			const result = await getChatAgentSelection("user_a", null);
			expect(result?.selectedAgents).toEqual([]);
		});
	});

	describe("upsertChatAgentSelection", () => {
		it("upserts with normalized empty-string sentinel for personal scope", async () => {
			await upsertChatAgentSelection(
				"user_a",
				{ selectedAgents: [{ agentId: "agent_a", name: "A" }] },
				null,
			);

			expect(upsert).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({
					where: {
						userId_organizationId: {
							userId: "user_a",
							organizationId: "",
						},
					},
					create: expect.objectContaining({
						userId: "user_a",
						organizationId: "",
						selectedAgents: [{ agentId: "agent_a", name: "A" }],
						version: 1,
					}),
					update: expect.objectContaining({
						selectedAgents: [{ agentId: "agent_a", name: "A" }],
					}),
				}),
			);
		});

		it("upserts with the org id when in org context", async () => {
			await upsertChatAgentSelection(
				"user_a",
				{ selectedAgents: [{ agentId: "agent_a", name: "A" }] },
				"org_x",
			);

			expect(upsert).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({
					where: {
						userId_organizationId: {
							userId: "user_a",
							organizationId: "org_x",
						},
					},
					create: expect.objectContaining({
						organizationId: "org_x",
					}),
				}),
			);
		});
	});

	describe("deleteChatAgentSelection", () => {
		it("normalizes null org id to empty string sentinel", async () => {
			await deleteChatAgentSelection("user_a", null);
			expect(deleteFn).toHaveBeenCalledExactlyOnceWith({
				where: {
					userId_organizationId: {
						userId: "user_a",
						organizationId: "",
					},
				},
			});
		});

		it("swallows errors when the row does not exist", async () => {
			deleteFn.mockRejectedValue(
				new Error("Record to delete does not exist"),
			);
			await expect(
				deleteChatAgentSelection("user_a", null),
			).resolves.toBeUndefined();
		});

		it("personal vs org rows are isolated — deleting one does not touch the other", async () => {
			deleteFn.mockResolvedValue({});
			await deleteChatAgentSelection("user_a", "org_x");
			expect(deleteFn).toHaveBeenCalledExactlyOnceWith({
				where: {
					userId_organizationId: {
						userId: "user_a",
						organizationId: "org_x",
					},
				},
			});
		});
	});
});
