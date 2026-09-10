/**
 * Regression tests for the missing-workspace record in `tenantContextMiddleware`
 * (Fizzy #2403, R2 / AE8).
 *
 * Under `docs/adr/018-organization-is-the-only-tenant-context.md` an account
 * always has an organization, so a session that names none is a fail-closed
 * default reached when something failed to resolve one — not a supported
 * "personal" context. The middleware is the single point every such request
 * crosses, so it records the condition there.
 *
 * Pinned behaviours:
 *  1. A session naming no workspace emits exactly one record carrying the user
 *     id, the session id and the oRPC procedure path.
 *  2. That record leaks nothing else — no email, no name, no URL. It goes to
 *     the application log sink (readable by anyone who can read server logs),
 *     NOT to the permission-gated audit table, and this repo is public.
 *  3. A second request on the same session within the window is suppressed, so
 *     a polling client cannot drown the signal; a later one is recorded again.
 *  4. A session naming a workspace the caller is a member of emits nothing.
 *  5. Recording changes NOTHING else: both arms still call through, and the
 *     tenant context handed to `next()` is exactly what the factories build.
 *     (U7 will later change which arm the stale-pointer case takes; this file
 *     deliberately qualifies its org case as "caller holds a membership" so the
 *     two units' scenarios cannot contradict each other.)
 */

import {
	createOrganizationContext,
	createPersonalContext,
} from "@repo/database/src/tenant-context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// The scaffolding this file shares with
// `tenant-context-missing-membership.test.ts`: `mocks`, the `@repo/logs` stub
// built from it, `loadMiddleware` and `invokeMw`.
import {
	invokeMw,
	loadMiddleware,
	mocks,
	ORG_ID,
	USER_ID,
} from "./support/tenant-context-fixtures";

// Mock the package index (it pulls the Prisma client, which needs DATABASE_URL
// at import time) while delegating the tenant-context factories to their real
// implementation — the point of scenario 5 is that the context is UNCHANGED,
// which a stubbed factory could not show.
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
	};
});

const USER_EMAIL = "dev@example.com";

type Ctx = {
	session: {
		id: string;
		userId: string;
		activeOrganizationId?: string | null;
	};
	user: { id: string; email: string; name: string };
	// Not part of the middleware's declared context — carried here only so the
	// leak assertions have a URL and a name to look for in the emitted record.
	requestUrl: string;
};

function makeCtx(sessionId: string, activeOrganizationId: string | null): Ctx {
	return {
		session: { id: sessionId, userId: USER_ID, activeOrganizationId },
		user: { id: USER_ID, email: USER_EMAIL, name: "Example Person" },
		requestUrl: "https://example.com/api/rpc?prompt=abc",
	};
}

/** The meta object of the Nth `logger.warn` call. */
function recordMeta(callIndex = 0): Record<string, unknown> {
	return mocks.warn.mock.calls[callIndex]?.[1] as Record<string, unknown>;
}

