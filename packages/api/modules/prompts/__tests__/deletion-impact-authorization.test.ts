/**
 * Who may read a SYSTEM prompt's platform-wide deletion impact.
 *
 * `getPlatformWidePromptDeletionImpact` is deliberately un-scoped: it counts
 * bindings belonging to organizations and individuals the caller has no
 * standing in, because a SYSTEM prompt's versions can be bound by any tenant.
 * That makes reaching it a privileged act, and this procedure is the only door
 * to it. These tests are the specification of who gets through.
 *
 * Three gates, and all three must hold:
 *   1. `requirePermission(PROMPT_DELETE)` — the caller's ACTIVE ORGANIZATION
 *      role grants prompt deletion.
 *   2. An organization context actually exists. The middleware in gate 1
 *      returns `next()` without evaluating any role when `tenantContext` is
 *      absent or personal, so on its own it would wave a global admin with no
 *      active organization straight through to a cross-tenant read on the
 *      strength of gate 3 alone. The handler refuses that itself.
 *   3. The same per-scope authority the deletion requires — for SYSTEM, the
 *      global `admin` role — via the helper `delete.ts` shares.
 *
 * And the read is SYSTEM-only: the un-scoped traversal is justified by the
 * platform-operator role and nothing else, so an ORG or USER prompt is refused
 * before the query runs even when the caller could legitimately delete it.
 *
 * Every refusal asserts the query was never invoked, and the authorised path
 * asserts a curated audit row — automatic activity capture drops GET-shaped
 * routes, so without that emission this would be the one un-scoped
 * cross-tenant call in the module leaving no trace (R12).
 *
 * Run with:
 *   pnpm --filter api test modules/prompts/__tests__/deletion-impact-authorization.test.ts
 */

import { Permissions as RealPermissions } from "@repo/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	getPlatformWidePromptDeletionImpact,
	getPromptById,
	verifyOrganizationMembership,
	recordAuditFromRequest,
	mountedPermissions,
} = vi.hoisted(() => ({
	getPlatformWidePromptDeletionImpact: vi.fn(),
	getPromptById: vi.fn(),
	verifyOrganizationMembership: vi.fn(),
	recordAuditFromRequest: vi.fn(),
	mountedPermissions: [] as string[],
}));

vi.mock("@repo/database", () => ({
	getPlatformWidePromptDeletionImpact,
	getPromptById,
	// `require-permission.ts` is imported for real further down (the org-role
	// gate is the middleware's job, not the handler's, so the only honest way
	// to test it is to drive the real thing). It pulls these off the same
	// barrel at module load.
	db: {},
	getOrganizationMembership: vi.fn(),
	getTenantContext: vi.fn(() => ({ effectiveWriteOrgId: undefined })),
	grantProjectAccess: vi.fn(),
}));

vi.mock("../../organizations/lib/membership", () => ({
	verifyOrganizationMembership,
}));

vi.mock("../../../lib/audit", () => ({ recordAuditFromRequest }));

