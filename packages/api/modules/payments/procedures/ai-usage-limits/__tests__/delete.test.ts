/**
 * Unit tests for `aiUsageLimits.delete_` procedure.
 * Mocks the Prisma surface, the orpc procedure factory, the
 * `requireOrganizationAdmin` helper, and the logger so the handler can
 * be invoked directly. Covers:
 * - soft-delete: `update` is called with `archivedAt: <Date>` (the
 * row is NOT removed; counters retained for history)
 * - findFirst miss → NOT_FOUND (cross-tenant XOR + missing id both
 * fall through this path so the procedure never leaks existence)
 * - org non-admin → FORBIDDEN with the spec message
 * - audit log fires on success with event=aiUsageLimit.delete
 * Per [`testing/test-writing.md`] (AAA, mocks at the boundary) and
 * [`backend/api.md`] (ORPCError codes).
 */
import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		findFirst: vi.fn(),
		update: vi.fn(),
		requireOrganizationAdmin: vi.fn(),
		loggerInfo: vi.fn(),
		loggerWarn: vi.fn(),
		loggerError: vi.fn(),
	};
	return { handlers, mocks };
});

vi.mock("@repo/database", () => ({
	db: {
		aiUsageLimit: {
			findFirst: mocks.findFirst,
			update: mocks.update,
		},
	},
}));

vi.mock("@repo/logs", () => ({
	logger: {
		info: mocks.loggerInfo,
		warn: mocks.loggerWarn,
		error: mocks.loggerError,
		debug: vi.fn(),
	},
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.delete = fn;
			return { _handler: fn };
		},
	};
	return {
		tenantProtectedProcedure: chainable,
		resolveOrganizationId: (
			organizationId: string | null | undefined,
			session: { activeOrganizationId?: string | null },
		) => organizationId ?? session.activeOrganizationId ?? undefined,
		requireOrganizationAdmin: (orgId: string, userId: string) =>
			mocks.requireOrganizationAdmin(orgId, userId),
	};
});

await import("../delete");

const personalCtx = {
	user: { id: "user-1" },
	session: { activeOrganizationId: null },
};

const orgCtx = {
	user: { id: "user-1" },
	session: { activeOrganizationId: null },
};

beforeEach(() => {
	mocks.findFirst.mockReset();
	mocks.update.mockReset();
	mocks.requireOrganizationAdmin.mockReset();
	mocks.loggerInfo.mockReset();
	mocks.loggerWarn.mockReset();
	mocks.loggerError.mockReset();
	// Default: admin check resolves successfully.
	mocks.requireOrganizationAdmin.mockResolvedValue({
		role: "admin",
		organization: { id: "org-A" },
	});
});

describe("aiUsageLimits.delete — soft delete", () => {
	it("personal context: sets archivedAt = <Date> instead of removing the row", async () => {
		mocks.findFirst.mockResolvedValue({ id: "limit-1" });
		mocks.update.mockResolvedValue({ id: "limit-1" });

		const result = await handlers.delete({
			input: { id: "limit-1", organizationId: null },
			context: personalCtx,
		});

		expect(result).toEqual({ archived: true });
		expect(mocks.update).toHaveBeenCalledWith({
			where: { id: "limit-1" },
			data: { archivedAt: expect.any(Date) },
		});
		// Sanity — the value passed to `archivedAt` is a real Date close
		// to now (not e.g. an ISO string).
		const updateArgs = mocks.update.mock.calls[0]?.[0];
		expect(updateArgs.data.archivedAt).toBeInstanceOf(Date);
	});

	it("findFirst pre-check uses the personal scope (userId, organizationId: null, archivedAt: null)", async () => {
		mocks.findFirst.mockResolvedValue({ id: "limit-1" });
		mocks.update.mockResolvedValue({ id: "limit-1" });

		await handlers.delete({
			input: { id: "limit-1", organizationId: null },
			context: personalCtx,
		});

		expect(mocks.findFirst).toHaveBeenCalledWith({
			where: {
				id: "limit-1",
				userId: "user-1",
				organizationId: null,
				archivedAt: null,
			},
			select: { id: true },
		});
	});

	it("org context admin: uses the org scope (organizationId, userId: null, archivedAt: null)", async () => {
		mocks.findFirst.mockResolvedValue({ id: "limit-org-1" });
		mocks.update.mockResolvedValue({ id: "limit-org-1" });

		await handlers.delete({
			input: { id: "limit-org-1", organizationId: "org-A" },
			context: orgCtx,
		});

		expect(mocks.requireOrganizationAdmin).toHaveBeenCalledWith(
			"org-A",
			"user-1",
		);
		expect(mocks.findFirst).toHaveBeenCalledWith({
			where: {
				id: "limit-org-1",
				organizationId: "org-A",
				userId: null,
				archivedAt: null,
			},
			select: { id: true },
		});
	});
});