beforeEach(() => {
	mocks.memberFindUnique.mockReset();
	mocks.warn.mockReset();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("tenantContextMiddleware — recording a request that resolves no workspace", () => {
	it("emits one record carrying the user id, session id and procedure path", async () => {
		const mw = await loadMiddleware();
		const sessionId = "session-emits-one";

		await invokeMw(mw, makeCtx(sessionId, null));

		expect(mocks.warn).toHaveBeenCalledTimes(1);
		expect(recordMeta()).toEqual({
			userId: USER_ID,
			sessionId,
			procedurePath: "prompts.deletionImpact",
		});
	});

	it("emits a record carrying no email, no name and no URL", async () => {
		const mw = await loadMiddleware();

		await invokeMw(mw, makeCtx("session-no-leak", null));

		expect(mocks.warn).toHaveBeenCalledTimes(1);

		// The whole call — message and meta — must contain nothing but ids.
		const serialized = JSON.stringify(mocks.warn.mock.calls[0]);
		expect(serialized).not.toContain(USER_EMAIL);
		expect(serialized).not.toContain("@");
		expect(serialized).not.toContain("Example Person");
		expect(serialized).not.toMatch(/https?:\/\//);
		expect(serialized).not.toContain("example.com");

		// And the field set is closed: exactly the three ids R2 allows.
		expect(Object.keys(recordMeta()).sort()).toEqual([
			"procedurePath",
			"sessionId",
			"userId",
		]);
	});

	it("suppresses a second request on the same session within the window", async () => {
		const mw = await loadMiddleware();
		const ctx = makeCtx("session-dedup", null);

		await invokeMw(mw, ctx);
		await invokeMw(mw, ctx, ["projects", "list"]);
		await invokeMw(mw, ctx, ["prompts", "list"]);

		// A polling caller must not turn one broken session into a flood.
		expect(mocks.warn).toHaveBeenCalledTimes(1);
	});

	it("records a different session inside the same window", async () => {
		const mw = await loadMiddleware();

		await invokeMw(mw, makeCtx("session-dedup-a", null));
		await invokeMw(mw, makeCtx("session-dedup-b", null));

		// Dedup is per session, not global — two broken sessions are two signals.
		expect(mocks.warn).toHaveBeenCalledTimes(2);
	});

	it("records the same session again once the window has passed", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-09T10:00:00.000Z"));

		const mw = await loadMiddleware();
		const ctx = makeCtx("session-window-expiry", null);

		await invokeMw(mw, ctx);
		expect(mocks.warn).toHaveBeenCalledTimes(1);

		// Still inside the window.
		vi.setSystemTime(new Date("2026-09-09T10:00:30.000Z"));
		await invokeMw(mw, ctx);
		expect(mocks.warn).toHaveBeenCalledTimes(1);

		// Past it — the condition is still live, so it is reported again.
		vi.setSystemTime(new Date("2026-09-09T10:02:00.000Z"));
		await invokeMw(mw, ctx);
		expect(mocks.warn).toHaveBeenCalledTimes(2);
	});

	it("emits nothing for a session naming a workspace the caller is a member of", async () => {
		mocks.memberFindUnique.mockResolvedValue({ role: "admin" });
		const mw = await loadMiddleware();

		await invokeMw(mw, makeCtx("session-with-org", ORG_ID));

		expect(mocks.warn).not.toHaveBeenCalled();
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

describe("tenantContextMiddleware — recording changes nothing else", () => {
	it("still calls through with an unchanged personal-shaped context when no workspace resolves", async () => {
		const mw = await loadMiddleware();

		const { next, seenTenantContextInsideRun } = await invokeMw(
			mw,
			makeCtx("session-callthrough-none", null),
		);

		expect(next).toHaveBeenCalledTimes(1);
		const passed = next.mock.calls[0]?.[0]?.context as Record<
			string,
			unknown
		>;
		expect(passed.tenantContext).toEqual(createPersonalContext(USER_ID));
		expect(passed.activeOrganizationRole).toBeNull();
		expect(passed.allowedProjectIds).toEqual([]);

		// The chain still runs INSIDE the tenant context, not beside it.
		expect(seenTenantContextInsideRun).toEqual(
			createPersonalContext(USER_ID),
		);

		// No membership lookup: there is no organization to look one up in.
		expect(mocks.memberFindUnique).not.toHaveBeenCalled();
	});

	it("still calls through with an unchanged organization context when a workspace resolves", async () => {
		mocks.memberFindUnique.mockResolvedValue({ role: "member" });
		const mw = await loadMiddleware();

		const { next, seenTenantContextInsideRun } = await invokeMw(
			mw,
			makeCtx("session-callthrough-org", ORG_ID),
		);

		expect(next).toHaveBeenCalledTimes(1);
		const passed = next.mock.calls[0]?.[0]?.context as Record<
			string,
			unknown
		>;
		expect(passed.tenantContext).toEqual(
			createOrganizationContext(ORG_ID, USER_ID),
		);
		expect(passed.activeOrganizationRole).toBe("member");
		expect(passed.allowedProjectIds).toEqual([]);

		expect(seenTenantContextInsideRun).toEqual(
			createOrganizationContext(ORG_ID, USER_ID),
		);
	});
});