vi.mock("../../../orpc/procedures", () => ({
	Permissions: { PROMPT_DELETE: "prompt:delete" },
	requirePermission: (permission: string) => {
		mountedPermissions.push(permission);
		return (next: unknown) => next;
	},
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

import { deletionImpactProcedure } from "../procedures/deletion-impact";

const IMPACT = {
	promptRowCount: 2,
	bindingCount: 7,
	organizationCount: 3,
	personalOverrideUserCount: 1,
	documentTypeLabels: ["General", "Test Plan"],
};

type Handler = (a: unknown) => Promise<unknown>;
type TenantShape = "organization" | "personal" | "none" | "absent";

const callImpact = (
	args: { id?: string; role?: string | null; tenant?: TenantShape } = {},
) => {
	const tenant = args.tenant ?? "organization";
	const organizationId = tenant === "organization" ? "org-1" : null;

	return (deletionImpactProcedure as unknown as Handler)({
		input: { id: args.id ?? "prompt-1" },
		context: {
			user: {
				id: "user-1",
				email: "operator@example.com",
				name: "Operator",
				role: args.role === undefined ? "admin" : args.role,
			},
			session: { id: "session-1", activeOrganizationId: organizationId },
			tenantContext:
				tenant === "absent"
					? undefined
					: { userId: "user-1", type: tenant, organizationId },
		},
	});
};

beforeEach(() => {
	getPromptById.mockReset();
	getPromptById.mockResolvedValue({
		id: "prompt-1",
		key: "story_drafter",
		name: "DO NOT USE - Story Drafter",
		scope: "SYSTEM",
		organizationId: null,
		userId: null,
	});
	getPlatformWidePromptDeletionImpact.mockReset();
	getPlatformWidePromptDeletionImpact.mockResolvedValue(IMPACT);
	verifyOrganizationMembership.mockReset();
	verifyOrganizationMembership.mockResolvedValue({ role: "admin" });
	recordAuditFromRequest.mockReset();
});

describe("prompts.deletionImpact authorization", () => {
	it("refuses a caller without the global admin role", async () => {
		// Gate 3. An organization admin is not a platform operator, and the
		// figures below cover tenants they have no standing in.
		await expect(callImpact({ role: "user" })).rejects.toThrow(
			/administrators/i,
		);
		expect(getPlatformWidePromptDeletionImpact).not.toHaveBeenCalled();
		expect(recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("refuses a caller whose null global role is absent rather than admin", async () => {
		await expect(callImpact({ role: null })).rejects.toThrow(
			/administrators/i,
		);
		expect(getPlatformWidePromptDeletionImpact).not.toHaveBeenCalled();
	});

	it("mounts the same permission gate the delete procedure carries", () => {
		// Gate 1 is the middleware's, not the handler's — so the handler test
		// below cannot see it. This pins that it is actually mounted; the next
		// test drives the real middleware to prove what it does.
		expect(mountedPermissions).toContain("prompt:delete");
	});

	it("refuses a caller with the global role but no organization delete permission", async () => {
		// Gate 1, driven for real: an ordinary member's role does not grant
		// PROMPT_DELETE, so the request never reaches the handler at all.
		const { requirePermission } = await import(
			"../../../orpc/middleware/require-permission"
		);
		const middleware = requirePermission(RealPermissions.PROMPT_DELETE);
		const next = vi.fn().mockResolvedValue({ output: "ok" });

		await expect(
			(
				middleware as unknown as (a: {
					context: unknown;
					next: typeof next;
				}) => Promise<unknown>
			)({
				context: {
					user: { id: "user-1", role: "admin" },
					session: { activeOrganizationId: "org-1" },
					activeOrganizationRole: "member",
					tenantContext: {
						userId: "user-1",
						type: "organization",
						organizationId: "org-1",
					},
				},
				next,
			}),
		).rejects.toThrow(/permission/i);

		expect(next).not.toHaveBeenCalled();
		expect(getPlatformWidePromptDeletionImpact).not.toHaveBeenCalled();
		expect(recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("refuses a global admin with no active organization", async () => {
		// Gate 2, and the reason it exists. `requirePermission` returns next()
		// immediately for a personal/absent tenant context, so gate 1 evaluates
		// nothing here — leaving a global admin one gate away from a
		// cross-tenant read. ADR 018: no organization means resolution failed,
		// and a platform-wide read is not a capability to offer from that state.
		await expect(callImpact({ tenant: "personal" })).rejects.toThrow(
			/organization/i,
		);
		expect(getPromptById).not.toHaveBeenCalled();
		expect(getPlatformWidePromptDeletionImpact).not.toHaveBeenCalled();
		expect(recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("refuses a caller whose tenant context is absent entirely", async () => {
		await expect(callImpact({ tenant: "absent" })).rejects.toThrow(
			/organization/i,
		);
		expect(getPlatformWidePromptDeletionImpact).not.toHaveBeenCalled();
	});

	it("refuses an organization admin asking about an ORG prompt", async () => {
		// They may well be entitled to DELETE it — the per-scope check passes.
		// The refusal is about the read: an un-scoped cross-tenant traversal is
		// justified by the platform-operator role and nothing else.
		getPromptById.mockResolvedValue({
			id: "prompt-org",
			key: "story_drafter",
			name: "Story Drafter (Example Org)",
			scope: "ORG",
			organizationId: "org-1",
			userId: null,
		});

		await expect(
			callImpact({ id: "prompt-org", role: null }),
		).rejects.toThrow(/system/i);
		expect(getPlatformWidePromptDeletionImpact).not.toHaveBeenCalled();
		expect(recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("refuses a USER prompt too", async () => {
		getPromptById.mockResolvedValue({
			id: "prompt-user",
			key: "story_drafter",
			name: "My Story Drafter",
			scope: "USER",
			organizationId: null,
			userId: "user-1",
		});

		await expect(callImpact({ id: "prompt-user" })).rejects.toThrow(
			/system/i,
		);
		expect(getPlatformWidePromptDeletionImpact).not.toHaveBeenCalled();
	});

	it("gives an authorised caller the counts", async () => {
		await expect(callImpact()).resolves.toEqual(IMPACT);
		expect(getPlatformWidePromptDeletionImpact).toHaveBeenCalledWith({
			promptId: "prompt-1",
		});
	});

	it("reports an unknown prompt id as not found rather than an empty impact", async () => {
		getPromptById.mockResolvedValue(null);

		await expect(callImpact({ id: "prompt-gone" })).rejects.toThrow(
			/not found/i,
		);
		expect(getPlatformWidePromptDeletionImpact).not.toHaveBeenCalled();
		expect(recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("reports a prompt deleted underneath the read as not found", async () => {
		// The query returns null for an id no prompt carries. Between the two
		// reads someone else's deletion can commit, and zero counts would
		// otherwise be presented as "this deletion removes nothing".
		getPlatformWidePromptDeletionImpact.mockResolvedValue(null);

		await expect(callImpact()).rejects.toThrow(/not found/i);
		expect(recordAuditFromRequest).not.toHaveBeenCalled();
	});
});

describe("prompts.deletionImpact audit trail", () => {
	it("records the actor, the prompt and the totals on an authorised read", async () => {
		await callImpact();

		expect(recordAuditFromRequest).toHaveBeenCalledTimes(1);
		const [auditContext, entry] = recordAuditFromRequest.mock.calls[0] as [
			{ user: { id: string } },
			{
				action: string;
				resource: { type: string; id: string };
				metadata: Record<string, unknown>;
			},
		];

		// The actor: the helper snapshots email/name off this context.
		expect(auditContext.user.id).toBe("user-1");
		expect(entry.action).toBe("prompt.deletion_impact_viewed");
		expect(entry.resource).toMatchObject({
			type: "prompt",
			id: "prompt-1",
		});
		// The totals, as returned. Counts only — the query returns no
		// organization or user identifier and none is invented here.
		expect(entry.metadata).toMatchObject({
			promptRowCount: 2,
			bindingCount: 7,
			organizationCount: 3,
			personalOverrideUserCount: 1,
			documentTypeCount: 2,
		});
	});

	it("emits nothing for a refused read", async () => {
		await expect(callImpact({ role: "user" })).rejects.toThrow();
		await expect(callImpact({ tenant: "personal" })).rejects.toThrow();

		expect(recordAuditFromRequest).not.toHaveBeenCalled();
	});
});
