/**
 * Which rows `recordAuditFromRequest` counts as the call's curated record,
 * which silences the automatic `activity.*` row for the same call.
 *
 * A row attributed to an agent records what the AI did (the ticket an
 * approval created), not the caller's own call, so it must not silence the
 * caller's activity row: create approvals then log their approve action the
 * same way update applies do.
 *
 * External boundaries mocked: the audit writer and the timing frame.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	recordAudit: vi.fn(),
	markCuratedAuditWritten: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	ERROR_CATEGORY: "error",
	isActivityAction: (action: string) => action.startsWith("activity."),
	recordAudit: mocks.recordAudit,
	setAuditCounters: vi.fn(),
	setAuditWriteScheduler: vi.fn(),
	setPrismaQueryObserver: vi.fn(),
	db: {},
}));

vi.mock("@repo/observability", () => ({
	auditWriteFailures: { inc: vi.fn() },
	auditWritesTotal: { inc: vi.fn() },
}));

vi.mock("../../modules/weave/lib/run-in-background", () => ({
	runInBackground: vi.fn(),
}));

vi.mock("@repo/auth/lib/client-ip", () => ({
	getTrustedClientIp: () => "203.0.113.42",
}));

vi.mock("../../orpc/middleware/audit-timing-middleware", () => ({
	getAuditTimingDurationMs: () => null,
	markCuratedAuditWritten: mocks.markCuratedAuditWritten,
}));

import { recordAuditFromRequest } from "../audit";

const context = {
	headers: new Headers(),
	user: { id: "user-1", email: "reviewer@example.com", name: "Reviewer" },
	session: { id: "sess-1", impersonatedBy: null, activeOrganizationId: null },
};

beforeEach(() => {
	vi.clearAllMocks();
});

describe("recordAuditFromRequest — curated flag", () => {
	it("marks a curated row written by the caller", () => {
		recordAuditFromRequest(context, {
			action: "story.created",
			category: "story",
			organizationId: null,
		});

		expect(mocks.recordAudit).toHaveBeenCalledOnce();
		expect(mocks.markCuratedAuditWritten).toHaveBeenCalledOnce();
	});

	it("does not mark a row attributed to an agent", () => {
		recordAuditFromRequest(context, {
			action: "story.created",
			category: "story",
			actor: {
				type: "agent",
				userId: "user-1",
				nameSnapshot: "Fabric AI",
			},
			organizationId: null,
		});

		expect(mocks.recordAudit).toHaveBeenCalledOnce();
		expect(mocks.markCuratedAuditWritten).not.toHaveBeenCalled();
	});

	it("does not mark an activity or error row", () => {
		recordAuditFromRequest(context, {
			action: "activity.projects.example",
			category: "activity",
			organizationId: null,
		});
		recordAuditFromRequest(context, {
			action: "error.projects.example",
			category: "error",
			organizationId: null,
		});

		expect(mocks.markCuratedAuditWritten).not.toHaveBeenCalled();
	});
});
