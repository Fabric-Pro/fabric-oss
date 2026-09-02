/**
 * Who may write a SYSTEM or ORG default binding.
 *
 * `bind.set` is gated by `requireInputOrgPermission(PROMPT_UPDATE)`, and
 * PROMPT_UPDATE belongs to MEMBER_ORG_PERMISSIONS — so before this, any member
 * of any organization could write a SYSTEM binding, which is the default every
 * tenant without an override falls back to. The `versionAccessible` check does
 * not help: it passes unconditionally for a SYSTEM prompt version, and those
 * are readable by everyone.
 *
 * These tests pin the tier gate that FR1/FR2 of card 2068 require: SYSTEM is
 * the platform admin's to set, an org default is the org admin's.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	bindPromptVersion,
	promptVersionFindUnique,
	projectFindFirst,
	requireOrganizationAdmin,
} = vi.hoisted(() => ({
	bindPromptVersion: vi.fn(),
	promptVersionFindUnique: vi.fn(),
	projectFindFirst: vi.fn(),
	requireOrganizationAdmin: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	listPromptDefaultAudience: vi.fn().mockResolvedValue([]),
	markOwnOverrides: vi.fn().mockResolvedValue([]),
	bindPromptVersion,
	listPromptsForStages: vi.fn(),
	db: {
		promptVersion: { findUnique: promptVersionFindUnique },
		project: { findFirst: projectFindFirst },
	},
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
					output: () => ({
						handler: (fn: unknown) => fn,
					}),
				}),
			}),
		}),
	},
}));

import { bindProcedures } from "../procedures/bind";

const callSet = (args: {
	scope: "SYSTEM" | "ORG" | "USER";
	isDefault?: boolean;
	organizationId?: string | null;
	projectId?: string | null;
	role?: string | null;
}) =>
	(bindProcedures.set as (a: unknown) => Promise<unknown>)({
		input: {
			targetType: "AGENT",
			targetKey: "test_case_drafter",
			documentType: "GENERAL",
			storyKind: null,
			scope: args.scope,
			organizationId: args.organizationId ?? null,
			projectId: args.projectId ?? null,
			promptVersionId: "pv-1",
			isDefault: args.isDefault ?? true,
		},
		context: {
			user: { id: "user-1", role: args.role ?? null },
			session: {},
		},
	});

describe("prompts.bind.set authorization by scope", () => {
	beforeEach(() => {
		bindPromptVersion.mockReset();
		bindPromptVersion.mockResolvedValue({ id: "binding-1" });
		promptVersionFindUnique.mockReset();
		// A SYSTEM prompt version — readable by every authenticated user, which
		// is exactly why `versionAccessible` cannot carry the tier gate.
		promptVersionFindUnique.mockResolvedValue({
			scope: "SYSTEM",
			userId: null,
			organizationId: null,
		});
		projectFindFirst.mockReset();
		projectFindFirst.mockImplementation(async ({ where }) =>
			where.id === "proj-own"
				? { id: "proj-own", organizationId: "org-1" }
				: null,
		);
		requireOrganizationAdmin.mockReset();
		requireOrganizationAdmin.mockResolvedValue(undefined);
	});

	describe("SYSTEM scope", () => {
		it("refuses a caller who is not a platform admin", async () => {
			await expect(
				callSet({ scope: "SYSTEM", role: null }),
			).rejects.toThrow(/platform admin/i);
			expect(bindPromptVersion).not.toHaveBeenCalled();
		});

		it("refuses an organization admin who is not a platform admin", async () => {
			// Member.role "admin" is a different field from User.role — an org
			// admin must not reach the setting every other tenant inherits.
			await expect(
				callSet({
					scope: "SYSTEM",
					role: "user",
					organizationId: "org-1",
				}),
			).rejects.toThrow(/platform admin/i);
			expect(bindPromptVersion).not.toHaveBeenCalled();
		});

		it("allows a platform admin", async () => {
			await callSet({ scope: "SYSTEM", role: "admin" });
			expect(bindPromptVersion).toHaveBeenCalledWith(
				expect.objectContaining({ scope: "SYSTEM" }),
			);
		});

		it("refuses to back a universal default with a personal prompt", async () => {
			// An admin's own USER version passes `versionAccessible`, so without
			// this the universal default could point at a prompt one person can
			// edit or delete out from under every tenant.
			promptVersionFindUnique.mockResolvedValue({
				scope: "USER",
				userId: "user-1",
				organizationId: null,
			});

			await expect(
				callSet({ scope: "SYSTEM", role: "admin" }),
			).rejects.toThrow(/system-scoped prompt/i);
			expect(bindPromptVersion).not.toHaveBeenCalled();
		});
	});

	describe("ORG scope", () => {
		it("requires org admin to set the org default", async () => {
			requireOrganizationAdmin.mockRejectedValue(new Error("FORBIDDEN"));

			await expect(
				callSet({
					scope: "ORG",
					isDefault: true,
					organizationId: "org-1",
				}),
			).rejects.toThrow();
			expect(requireOrganizationAdmin).toHaveBeenCalledWith(
				"org-1",
				"user-1",
			);
			expect(bindPromptVersion).not.toHaveBeenCalled();
		});

		it("allows an org admin to set the org default", async () => {
			await callSet({
				scope: "ORG",
				isDefault: true,
				organizationId: "org-1",
			});
			expect(bindPromptVersion).toHaveBeenCalledWith(
				expect.objectContaining({ scope: "ORG" }),
			);
		});

		it("refuses to back an org default with someone's personal prompt", async () => {
			// The same durability problem as the universal tier one level up:
			// the org's default would rest on a prompt one person can edit or
			// delete, and `versionAccessible` permits exactly that for the
			// caller's own prompt. Forking it to the organization first is the
			// supported route, and the message says so.
			promptVersionFindUnique.mockResolvedValue({
				scope: "USER",
				userId: "user-1",
				organizationId: null,
			});

			await expect(
				callSet({
					scope: "ORG",
					isDefault: true,
					organizationId: "org-1",
				}),
			).rejects.toThrow(/fork/i);
			expect(bindPromptVersion).not.toHaveBeenCalled();
		});

		it("allows an org-scoped prompt as the org default", async () => {
			promptVersionFindUnique.mockResolvedValue({
				scope: "ORG",
				userId: null,
				organizationId: "org-1",
			});

			await callSet({
				scope: "ORG",
				isDefault: true,
				organizationId: "org-1",
			});
			expect(bindPromptVersion).toHaveBeenCalled();
		});

		it("allows a system prompt as the org default", async () => {
			// Pinning a Fabric prompt as the org's explicit choice is normal;
			// system content is not one person's to edit away.
			await callSet({
				scope: "ORG",
				isDefault: true,
				organizationId: "org-1",
			});
			expect(bindPromptVersion).toHaveBeenCalled();
		});

		it("requires org admin even when isDefault is false", async () => {
			// There is no such thing as a merely-"available" ORG binding, so do
			// not reintroduce an `if (isDefault)` around the admin check.
			// PromptBinding is unique on
			// (targetType, targetKey, documentType, storyKind, scope, userId,
			// organizationId) — isDefault is NOT in that key — so an org has
			// exactly one row per target, and `bindPromptVersion` UPDATES that
			// row's promptVersionId rather than adding a second one. On the read
			// side `getBoundPromptVersion` selects the ORG row with no isDefault
			// filter at all. So a member writing isDefault:false silently
			// repoints the org's live default at their own prompt.
			requireOrganizationAdmin.mockRejectedValue(new Error("FORBIDDEN"));

			await expect(
				callSet({
					scope: "ORG",
					isDefault: false,
					organizationId: "org-1",
				}),
			).rejects.toThrow();
			expect(requireOrganizationAdmin).toHaveBeenCalledWith(
				"org-1",
				"user-1",
			);
			expect(bindPromptVersion).not.toHaveBeenCalled();
		});

		it("rejects an ORG binding with no organization in context", async () => {
			// bindPromptVersion would otherwise write scope ORG with a null
			// organizationId — a row no tenant can ever resolve.
			await expect(
				callSet({
					scope: "ORG",
					isDefault: true,
					organizationId: null,
				}),
			).rejects.toThrow(/organization/i);
			expect(bindPromptVersion).not.toHaveBeenCalled();
		});
	});

	describe("USER scope", () => {
		it("needs no tier check", async () => {
			await callSet({ scope: "USER", role: null });
			expect(requireOrganizationAdmin).not.toHaveBeenCalled();
			expect(bindPromptVersion).toHaveBeenCalledWith(
				expect.objectContaining({ scope: "USER", userId: "user-1" }),
			);
		});
	});

	describe("PROJECT tier — ORG binding narrowed to one project", () => {
		it("lets an org admin bind for their own org's project", async () => {
			await callSet({
				scope: "ORG",
				organizationId: "org-1",
				projectId: "proj-own",
				role: "user",
			});

			expect(bindPromptVersion).toHaveBeenCalledWith(
				expect.objectContaining({
					scope: "ORG",
					organizationId: "org-1",
					projectId: "proj-own",
				}),
			);
		});

		it("refuses a project that belongs to another organization", async () => {
			// Pairing one org's id with another org's project id would stamp
			// cross-tenant reach onto a row; the project's own membership is
			// resolved server-side, never trusted from the request.
			projectFindFirst.mockResolvedValue({
				id: "proj-foreign",
				organizationId: "org-other",
			});

			await expect(
				callSet({
					scope: "ORG",
					organizationId: "org-1",
					projectId: "proj-foreign",
					role: "user",
				}),
			).rejects.toThrow(/does not belong/i);
			expect(bindPromptVersion).not.toHaveBeenCalled();
		});

		it("refuses an unknown project id", async () => {
			projectFindFirst.mockResolvedValue(null);

			await expect(
				callSet({
					scope: "ORG",
					organizationId: "org-1",
					projectId: "proj-missing",
					role: "user",
				}),
			).rejects.toThrow(/does not belong/i);
			expect(bindPromptVersion).not.toHaveBeenCalled();
		});

		it("still demands the organization admin", async () => {
			requireOrganizationAdmin.mockRejectedValue(
				new Error("Only organization admins can do that"),
			);

			await expect(
				callSet({
					scope: "ORG",
					organizationId: "org-1",
					projectId: "proj-own",
					role: "user",
				}),
			).rejects.toThrow(/admins/i);
			expect(bindPromptVersion).not.toHaveBeenCalled();
		});

		it("refuses a projectId on a SYSTEM binding", async () => {
			await expect(
				callSet({
					scope: "SYSTEM",
					projectId: "proj-own",
					role: "admin",
					organizationId: null,
				}),
			).rejects.toThrow(/project scope applies only/i);
			expect(bindPromptVersion).not.toHaveBeenCalled();
		});

		it("refuses a projectId on a USER binding", async () => {
			await expect(
				callSet({
					scope: "USER",
					projectId: "proj-own",
					role: null,
				}),
			).rejects.toThrow(/project scope applies only/i);
			expect(bindPromptVersion).not.toHaveBeenCalled();
		});
	});
});