describe("aiUsageLimits.delete — NOT_FOUND on miss / cross-tenant", () => {
	it("findFirst miss → NOT_FOUND (no update, no audit log)", async () => {
		mocks.findFirst.mockResolvedValue(null);

		const error = await handlers
			.delete({
				input: { id: "limit-missing", organizationId: null },
				context: personalCtx,
			})
			.then(
				() => {
					throw new Error("expected handler to throw");
				},
				(err: unknown) => err,
			);

		expect(error).toBeInstanceOf(ORPCError);
		expect((error as ORPCError<string, unknown>).code).toBe("NOT_FOUND");
		expect(mocks.update).not.toHaveBeenCalled();
		expect(mocks.loggerInfo).not.toHaveBeenCalled();
	});

	it("cross-tenant id (personal caller, org-scoped row): NOT_FOUND, never reveals the row's tenant", async () => {
		// findFirst pre-check filters by `userId = caller AND organizationId
		// = null`. A row owned by org-A would not match this filter, so the
		// procedure must throw NOT_FOUND, not FORBIDDEN.
		mocks.findFirst.mockResolvedValue(null);

		await expect(
			handlers.delete({
				input: { id: "limit-belongs-to-org-A", organizationId: null },
				context: personalCtx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		expect(mocks.update).not.toHaveBeenCalled();
	});
});

describe("aiUsageLimits.delete — FORBIDDEN for non-admin in org context", () => {
	it("non-admin (helper rejects): throws FORBIDDEN with the spec message; no DB read or write", async () => {
		mocks.requireOrganizationAdmin.mockRejectedValue(
			new ORPCError("FORBIDDEN", { message: "membership denied" }),
		);

		const error = await handlers
			.delete({
				input: { id: "limit-org-1", organizationId: "org-A" },
				context: orgCtx,
			})
			.then(
				() => {
					throw new Error("expected handler to throw");
				},
				(err: unknown) => err,
			);

		expect(error).toBeInstanceOf(ORPCError);
		expect((error as ORPCError<string, unknown>).code).toBe("FORBIDDEN");
		expect((error as ORPCError<string, unknown>).message).toMatch(
			/owners or admins/i,
		);
		expect(mocks.findFirst).not.toHaveBeenCalled();
		expect(mocks.update).not.toHaveBeenCalled();
	});
});

describe("aiUsageLimits.delete — audit logging", () => {
	it("logger.info fires on successful delete with event=aiUsageLimit.delete and the [AuditLog] tag", async () => {
		mocks.findFirst.mockResolvedValue({ id: "limit-audit" });
		mocks.update.mockResolvedValue({ id: "limit-audit" });

		await handlers.delete({
			input: { id: "limit-audit", organizationId: null },
			context: personalCtx,
		});

		expect(mocks.loggerInfo).toHaveBeenCalledTimes(1);
		const [payload, message] = mocks.loggerInfo.mock.calls[0] ?? [];
		expect(payload).toMatchObject({
			event: "aiUsageLimit.delete",
			limitId: "limit-audit",
			by: "user-1",
		});
		expect(message).toContain("[AuditLog]");
		expect(message).toContain("delete");
	});

	it("audit-log failure is swallowed — handler still returns { archived: true }", async () => {
		mocks.findFirst.mockResolvedValue({ id: "limit-audit-fail" });
		mocks.update.mockResolvedValue({ id: "limit-audit-fail" });
		mocks.loggerInfo.mockImplementation(() => {
			throw new Error("logger transport down");
		});
		const consoleWarnSpy = vi
			.spyOn(console, "warn")
			.mockImplementation(() => {});

		const result = await handlers.delete({
			input: { id: "limit-audit-fail", organizationId: null },
			context: personalCtx,
		});

		expect(result).toEqual({ archived: true });
		expect(consoleWarnSpy).toHaveBeenCalledWith(
			expect.stringContaining("[AuditLog]"),
			expect.any(Error),
		);
		consoleWarnSpy.mockRestore();
	});

	it("audit log payload includes organizationId/userId for org context", async () => {
		mocks.findFirst.mockResolvedValue({ id: "limit-org-audit" });
		mocks.update.mockResolvedValue({ id: "limit-org-audit" });

		await handlers.delete({
			input: { id: "limit-org-audit", organizationId: "org-A" },
			context: orgCtx,
		});

		const [payload] = mocks.loggerInfo.mock.calls[0] ?? [];
		expect(payload).toMatchObject({
			organizationId: "org-A",
			userId: null,
			tenant: "org-A",
		});
	});
});
