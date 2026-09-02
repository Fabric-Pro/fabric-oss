/**
 * Binding one prompt to several actions at once (FR19).
 *
 * The gates are the same as the single bind's, and share the same helpers — a
 * second write path with a weaker gate is exactly how the SYSTEM hole would
 * have come back. These assert that the new path refuses everything the old one
 * refuses, rather than assuming the shared helper is enough.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	bindPromptVersionToTargets,
	promptVersionFindUnique,
	requireOrganizationAdmin,
} = vi.hoisted(() => ({
	bindPromptVersionToTargets: vi.fn(),
	promptVersionFindUnique: vi.fn(),
	requireOrganizationAdmin: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	listPromptDefaultAudience: vi.fn().mockResolvedValue([]),
	markOwnOverrides: vi.fn().mockResolvedValue([]),
	bindPromptVersionToTargets,
	bindPromptVersion: vi.fn(),
	clearPromptBinding: vi.fn(),
	listActionsForPrompt: vi.fn(),
	listPromptsForStages: vi.fn(),
	db: { promptVersion: { findUnique: promptVersionFindUnique } },
}));

vi.mock("../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: vi.fn(),
}));

// Binding announces the change to whoever is subject to it. Not what these
// tests are about, and importing the real service drags its whole dependency
// graph into the module under test.
vi.mock("../../../lib/notification-service", () => ({
	fanOut: { promptDefaultUpdated: vi.fn() },
}));

vi.mock("../../../orpc/procedures", () => ({
	Permissions: { PROMPT_READ: "prompt:read", PROMPT_UPDATE: "prompt:update" },
	requirePermission: () => (n: unknown) => n,
	requireInputOrgPermission: () => (n: unknown) => n,
	requireOrganizationAdmin,
	resolveOrganizationId: (i: string | null | undefined) => i ?? null,
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

const TWO_TARGETS = [
	{
		targetType: "AGENT" as const,
		targetKey: "test_case_drafter",
		documentType: "GENERAL",
		storyKind: null,
	},
	{
		targetType: "AGENT" as const,
		targetKey: "test_case_step_reviser",
		documentType: "GENERAL",
		storyKind: null,
	},
];

const callSetMany = (args: {
	scope: "SYSTEM" | "ORG" | "USER";
	organizationId?: string | null;
	role?: string | null;
	targets?: typeof TWO_TARGETS;
}) =>
	(bindProcedures.setMany as (a: unknown) => Promise<unknown>)({
		input: {
			targets: args.targets ?? TWO_TARGETS,
			scope: args.scope,
			organizationId: args.organizationId ?? null,
			promptVersionId: "pv-1",
			isDefault: true,
		},
		context: {
			user: { id: "user-1", role: args.role ?? null },
			session: {},
		},
	});

describe("prompts.bind.setMany", () => {
	beforeEach(() => {
		bindPromptVersionToTargets.mockReset();
		bindPromptVersionToTargets.mockResolvedValue({ bound: 2 });
		promptVersionFindUnique.mockReset();
		promptVersionFindUnique.mockResolvedValue({
			scope: "SYSTEM",
			userId: null,
			organizationId: null,
		});
		requireOrganizationAdmin.mockReset();
		requireOrganizationAdmin.mockResolvedValue(undefined);
	});

	it("binds every target in one call", async () => {
		await callSetMany({ scope: "SYSTEM", role: "admin" });

		expect(bindPromptVersionToTargets).toHaveBeenCalledWith(
			expect.objectContaining({
				scope: "SYSTEM",
				promptVersionId: "pv-1",
				targets: expect.arrayContaining([
					expect.objectContaining({ targetKey: "test_case_drafter" }),
					expect.objectContaining({
						targetKey: "test_case_step_reviser",
					}),
				]),
			}),
		);
	});

	it("refuses the universal tier for a non-platform-admin", async () => {
		await expect(callSetMany({ scope: "SYSTEM" })).rejects.toThrow(
			/platform admin/i,
		);
		expect(bindPromptVersionToTargets).not.toHaveBeenCalled();
	});

	it("requires org admin for the organization tier", async () => {
		requireOrganizationAdmin.mockRejectedValue(new Error("FORBIDDEN"));

		await expect(
			callSetMany({ scope: "ORG", organizationId: "org-1" }),
		).rejects.toThrow();
		expect(bindPromptVersionToTargets).not.toHaveBeenCalled();
	});

	it("rejects the organization tier with no organization in context", async () => {
		await expect(
			callSetMany({ scope: "ORG", organizationId: null }),
		).rejects.toThrow(/organization is required/i);
		expect(bindPromptVersionToTargets).not.toHaveBeenCalled();
	});

	it("refuses to back a universal default with a personal prompt", async () => {
		promptVersionFindUnique.mockResolvedValue({
			scope: "USER",
			userId: "user-1",
			organizationId: null,
		});

		await expect(
			callSetMany({ scope: "SYSTEM", role: "admin" }),
		).rejects.toThrow(/system-scoped prompt/i);
		expect(bindPromptVersionToTargets).not.toHaveBeenCalled();
	});

	it("refuses to back an org default with a personal prompt", async () => {
		promptVersionFindUnique.mockResolvedValue({
			scope: "USER",
			userId: "user-1",
			organizationId: null,
		});

		await expect(
			callSetMany({ scope: "ORG", organizationId: "org-1" }),
		).rejects.toThrow(/fork/i);
		expect(bindPromptVersionToTargets).not.toHaveBeenCalled();
	});

	it("refuses a prompt version belonging to another tenant", async () => {
		promptVersionFindUnique.mockResolvedValue({
			scope: "ORG",
			userId: null,
			organizationId: "org-SOMEONE-ELSE",
		});

		await expect(
			callSetMany({ scope: "ORG", organizationId: "org-1" }),
			// Wording follows the check moving into a shared helper that now
			// also guards nomination: "use" covers both, "bind" did not.
		).rejects.toThrow(/cannot use this prompt version/i);
		expect(bindPromptVersionToTargets).not.toHaveBeenCalled();
	});

	it("scopes a personal bind to the caller's own identity", async () => {
		promptVersionFindUnique.mockResolvedValue({
			scope: "USER",
			userId: "user-1",
			organizationId: null,
		});

		await callSetMany({ scope: "USER" });

		expect(bindPromptVersionToTargets).toHaveBeenCalledWith(
			expect.objectContaining({
				scope: "USER",
				userId: "user-1",
				organizationId: undefined,
			}),
		);
	});
});
