/**
 * Regression tests for the stale-workspace-pointer gate in
 * `tenantContextMiddleware` (Fizzy #2403, R18 / AE21, AE22).
 *
 * A workspace pointer on a session is not a membership. Resolution and session
 * insertion are not atomic: a sign-in can resolve a membership, have that
 * membership removed by a concurrent offboarding that clears only the sessions
 * existing at that moment, and then insert a session naming a workspace the
 * person has already left. The middleware already looks that membership up —
 * before this unit it used the result ONLY to set a role and built the
 * organization context either way, so tenant filtering ran against a workspace
 * the caller had left on every procedure without a permission gate.
 *
 * Pinned behaviours:
 *  1. A session naming a workspace with NO membership row is REFUSED —
 *     FORBIDDEN carrying `MISSING_ORGANIZATION_CONTEXT_ERROR_CODE` — and the
 *     record is emitted before the refusal. (AE21)
 *  2. A session naming a workspace the caller IS a member of resolves that
 *     workspace and that role, byte-for-byte as before this unit. (AE22)
 *  3. A session naming no workspace is untouched by this unit.
 *  4. The membership lookup runs exactly ONCE per request. The gate needs the
 *     lookup's result before it can choose a context, and the naive way to get
 *     it is to query again — which would double the query count of every
 *     org-scoped request in the application.
 *
 * ## Why refuse rather than downgrade
 *
 * The first cut of this gate resolved the stale-pointer case to a PERSONAL
 * context. That reads as the fail-closed choice and is the opposite one:
 * `requirePermission` returns `next()` without evaluating any role in personal
 * context, so a caller the null role used to deny became a caller nobody
 * checked — a deny turned into a pass-through. The last describe block below
 * drives the middleware's own output into `requirePermission` and asserts the
 * caller is denied; it is the test that would have caught that flip.
 */

import { ORPCError } from "@orpc/server";
import {
	createOrganizationContext,
	createPersonalContext,
} from "@repo/database/src/tenant-context";
import { Permissions } from "@repo/permissions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MISSING_ORGANIZATION_CONTEXT_ERROR_CODE } from "../lib/missing-organization-context";
// The scaffolding this file shares with
// `tenant-context-missing-workspace.test.ts`: `mocks`, the `@repo/logs` stub
// built from it, `loadMiddleware` and `invokeMw`.
import {
	invokeMw,
	loadMiddleware,
	mocks,
	ORG_ID,
	PROCEDURE_PATH,
	USER_ID,
} from "./support/tenant-context-fixtures";

// Mock the package index (it pulls the Prisma client, which needs DATABASE_URL
// at import time) while delegating the tenant-context factories to their real
// implementation — these tests assert the context is EXACTLY what the factories
// build, which a stubbed factory could not show. Mirrors the sibling file
// `tenant-context-missing-workspace.test.ts`.
vi.mock("@repo/database", async () => {
	const actual = await vi.importActual<
		typeof import("@repo/database/src/tenant-context")
	>("@repo/database/src/tenant-context");
	return {
		createOrganizationContext: actual.createOrganizationContext,
		createPersonalContext: actual.createPersonalContext,
		runWithTenantContext: actual.runWithTenantContext,
		getTenantContext: actual.getTenantContext,
		db: {
			member: { findUnique: mocks.memberFindUnique },
		},
		// Named imports `require-permission.ts` pulls from the same module.
		// Unused on the org-role path this file exercises, but a mocked module
		// must still expose every export its importers name.
		getOrganizationMembership: vi.fn(),
		grantProjectAccess: vi.fn(),
	};
});

type Ctx = {
	session: {
		id: string;
		userId: string;
		activeOrganizationId?: string | null;
	};
	user: { id: string; email: string; name: string };
};

function makeCtx(sessionId: string, activeOrganizationId: string | null): Ctx {
	return {
		session: { id: sessionId, userId: USER_ID, activeOrganizationId },
		user: { id: USER_ID, email: "dev@example.com", name: "Example Person" },
	};
}

