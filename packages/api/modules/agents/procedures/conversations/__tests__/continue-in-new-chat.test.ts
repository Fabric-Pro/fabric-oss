/**
 * "Continue in my own chat" runs in the organization the request names, as a
 * member of it, and only ever creates a chat for the caller.
 *
 * The parent can be another member's session shared with that organization, so
 * the organization must be checked as the caller's own (not trusted from the
 * input), and a request that names none is refused. A parent the caller cannot
 * read is NOT_FOUND.
 *
 * Run with: pnpm --filter @repo/api test modules/agents/procedures/conversations/__tests__/continue-in-new-chat.test.ts
 */

import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	handlers,
	mockContinue,
	mockRequireInputOrgPermission,
	ParentNotFound,
	SummaryRequired,
} = vi.hoisted(() => ({
	handlers: {} as Record<string, (...args: unknown[]) => unknown>,
	mockContinue: vi.fn(),
	mockRequireInputOrgPermission: vi.fn(() => (c: unknown) => c),
	ParentNotFound: class ParentConversationNotFoundError extends Error {},
	SummaryRequired: class CarriedOverSummaryRequiredError extends Error {},
}));

vi.mock("@repo/database", () => ({
	continueConversationInNewChat: mockContinue,
	ParentConversationNotFoundError: ParentNotFound,
	CarriedOverSummaryRequiredError: SummaryRequired,
}));

vi.mock("../../../../../orpc/procedures", () => {
	let current = "";
	const chainable: any = {
		use: () => chainable,
		route: (route: { path: string }) => {
			current = route.path;
			return chainable;
		},
		input: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers[current] = fn;
			return { _handler: fn };
		},
	};
	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireInputOrgPermission: mockRequireInputOrgPermission,
		resolveOrganizationId: vi.fn(
			(
				organizationId: string | null | undefined,
				session: { activeOrganizationId?: string | null },
			) =>
				organizationId ??
				(organizationId === null
					? undefined
					: (session.activeOrganizationId ?? undefined)),
		),
	};
});

import "../continue-in-new-chat";

const PATH = "/agents/conversations/continue-in-new-chat";

const run = (
	input: Record<string, unknown> = {},
	session: { activeOrganizationId?: string | null } = {
		activeOrganizationId: "org-1",
	},
) =>
	handlers[PATH]({
		input: {
			parentConversationId: "parent-1",
			summary: "so far",
			...input,
		},
		context: { user: { id: "user-1" }, session },
	});

const now = new Date("2026-10-15T00:00:00Z");

beforeEach(() => {
	mockContinue.mockReset();
	mockContinue.mockResolvedValue({
		id: "new-1",
		agentId: "fabric-workspace-assistant",
		title: "Review (continued)",
		parentConversationId: "parent-1",
		createdAt: now,
	});
});

describe("agents.conversations.continueInNewChat", () => {
	it("is authorized against the organization in the input, and refuses a request that names none", () => {
		expect(mockRequireInputOrgPermission).toHaveBeenCalledWith(
			"AGENT_CREATE",
			{ requireOrganization: true },
		);
	});

	it("continues in the organization the request names, as the caller", async () => {
		const result = await run({ organizationId: "org-9" });

		expect(mockContinue).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-9",
			parentConversationId: "parent-1",
			ownSummary: "so far",
			title: undefined,
		});
		expect(result).toMatchObject({
			id: "new-1",
			parentConversationId: "parent-1",
		});
	});

	it("falls back to the session's organization", async () => {
		await run();

		expect(mockContinue).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: "org-1" }),
		);
	});

	it("refuses a request that resolves no organization before reading anything", async () => {
		const failure = await run({ organizationId: null }).then(
			() => null,
			(e: unknown) => e,
		);

		expect(failure).toBeInstanceOf(ORPCError);
		expect((failure as ORPCError<string, unknown>).code).toBe("FORBIDDEN");
		expect(mockContinue).not.toHaveBeenCalled();
	});

	it("answers a parent the caller cannot read with NOT_FOUND", async () => {
		mockContinue.mockRejectedValue(new ParentNotFound("hidden"));

		const failure = await run().then(
			() => null,
			(e: unknown) => e,
		);

		expect(failure).toBeInstanceOf(ORPCError);
		expect((failure as ORPCError<string, unknown>).code).toBe("NOT_FOUND");
	});

	it("passes on no summary when the request sends none, which is enough for a session another member shared", async () => {
		await run({ summary: undefined });

		expect(mockContinue).toHaveBeenCalledWith(
			expect.objectContaining({ ownSummary: undefined }),
		);
	});

	it("answers a missing summary for the caller's own conversation with BAD_REQUEST", async () => {
		mockContinue.mockRejectedValue(new SummaryRequired("needs summary"));

		const failure = await run({ summary: undefined }).then(
			() => null,
			(e: unknown) => e,
		);

		expect(failure).toBeInstanceOf(ORPCError);
		expect((failure as ORPCError<string, unknown>).code).toBe(
			"BAD_REQUEST",
		);
	});

	it("lets any other failure through", async () => {
		const failure = new Error("database down");
		mockContinue.mockRejectedValue(failure);

		await expect(run()).rejects.toBe(failure);
	});
});
