/**
 * Who may stand a tier's default down.
 *
 * Clearing an override is the same authority as setting one: it changes which
 * prompt every user at and below that tier gets. A gate that only guarded the
 * write would let any member reach the same outcome by removing the admin's row
 * instead of replacing it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { clearPromptBinding, requireOrganizationAdmin } = vi.hoisted(() => ({
	clearPromptBinding: vi.fn(),
	requireOrganizationAdmin: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	listPromptDefaultAudience: vi.fn().mockResolvedValue([]),
	markOwnOverrides: vi.fn().mockResolvedValue([]),
	clearPromptBinding,
	bindPromptVersion: vi.fn(),
	listPromptsForStages: vi.fn(),
	db: { promptVersion: { findUnique: vi.fn() } },
}));

vi.mock("../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: vi.fn(),
}));

// Binding announces the change to whoever is subject to it; not under test here.
vi.mock("../../../lib/notification-service", () => ({
	fanOut: { promptDefaultUpdated: vi.fn() },
}));

vi.mock("../../../orpc/procedures", () => ({
	Permissions: { PROMPT_READ: "prompt:read", PROMPT_UPDATE: "prompt:update" },
	requirePermission: () => (next: unknown) => next,
	requireInputOrgPermission: () => (next: unknown) => next,
	requireOrganizationAdmin,
	resolveOrganizationId: (
		input: string | null | undefined,
		_session: unknown,
	) => input ?? null,
	tenantProtectedProcedure: {
		use: () => ({
			route: () => ({
				input: () => ({
					output: () => ({ handler: (fn: unknown) => fn }),
				}),
			}),
		}),
	},
}));

import { bindProcedures } from "../procedures/bind";

const callClear = (args: {
	scope: "SYSTEM" | "ORG" | "USER";
	organizationId?: string | null;
	role?: string | null;
}) =>
	(bindProcedures.clear as (a: unknown) => Promise<unknown>)({
		input: {
			targetType: "AGENT",
			targetKey: "test_case_drafter",
			documentType: "GENERAL",
			storyKind: null,
			scope: args.scope,
			organizationId: args.organizationId ?? null,
		},
		context: {
			user: { id: "user-1", role: args.role ?? null },
			session: {},
		},
	});

describe("prompts.bind.clear authorization by scope", () => {
	beforeEach(() => {
		clearPromptBinding.mockReset();
		clearPromptBinding.mockResolvedValue({ cleared: true });
		requireOrganizationAdmin.mockReset();
		requireOrganizationAdmin.mockResolvedValue(undefined);
	});

	it("refuses to clear the universal default for a non-platform-admin", async () => {
		await expect(callClear({ scope: "SYSTEM" })).rejects.toThrow(
			/platform admin/i,
		);
		expect(clearPromptBinding).not.toHaveBeenCalled();
	});

	it("lets a platform admin clear the universal default", async () => {
		await callClear({ scope: "SYSTEM", role: "admin" });
		expect(clearPromptBinding).toHaveBeenCalledWith(
			expect.objectContaining({ scope: "SYSTEM" }),
		);
	});

	it("requires org admin to clear an organization override", async () => {
		requireOrganizationAdmin.mockRejectedValue(new Error("FORBIDDEN"));

		await expect(
			callClear({ scope: "ORG", organizationId: "org-1" }),
		).rejects.toThrow();
		expect(requireOrganizationAdmin).toHaveBeenCalledWith(
			"org-1",
			"user-1",
		);
		expect(clearPromptBinding).not.toHaveBeenCalled();
	});

	it("rejects clearing an org override with no organization in context", async () => {
		await expect(
			callClear({ scope: "ORG", organizationId: null }),
		).rejects.toThrow(/organization/i);
		expect(clearPromptBinding).not.toHaveBeenCalled();
	});

	it("lets any user clear their own personal override", async () => {
		await callClear({ scope: "USER" });
		expect(requireOrganizationAdmin).not.toHaveBeenCalled();
		expect(clearPromptBinding).toHaveBeenCalledWith(
			expect.objectContaining({ scope: "USER", userId: "user-1" }),
		);
	});

	it("scopes a personal clear to the caller, never a supplied id", async () => {
		// The identity comes from the session; nothing in the input can point
		// this at somebody else's override.
		await callClear({ scope: "USER" });
		const arg = clearPromptBinding.mock.calls[0][0];
		expect(arg.userId).toBe("user-1");
		expect(arg.organizationId).toBeUndefined();
	});

	it("reports when there was nothing to clear", async () => {
		clearPromptBinding.mockResolvedValue({ cleared: false });
		const result = (await callClear({ scope: "USER" })) as {
			cleared: boolean;
		};
		expect(result.cleared).toBe(false);
	});
});