/** Invoke the middleware with a caller-supplied `next`. */
async function invokeMwWithNext(
	mw: unknown,
	ctx: Ctx,
	next: (opts?: { context?: Record<string, unknown> }) => Promise<unknown>,
	path: readonly string[] = PROCEDURE_PATH,
): Promise<unknown> {
	return await (
		mw as (
			arg: {
				context: Ctx;
				next: typeof next;
				path: readonly string[];
			},
			input: unknown,
		) => Promise<unknown>
	)({ context: ctx, next, path }, {});
}

/** Run the middleware and return the error it refused with. */
async function captureRefusal(mw: unknown, ctx: Ctx): Promise<unknown> {
	const next = vi.fn(async () => ({ output: "ok" }));
	try {
		await invokeMwWithNext(mw, ctx, next);
	} catch (error) {
		return error;
	}
	throw new Error(
		"expected the middleware to refuse, but it called through instead",
	);
}

async function loadRequirePermission() {
	const mod = await import("../orpc/middleware/require-permission");
	return mod.requirePermission;
}

type PermissionCtx = {
	tenantContext: unknown;
	activeOrganizationRole: string | null;
	allowedProjectIds: string[];
};

/** Invoke a `requirePermission` middleware the same way oRPC would. */
async function invokePermissionMw(
	mw: unknown,
	ctx: PermissionCtx,
	next: () => Promise<unknown>,
): Promise<unknown> {
	return await (
		mw as (
			arg: { context: PermissionCtx; next: typeof next },
			input: unknown,
		) => Promise<unknown>
	)({ context: ctx, next }, {});
}

/**
 * Run the REAL chain: `tenantContextMiddleware` and then `requirePermission`
 * on whatever context it produced. Nothing is hand-assembled between the two,
 * so the permission middleware sees exactly what a procedure would.
 */
async function runTenantThenPermission(ctx: Ctx): Promise<{
	verdict: "allowed" | "denied";
	permissionNext: ReturnType<typeof vi.fn>;
}> {
	const tenantMw = await loadMiddleware();
	const requirePermission = await loadRequirePermission();
	const permissionMw = requirePermission(Permissions.PROMPT_DELETE);
	const permissionNext = vi.fn(async () => ({ output: "ok" }));

	try {
		await invokeMwWithNext(
			tenantMw,
			ctx,
			async (opts?: { context?: Record<string, unknown> }) =>
				await invokePermissionMw(
					permissionMw,
					opts?.context as unknown as PermissionCtx,
					permissionNext,
				),
		);
	} catch (error) {
		if (error instanceof ORPCError && error.code === "FORBIDDEN") {
			return { verdict: "denied", permissionNext };
		}
		throw error;
	}

	return {
		verdict: permissionNext.mock.calls.length > 0 ? "allowed" : "denied",
		permissionNext,
	};
}

/** The context object handed to `next()` on the Nth call. */
function passedContext(
	next: ReturnType<typeof vi.fn>,
	callIndex = 0,
): Record<string, unknown> {
	return next.mock.calls[callIndex]?.[0]?.context as Record<string, unknown>;
}

