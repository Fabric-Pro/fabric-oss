/**
 * Tests for `resolveUnambiguousOrganization` (Fizzy #2403, QA follow-up).
 *
 * QA could not delete a system prompt when the session named no workspace,
 * while the same account could inside an organization. The authority for a
 * SYSTEM prompt is the GLOBAL platform role, which does not vary by
 * organization — so the organization was never what differed. The tenant
 * context was: `tenantContextMiddleware` builds one from
 * `session.activeOrganizationId` and nothing else, and that pointer is
 * routinely empty on requests whose page sits inside one organization.
 *
 * This middleware answers that case with the rule sign-in already uses, and
 * refuses to answer the cases sign-in refuses.
 *
 * ## The test that matters most
 *
 * The last block drives this middleware's own output into the REAL
 * `requirePermission`. Asserting the shape of the context object is not
 * enough and this ticket has already proved it once: the first cut of the
 * sibling gate produced a context that looked fail-closed and selected
 * `requirePermission`'s pass-through arm, turning a deny into an allow
 * (`docs/solutions/architecture-patterns/failing-closed-can-remove-the-check-that-was-containing-it.md`).
 * Resolving an organization has the same hazard in mirror image: it moves a
 * request OUT of the arm that skips the role check, so the role had better be
 * the right one. Only running the two together shows that.
 */

import { ORPCError } from "@orpc/server";
import { getTenantContext } from "@repo/database/src/tenant-context";
import { Permissions } from "@repo/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = {
	resolveUserOrganization: vi.fn(),
	memberFindUnique: vi.fn(),
};

vi.mock("@repo/database", async () => {
	// The tenant-context helpers must be the REAL ones: `invokeMw` below reads
	// the AsyncLocalStorage store through `getTenantContext`, so a stubbed
	// `runWithTenantContext` would make the store assertions vacuously pass.
	const tenant = await vi.importActual<
		typeof import("@repo/database/src/tenant-context")
	>("@repo/database/src/tenant-context");
	return {
		createOrganizationContext: tenant.createOrganizationContext,
		createPersonalContext: tenant.createPersonalContext,
		runWithTenantContext: tenant.runWithTenantContext,
		resolveUserOrganization: mocks.resolveUserOrganization,
		db: { member: { findUnique: mocks.memberFindUnique } },
	};
});

const USER_ID = "user-2403";
const ORG_ID = "org-2403";

async function loadMiddleware() {
	const mod = await import(
		"../orpc/middleware/resolve-unambiguous-organization"
	);
	return mod.resolveUnambiguousOrganization;
}

type Ctx = {
	user: { id: string };
	session: { activeOrganizationId: string | null };
	tenantContext?: unknown;
	activeOrganizationRole?: string | null;
};

function makeCtx(overrides: Partial<Ctx> = {}): Ctx {
	return {
		user: { id: USER_ID },
		session: { activeOrganizationId: null },
		tenantContext: null,
		activeOrganizationRole: null,
		...overrides,
	};
}

