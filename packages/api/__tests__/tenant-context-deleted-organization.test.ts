/**
 * The deactivation gate in `tenantContextMiddleware` (Fizzy #2462).
 *
 * Deleting an organization does not destroy anything for seven days. What makes
 * it "deleted" in the meantime is THIS refusal — and the reason it can be one
 * refusal rather than a predicate on every query is that no request resolves a
 * tenant context for a deactivated workspace, so the ~168 tables that cascade
 * off `organization` are never reached to begin with.
 *
 * Which makes these the tests that stop the corridor leaking:
 *
 *  1. A session naming a deactivated workspace is REFUSED, and the refusal
 *     carries `ORGANIZATION_DELETED` rather than the missing-context code — the
 *     client needs to tell them apart to offer "restore" instead of "reload".
 *  2. A live workspace is completely unaffected.
 *  3. The liveness answer rides the EXISTING membership lookup. A second query
 *     here would double the query count of every org-scoped request in the
 *     application, so the count is pinned.
 *  4. Deactivation is checked AFTER membership, so a non-member still cannot
 *     learn whether the workspace exists — they get the same refusal either way.
 *  5. It is NOT reported through the workspace-less counter: the workspace
 *     resolved perfectly well, it is simply gone, and folding it in would make a
 *     normal consequence of deletion look like the session bug that counter
 *     exists to measure.
 */

import { ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DELETED_ORGANIZATION_ERROR_CODE } from "../lib/deleted-organization";
import { MISSING_ORGANIZATION_CONTEXT_ERROR_CODE } from "../lib/missing-organization-context";
import {
	invokeMw,
	loadMiddleware,
	mocks,
	ORG_ID,
	USER_ID,
} from "./support/tenant-context-fixtures";

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

function makeCtx(activeOrganizationId: string | null) {
	return {
		session: {
			id: "session-2462",
			userId: USER_ID,
			activeOrganizationId,
		},
		user: { id: USER_ID, email: "dev@example.com", name: "Example Person" },
	};
}

/** A membership row whose organization is live. */
function liveMembership() {
	return { role: "owner", organization: { deletedAt: null } };
}

/** A membership row whose organization is in the retention window. */
function deletedMembership() {
	return {
		role: "owner",
		organization: { deletedAt: new Date("2026-09-10T09:00:00.000Z") },
	};
}

beforeEach(() => {
	mocks.memberFindUnique.mockReset();
	mocks.warn.mockReset();
});

describe("tenantContextMiddleware — a deactivated organization", () => {
	it("refuses the request", async () => {
		const mw = await loadMiddleware();
		mocks.memberFindUnique.mockResolvedValue(deletedMembership());

		await expect(invokeMw(mw, makeCtx(ORG_ID))).rejects.toThrow(ORPCError);
	});

	it("carries ORGANIZATION_DELETED, not the missing-context code", async () => {
		const mw = await loadMiddleware();
		mocks.memberFindUnique.mockResolvedValue(deletedMembership());

		// The distinction is the whole reason this is a separate code: a client
		// that cannot tell these apart cannot offer the owner the way out.
		await invokeMw(mw, makeCtx(ORG_ID)).then(
			() => expect.unreachable("expected a refusal"),
			(error: ORPCError<string, unknown>) => {
				expect(error.code).toBe("FORBIDDEN");
				expect((error.data as { errorCode?: string })?.errorCode).toBe(
					DELETED_ORGANIZATION_ERROR_CODE,
				);
				expect(
					(error.data as { errorCode?: string })?.errorCode,
				).not.toBe(MISSING_ORGANIZATION_CONTEXT_ERROR_CODE);
			},
		);
	});

	it("does not report it as a workspace-less request", async () => {
		const mw = await loadMiddleware();
		mocks.memberFindUnique.mockResolvedValue(deletedMembership());

		await invokeMw(mw, makeCtx(ORG_ID)).catch(() => undefined);

		expect(mocks.warn).not.toHaveBeenCalled();
	});

	it("lets a live organization through untouched", async () => {
		const mw = await loadMiddleware();
		mocks.memberFindUnique.mockResolvedValue(liveMembership());

		const { next } = await invokeMw(mw, makeCtx(ORG_ID));

		expect(next).toHaveBeenCalledTimes(1);
	});

	it("answers liveness from the ONE membership lookup, not a second query", async () => {
		const mw = await loadMiddleware();
		mocks.memberFindUnique.mockResolvedValue(deletedMembership());

		await invokeMw(mw, makeCtx(ORG_ID)).catch(() => undefined);

		expect(mocks.memberFindUnique).toHaveBeenCalledTimes(1);
		// And it must actually ask for the flag, or the gate is reading
		// `undefined` and letting every deactivated workspace through.
		expect(mocks.memberFindUnique.mock.calls[0]?.[0]).toMatchObject({
			select: { organization: { select: { deletedAt: true } } },
		});
	});

	it("still refuses a non-member with the missing-context code, revealing nothing", async () => {
		const mw = await loadMiddleware();
		// No membership row at all — the caller is not in this organization,
		// deleted or otherwise, and must not be able to tell which.
		mocks.memberFindUnique.mockResolvedValue(null);

		await invokeMw(mw, makeCtx(ORG_ID)).then(
			() => expect.unreachable("expected a refusal"),
			(error: ORPCError<string, unknown>) => {
				expect((error.data as { errorCode?: string })?.errorCode).toBe(
					MISSING_ORGANIZATION_CONTEXT_ERROR_CODE,
				);
			},
		);
	});
});
