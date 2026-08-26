/**
 * Spans must be persisted with a tenant the reader can match.
 *
 * `auditTimingMiddleware` opens the span frame INSIDE the auth chain, so at open
 * time there is no session and the frame's tenant fields are null. Those nulls
 * were persisted verbatim — and `audit.tracedRequest` scopes its span read to
 * `organizationId IS NULL AND userId = <caller>` in personal context, which a
 * null-userId row can never match. So every span ever written was unreadable by
 * the only surface that reads them.
 *
 * This is the same failure shape as the audit rows that were written tenant-less:
 * the data exists, and no scoped query can reach it. It stayed hidden because the
 * `$use` bug meant no spans were being produced at all — fixing that revealed
 * this.
 *
 * The assertions are on the TENANT FIELDS OF THE PERSISTED ROW, which is the
 * layer the defect lives in. A test that only checked "spans were written" passed
 * throughout.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const createMany = vi.fn();

vi.mock("@repo/database", () => ({
	db: { requestSpan: { createMany: (...a: unknown[]) => createMany(...a) } },
	Prisma: { JsonNull: "DbNull" as unknown },
	// The flush redacts span attributes before persisting. Omitting this makes the
	// redactor call throw, and the flush's own try/catch swallows it — so the write
	// silently never happens and the test reads as "no spans written".
	redactSensitiveKeys: (input: unknown) => input,
}));
vi.mock("@repo/logs", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

import {
	bufferSpan,
	flushSpansOnFailure,
	runWithRequestSpanContext,
} from "../request-span";

/** The tenant state the frame is opened with: auth has not run yet. */
const FRAME_BEFORE_AUTH = {
	correlationId: "req_abc",
	organizationId: null as string | null,
	userId: null as string | null,
};

function span() {
	return {
		kind: "db" as const,
		name: "AuditLog.findMany",
		startedAt: new Date("2026-08-07T00:00:00.000Z"),
		durationMs: 3,
		status: "ok" as const,
		errorMessage: null,
	};
}

const rows = () => createMany.mock.calls[0]?.[0]?.data ?? [];

beforeEach(() => {
	vi.clearAllMocks();
	createMany.mockResolvedValue({ count: 1 });
});

describe("the resolved tenant is stamped onto the span rows", () => {
	it("writes the caller's userId in personal context, so the reader can match", async () => {
		await runWithRequestSpanContext(FRAME_BEFORE_AUTH, async () => {
			bufferSpan(span());
			await flushSpansOnFailure("req_abc", {
				organizationId: null,
				userId: "user_1",
			});
		});

		expect(rows()).toHaveLength(1);
		// Both fields matter: tracedRequest's personal branch is
		// `organizationId: null, userId: scope.userId`.
		expect(rows()[0]).toMatchObject({
			correlationId: "req_abc",
			organizationId: null,
			userId: "user_1",
		});
	});

	it("writes the organizationId in org context", async () => {
		await runWithRequestSpanContext(FRAME_BEFORE_AUTH, async () => {
			bufferSpan(span());
			await flushSpansOnFailure("req_abc", {
				organizationId: "org_1",
				userId: "user_1",
			});
		});

		expect(rows()[0]).toMatchObject({
			organizationId: "org_1",
			userId: "user_1",
		});
	});

	it("falls back to the frame's nulls when no tenant could be resolved", async () => {
		// An unauthenticated failure has no tenant to stamp. Keeping the nulls is
		// the previous behaviour — deliberately not a guess, since attributing a
		// span to the wrong tenant would leak it across the XOR boundary.
		await runWithRequestSpanContext(FRAME_BEFORE_AUTH, async () => {
			bufferSpan(span());
			await flushSpansOnFailure("req_abc");
		});

		expect(rows()[0]).toMatchObject({ organizationId: null, userId: null });
	});

	it("still keys the rows to the resolved correlationId", async () => {
		// The trace key and the tenant are resolved together; neither may be lost.
		await runWithRequestSpanContext(FRAME_BEFORE_AUTH, async () => {
			bufferSpan(span());
			await flushSpansOnFailure("req_resolved", {
				organizationId: null,
				userId: "user_1",
			});
		});

		expect(rows()[0]).toMatchObject({
			correlationId: "req_resolved",
			userId: "user_1",
		});
	});
});

describe("flush safety is unchanged", () => {
	it("writes nothing when the buffer is empty", async () => {
		await runWithRequestSpanContext(FRAME_BEFORE_AUTH, async () => {
			await flushSpansOnFailure("req_abc", {
				organizationId: null,
				userId: "user_1",
			});
		});
		expect(createMany).not.toHaveBeenCalled();
	});

	it("does not write twice for one frame", async () => {
		await runWithRequestSpanContext(FRAME_BEFORE_AUTH, async () => {
			bufferSpan(span());
			await flushSpansOnFailure("req_abc", {
				organizationId: null,
				userId: "u",
			});
			await flushSpansOnFailure("req_abc", {
				organizationId: null,
				userId: "u",
			});
		});
		expect(createMany).toHaveBeenCalledTimes(1);
	});
});