beforeEach(() => {
	mocks.memberFindUnique.mockReset();
	mocks.warn.mockReset();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("tenantContextMiddleware — a session naming a workspace the caller belongs to", () => {
	it("resolves that workspace and the caller's role, unchanged", async () => {
		mocks.memberFindUnique.mockResolvedValue({ role: "admin" });
		const mw = await loadMiddleware();

		const { next, seenTenantContextInsideRun } = await invokeMw(
			mw,
			makeCtx("session-member", ORG_ID),
		);

		expect(next).toHaveBeenCalledTimes(1);
		const passed = passedContext(next);
		expect(passed.tenantContext).toEqual(
			createOrganizationContext(ORG_ID, USER_ID),
		);
		expect(passed.activeOrganizationRole).toBe("admin");
		expect(passed.allowedProjectIds).toEqual([]);

		// The chain still runs INSIDE the tenant context, not beside it.
		expect(seenTenantContextInsideRun).toEqual(
			createOrganizationContext(ORG_ID, USER_ID),
		);

		// A resolving workspace is not a missing one — nothing is recorded.
		expect(mocks.warn).not.toHaveBeenCalled();
	});

	it("looks the membership up exactly once, with the caller's own id", async () => {
		mocks.memberFindUnique.mockResolvedValue({ role: "member" });
		const mw = await loadMiddleware();

		await invokeMw(mw, makeCtx("session-one-lookup", ORG_ID));

		// The gate needs the lookup's result before it picks a context. Getting
		// it by querying a second time would double every org-scoped request's
		// query count for the whole application.
		expect(mocks.memberFindUnique).toHaveBeenCalledTimes(1);
		expect(mocks.memberFindUnique).toHaveBeenCalledWith({
			where: {
				organizationId_userId: {
					organizationId: ORG_ID,
					userId: USER_ID,
				},
			},
			select: { role: true },
		});
	});
});

describe("tenantContextMiddleware — a session naming a workspace the caller has left", () => {
	it("REFUSES the request rather than resolving any context for it", async () => {
		// No membership row: the pointer outlived the membership.
		mocks.memberFindUnique.mockResolvedValue(null);
		const mw = await loadMiddleware();

		const error = await captureRefusal(
			mw,
			makeCtx("session-stale-pointer", ORG_ID),
		);

		// THE GATE. Before this unit the middleware built an organization
		// context here and left the role null, so tenant filtering ran against
		// a workspace the caller had left on every procedure without a
		// permission gate. Downgrading it to a personal context (the first cut
		// of the gate) was no better: `requirePermission` skips the role check
		// outright in personal context, so the null-role denial became a
		// pass-through. The caller named a tenant they hold no right to, and the
		// answer to that is a refusal.
		expect(error).toBeInstanceOf(ORPCError);
		expect((error as ORPCError<string, unknown>).code).toBe("FORBIDDEN");
		expect((error as ORPCError<string, unknown>).message).toBe(
			"This operation requires an organization context",
		);

		// The machine-readable marker the client shipped with this change reads.
		expect(
			(error as ORPCError<string, { errorCode?: string }>).data,
		).toEqual({
			errorCode: MISSING_ORGANIZATION_CONTEXT_ERROR_CODE,
		});
	});

	it("never reaches the rest of the chain", async () => {
		mocks.memberFindUnique.mockResolvedValue(null);
		const mw = await loadMiddleware();

		const next = vi.fn(async () => ({ output: "ok" }));
		await expect(
			invokeMwWithNext(
				mw,
				makeCtx("session-stale-no-callthrough", ORG_ID),
				next,
			),
		).rejects.toBeInstanceOf(ORPCError);

		// A refusal, not a downgrade: no handler runs, so no context carrying
		// the left workspace can reach one.
		expect(next).not.toHaveBeenCalled();
	});

	it("emits the same record a session with no pointer emits, BEFORE refusing", async () => {
		mocks.memberFindUnique.mockResolvedValue(null);
		const mw = await loadMiddleware();

		await captureRefusal(mw, makeCtx("session-stale-recorded", ORG_ID));

		// One channel, not two: the stale case is routed onto U3's record so
		// the condition is visible in exactly one place — and the record must
		// survive the throw, or the condition becomes invisible on the very
		// path that acts on it.
		expect(mocks.warn).toHaveBeenCalledTimes(1);
		expect(mocks.warn.mock.calls[0]?.[1]).toEqual({
			userId: USER_ID,
			sessionId: "session-stale-recorded",
			procedurePath: "prompts.deletionImpact",
		});
	});

	it("still looks the membership up exactly once", async () => {
		mocks.memberFindUnique.mockResolvedValue(null);
		const mw = await loadMiddleware();

		await captureRefusal(mw, makeCtx("session-stale-one-lookup", ORG_ID));

		// The gate consumes the lookup that already ran; it does not add one.
		expect(mocks.memberFindUnique).toHaveBeenCalledTimes(1);
	});
});

/**
 * The deny-to-skip regression, pinned end to end.
 *
 * The security review's words: "A test that feeds the resulting tenantContext
 * into requirePermission and asserts FORBIDDEN would have caught the
 * deny-to-skip flip." This block does exactly that — it runs the real
 * `tenantContextMiddleware`, takes whatever it hands the chain, and runs the
 * real `requirePermission` on it.
 */
describe("tenantContextMiddleware feeding requirePermission", () => {
	it("denies a caller whose session names a workspace they have left", async () => {
		mocks.memberFindUnique.mockResolvedValue(null);

		const outcome = await runTenantThenPermission(
			makeCtx("session-stale-chain", ORG_ID),
		);

		// Denied — never "allowed". Under the downgrade this read `allowed`,
		// because a personal tenant context makes `requirePermission` return
		// `next()` without evaluating a role at all.
		expect(outcome.verdict).toBe("denied");
		expect(outcome.permissionNext).not.toHaveBeenCalled();
	});

	it("still allows a caller whose membership grants the permission", async () => {
		mocks.memberFindUnique.mockResolvedValue({ role: "owner" });

		const outcome = await runTenantThenPermission(
			makeCtx("session-member-chain", ORG_ID),
		);

		// The chain is not vacuously denying: a real member still gets through.
		expect(outcome.verdict).toBe("allowed");
		expect(outcome.permissionNext).toHaveBeenCalledTimes(1);
	});

	it("shows why a personal downgrade could not stand: that arm is a pass-through", async () => {
		const requirePermission = await loadRequirePermission();
		const mw = requirePermission(Permissions.PROMPT_DELETE);
		const next = vi.fn(async () => ({ output: "ok" }));

		// The context the downgrade used to produce: personal, null role.
		await invokePermissionMw(
			mw,
			{
				tenantContext: createPersonalContext(USER_ID),
				activeOrganizationRole: null,
				allowedProjectIds: [],
			},
			next,
		);

		// No role is evaluated here — which is precisely why the middleware must
		// refuse a rejected pointer instead of routing it into this arm.
		expect(next).toHaveBeenCalledTimes(1);

		// The same null role in an ORGANIZATION context is denied. That is the
		// behaviour the downgrade silently replaced with the line above.
		const orgNext = vi.fn(async () => ({ output: "ok" }));
		await expect(
			invokePermissionMw(
				mw,
				{
					tenantContext: createOrganizationContext(ORG_ID, USER_ID),
					activeOrganizationRole: null,
					allowedProjectIds: [],
				},
				orgNext,
			),
		).rejects.toBeInstanceOf(ORPCError);
		expect(orgNext).not.toHaveBeenCalled();
	});
});

describe("tenantContextMiddleware — a session naming no workspace", () => {
	it("is untouched by this unit: fail-closed context, null role, one record", async () => {
		const mw = await loadMiddleware();

		const { next, seenTenantContextInsideRun } = await invokeMw(
			mw,
			makeCtx("session-no-pointer", null),
		);

		expect(next).toHaveBeenCalledTimes(1);
		const passed = passedContext(next);
		expect(passed.tenantContext).toEqual(createPersonalContext(USER_ID));
		expect(passed.activeOrganizationRole).toBeNull();
		expect(passed.allowedProjectIds).toEqual([]);
		expect(seenTenantContextInsideRun).toEqual(
			createPersonalContext(USER_ID),
		);

		// No organization named, so nothing to look a membership up in.
		expect(mocks.memberFindUnique).not.toHaveBeenCalled();

		expect(mocks.warn).toHaveBeenCalledTimes(1);
		expect(mocks.warn.mock.calls[0]?.[1]).toEqual({
			userId: USER_ID,
			sessionId: "session-no-pointer",
			procedurePath: "prompts.deletionImpact",
		});
	});
});