async function invoke(ctx: Ctx) {
	const mw = await loadMiddleware();
	let tenantInsideRun: unknown;
	const next = vi.fn(async (opts?: { context?: Record<string, unknown> }) => {
		// Read from INSIDE the wrapped run: `getTenantDb()` resolves through
		// this store, not through `context.tenantContext`, so the two agreeing
		// is the property under test.
		tenantInsideRun = getTenantContext();
		return { output: "ok", context: opts?.context };
	});

	const result = await (
		mw as unknown as (
			arg: { context: Ctx; next: typeof next; path: readonly string[] },
			input: unknown,
		) => Promise<{ context?: Record<string, unknown> }>
	)({ context: ctx, next, path: ["prompts", "delete"] }, {});

	return { next, result, tenantInsideRun };
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("a request that already has an organization", () => {
	it("passes straight through without asking the resolver", async () => {
		const ctx = makeCtx({
			tenantContext: {
				type: "organization",
				organizationId: ORG_ID,
				userId: USER_ID,
			},
			session: { activeOrganizationId: ORG_ID },
		});

		const { next } = await invoke(ctx);

		expect(next).toHaveBeenCalledTimes(1);
		expect(mocks.resolveUserOrganization).not.toHaveBeenCalled();
		// No context override: the common path must cost nothing and change
		// nothing.
		expect(next.mock.calls[0][0]).toBeUndefined();
	});

	it("does NOT repair an organization context that names no id", async () => {
		// One of the three shapes `assertOrganizationContext` refuses. Repairing
		// it here would hide a malformed context instead of surfacing it.
		mocks.resolveUserOrganization.mockResolvedValue({
			kind: "ambiguous",
			organizationIds: ["a", "b"],
		});
		const ctx = makeCtx({
			tenantContext: {
				type: "organization",
				organizationId: "",
				userId: USER_ID,
			},
		});

		await invoke(ctx);

		expect(mocks.resolveUserOrganization).toHaveBeenCalledTimes(1);
	});
});

describe("a session that names no workspace", () => {
	it("resolves the unambiguous answer into the context, the store and the session", async () => {
		mocks.resolveUserOrganization.mockResolvedValue({
			kind: "resolved",
			organizationId: ORG_ID,
		});
		mocks.memberFindUnique.mockResolvedValue({
			role: "owner",
			organization: { deletedAt: null },
		});

		const { next, tenantInsideRun } = await invoke(makeCtx());

		const handed = next.mock.calls[0][0]?.context as Record<
			string,
			unknown
		>;
		expect(handed.tenantContext).toMatchObject({
			type: "organization",
			organizationId: ORG_ID,
		});
		expect(handed.activeOrganizationRole).toBe("owner");
		// `resolveOrganizationId` reads the session, not the tenant context, so
		// the pointer has to move with it or one request carries two answers.
		expect(handed.session).toMatchObject({ activeOrganizationId: ORG_ID });
		// And the AsyncLocalStorage store that `getTenantDb()` reads.
		expect(tenantInsideRun).toMatchObject({
			type: "organization",
			organizationId: ORG_ID,
		});
	});

	it("leaves an AMBIGUOUS account exactly as it arrived", async () => {
		mocks.resolveUserOrganization.mockResolvedValue({
			kind: "ambiguous",
			organizationIds: ["org-a", "org-b"],
		});

		const { next } = await invoke(makeCtx());

		expect(next.mock.calls[0][0]).toBeUndefined();
		expect(mocks.memberFindUnique).not.toHaveBeenCalled();
	});

	it("leaves an account with NO membership exactly as it arrived", async () => {
		mocks.resolveUserOrganization.mockResolvedValue({
			kind: "no_membership",
		});

		const { next } = await invoke(makeCtx());

		expect(next.mock.calls[0][0]).toBeUndefined();
	});

	it("fails closed when the membership row vanished between the two reads", async () => {
		mocks.resolveUserOrganization.mockResolvedValue({
			kind: "resolved",
			organizationId: ORG_ID,
		});
		mocks.memberFindUnique.mockResolvedValue(null);

		const { next } = await invoke(makeCtx());

		expect(next.mock.calls[0][0]).toBeUndefined();
	});

	it("refuses a workspace that has been deactivated for deletion", async () => {
		mocks.resolveUserOrganization.mockResolvedValue({
			kind: "resolved",
			organizationId: ORG_ID,
		});
		mocks.memberFindUnique.mockResolvedValue({
			role: "owner",
			organization: { deletedAt: new Date() },
		});

		await expect(invoke(makeCtx())).rejects.toBeInstanceOf(ORPCError);
	});
});

describe("chained into the real permission middleware", () => {
	/**
	 * Resolving an organization moves the request out of the arm that skips the
	 * role check. These two cases show the role is then genuinely evaluated —
	 * the same shape of assertion that would have caught the earlier flip in
	 * the opposite direction.
	 */
	async function runChain(role: string) {
		mocks.resolveUserOrganization.mockResolvedValue({
			kind: "resolved",
			organizationId: ORG_ID,
		});
		mocks.memberFindUnique.mockResolvedValue({
			role,
			organization: { deletedAt: null },
		});

		const mw = await loadMiddleware();
		const { requirePermission } = await import(
			"../orpc/middleware/require-permission"
		);
		const permissionMw = requirePermission(Permissions.PROMPT_DELETE);

		const permissionNext = vi.fn(async () => ({
			output: "reached-handler",
		}));

		const outerNext = vi.fn(
			async (opts?: { context?: Record<string, unknown> }) =>
				await (
					permissionMw as unknown as (
						arg: {
							context: unknown;
							next: typeof permissionNext;
							path: readonly string[];
						},
						input: unknown,
					) => Promise<unknown>
				)(
					{
						context: { ...makeCtx(), ...(opts?.context ?? {}) },
						next: permissionNext,
						path: ["prompts", "delete"],
					},
					{},
				),
		);

		let denied = false;
		try {
			await (
				mw as unknown as (
					arg: {
						context: Ctx;
						next: typeof outerNext;
						path: readonly string[];
					},
					input: unknown,
				) => Promise<unknown>
			)(
				{
					context: makeCtx(),
					next: outerNext,
					path: ["prompts", "delete"],
				},
				{},
			);
		} catch {
			denied = true;
		}

		return { denied, permissionNext };
	}

	it("lets an owner through", async () => {
		const { denied, permissionNext } = await runChain("owner");

		expect(denied).toBe(false);
		expect(permissionNext).toHaveBeenCalledTimes(1);
	});

	it("denies a plain member — the role IS evaluated, not skipped", async () => {
		const { denied, permissionNext } = await runChain("member");

		expect(denied).toBe(true);
		expect(permissionNext).not.toHaveBeenCalled();
	});
});
