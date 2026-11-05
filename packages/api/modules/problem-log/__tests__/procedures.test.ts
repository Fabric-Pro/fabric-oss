/**
 * Problem Log procedures (Fizzy #2277): list / get / setStatus / review /
 * report.
 *
 * Offline: `@repo/database` and the oRPC procedure builders are mocked and
 * each handler is called directly. The project-role gate lives in
 * `requireProjectPermission` (stubbed here; its permission keys are checked by
 * source scan below). What these tests pin is the second gate — membership of
 * the organization that OWNS the project, resolved from the project row — and
 * that every query runs in that organization and project.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	projectFindUnique: vi.fn(),
	isOrganizationMember: vi.fn(),
	listProblemLogEntries: vi.fn(),
	getProblemLogEntry: vi.fn(),
	listProblemLogStatusHistory: vi.fn(),
	problemLogUserLabels: vi.fn(),
	setProblemLogEntryStatus: vi.fn(),
	reviewProblemLogEntry: vi.fn(),
	listProblemLogReportRows: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: { project: { findUnique: mocks.projectFindUnique } },
	isOrganizationMember: mocks.isOrganizationMember,
	listProblemLogEntries: mocks.listProblemLogEntries,
	getProblemLogEntry: mocks.getProblemLogEntry,
	listProblemLogStatusHistory: mocks.listProblemLogStatusHistory,
	problemLogUserLabels: mocks.problemLogUserLabels,
	setProblemLogEntryStatus: mocks.setProblemLogEntryStatus,
	reviewProblemLogEntry: mocks.reviewProblemLogEntry,
	listProblemLogReportRows: mocks.listProblemLogReportRows,
}));

vi.mock("../../../orpc/procedures", () => {
	const chainable: any = {
		use: () => chainable,
		input: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => ({ _handler: fn }),
	};
	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => (c: unknown) => c,
	};
});

import { getProcedure } from "../procedures/get";
import { listProcedure } from "../procedures/list";
import { reportProcedure } from "../procedures/report";
import { reviewProcedure } from "../procedures/review";
import { setStatusProcedure } from "../procedures/set-status";

type Handler = (args: { input: unknown; context: unknown }) => Promise<unknown>;
const call = (procedure: unknown, input: unknown, context = CONTEXT) =>
	(procedure as { _handler: Handler })._handler({ input, context });

const CONTEXT = {
	user: { id: "user-1", email: "dev@example.com", name: "Dev" },
	session: { impersonatedBy: null },
};
const PROJECT = { id: "proj-1", organizationId: "org-1", deletedAt: null };
const ENTRY = {
	id: "entry-1",
	organizationId: "org-1",
	projectId: "proj-1",
	status: "OPEN",
	reviewState: "CONFIRMED",
	title: "Example failure",
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.projectFindUnique.mockResolvedValue(PROJECT);
	mocks.isOrganizationMember.mockResolvedValue(true);
	mocks.listProblemLogEntries.mockResolvedValue({
		items: [],
		nextCursor: null,
	});
	mocks.getProblemLogEntry.mockResolvedValue(ENTRY);
	mocks.listProblemLogStatusHistory.mockResolvedValue([]);
	mocks.problemLogUserLabels.mockResolvedValue(new Map());
	mocks.setProblemLogEntryStatus.mockResolvedValue({
		...ENTRY,
		status: "RESOLVED",
	});
});

async function expectOrpcError(promise: Promise<unknown>, code: string) {
	const error = await promise.catch((e: unknown) => e);
	expect(error).toBeInstanceOf(ORPCError);
	expect((error as ORPCError<string, unknown>).code).toBe(code);
	return error as ORPCError<string, { code?: string }>;
}

describe("organization membership gate", () => {
	it.each([
		["list", listProcedure, { projectId: "proj-1" }],
		["get", getProcedure, { projectId: "proj-1", entryId: "entry-1" }],
		[
			"setStatus",
			setStatusProcedure,
			{ projectId: "proj-1", entryId: "entry-1", status: "RESOLVED" },
		],
		[
			"review",
			reviewProcedure,
			{ projectId: "proj-1", entryId: "entry-1", decision: "CONFIRM" },
		],
		["report", reportProcedure, { projectId: "proj-1" }],
	] as const)(
		"%s refuses an invited project guest who is not an organization member",
		async (_name, procedure, input) => {
			mocks.isOrganizationMember.mockResolvedValue(false);
			const error = await expectOrpcError(
				call(procedure, input),
				"FORBIDDEN",
			);
			expect(error.data?.code).toBe("ORGANIZATION_MEMBERSHIP_REQUIRED");
			expect(mocks.isOrganizationMember).toHaveBeenCalledWith(
				"user-1",
				"org-1",
			);
			expect(mocks.listProblemLogEntries).not.toHaveBeenCalled();
			expect(mocks.getProblemLogEntry).not.toHaveBeenCalled();
			expect(mocks.setProblemLogEntryStatus).not.toHaveBeenCalled();
			expect(mocks.reviewProblemLogEntry).not.toHaveBeenCalled();
			expect(mocks.listProblemLogReportRows).not.toHaveBeenCalled();
		},
	);

	it("refuses a missing or trashed project as NOT_FOUND and an organization-less one as FORBIDDEN", async () => {
		// Both the input-organization guard and the membership gate read the
		// project, so each case holds for every read.
		for (const [project, code] of [
			[null, "NOT_FOUND"],
			[{ ...PROJECT, deletedAt: new Date() }, "NOT_FOUND"],
			[{ ...PROJECT, organizationId: null }, "FORBIDDEN"],
		] as const) {
			mocks.projectFindUnique.mockResolvedValue(project);
			await expectOrpcError(
				call(listProcedure, { projectId: "proj-1" }),
				code,
			);
		}
		expect(mocks.listProblemLogEntries).not.toHaveBeenCalled();
	});

	it("rejects an input organization that contradicts the project", async () => {
		await expectOrpcError(
			call(listProcedure, {
				projectId: "proj-1",
				organizationId: "org-other",
			}),
			"BAD_REQUEST",
		);
		expect(mocks.listProblemLogEntries).not.toHaveBeenCalled();
	});
});

describe("list", () => {
	it("queries the project's own organization and only this project", async () => {
		await call(listProcedure, {
			projectId: "proj-1",
			status: "OPEN",
			category: "SYSTEM_ERROR",
		});
		expect(mocks.listProblemLogEntries).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "org-1",
				projectIds: ["proj-1"],
				status: "OPEN",
				category: "SYSTEM_ERROR",
			}),
		);
	});

	it("passes a PENDING review-state filter through for the drafts strip", async () => {
		await call(listProcedure, {
			projectId: "proj-1",
			reviewState: "PENDING",
		});
		expect(mocks.listProblemLogEntries).toHaveBeenCalledWith(
			expect.objectContaining({ reviewState: "PENDING" }),
		);
	});
});

describe("review", () => {
	const PENDING = { ...ENTRY, reviewState: "PENDING" };

	it("confirms a draft as the caller, with the reviewer's edits", async () => {
		mocks.getProblemLogEntry.mockResolvedValue(PENDING);
		mocks.reviewProblemLogEntry.mockResolvedValue({
			...PENDING,
			reviewState: "CONFIRMED",
		});
		const edits = { title: "Edited", severity: "CRITICAL" };
		await call(reviewProcedure, {
			projectId: "proj-1",
			entryId: "entry-1",
			decision: "CONFIRM",
			edits,
		});
		expect(mocks.getProblemLogEntry).toHaveBeenCalledWith(
			"org-1",
			"entry-1",
		);
		expect(mocks.reviewProblemLogEntry).toHaveBeenCalledWith({
			organizationId: "org-1",
			entryId: "entry-1",
			decision: "CONFIRM",
			edits,
			actor: {
				userId: "user-1",
				emailSnapshot: "dev@example.com",
				nameSnapshot: "Dev",
				impersonatedById: null,
			},
		});
	});

	it("is CONFLICT for an entry that is not a pending draft", async () => {
		await expectOrpcError(
			call(reviewProcedure, {
				projectId: "proj-1",
				entryId: "entry-1",
				decision: "DISMISS",
			}),
			"CONFLICT",
		);
		expect(mocks.reviewProblemLogEntry).not.toHaveBeenCalled();
	});

	it("is CONFLICT when a concurrent review won", async () => {
		mocks.getProblemLogEntry.mockResolvedValue(PENDING);
		mocks.reviewProblemLogEntry.mockResolvedValue(null);
		await expectOrpcError(
			call(reviewProcedure, {
				projectId: "proj-1",
				entryId: "entry-1",
				decision: "DISMISS",
			}),
			"CONFLICT",
		);
	});

	it("is NOT_FOUND for another project's draft", async () => {
		mocks.getProblemLogEntry.mockResolvedValue({
			...PENDING,
			projectId: "proj-2",
		});
		await expectOrpcError(
			call(reviewProcedure, {
				projectId: "proj-1",
				entryId: "entry-1",
				decision: "CONFIRM",
			}),
			"NOT_FOUND",
		);
		expect(mocks.reviewProblemLogEntry).not.toHaveBeenCalled();
	});
});

describe("get", () => {
	it("returns the entry with its status history", async () => {
		mocks.listProblemLogStatusHistory.mockResolvedValue([{ id: "a1" }]);
		const result = await call(getProcedure, {
			projectId: "proj-1",
			entryId: "entry-1",
		});
		expect(result).toEqual({
			entry: ENTRY,
			history: [{ id: "a1" }],
			affectedUser: null,
		});
		expect(mocks.getProblemLogEntry).toHaveBeenCalledWith(
			"org-1",
			"entry-1",
		);
	});

	it("names the affected user only through the members-only lookup", async () => {
		mocks.getProblemLogEntry.mockResolvedValue({
			...ENTRY,
			affectedUserId: "user-9",
		});
		mocks.problemLogUserLabels.mockResolvedValue(
			new Map([["user-9", "Dev Tester"]]),
		);
		const result = await call(getProcedure, {
			projectId: "proj-1",
			entryId: "entry-1",
		});
		expect(mocks.problemLogUserLabels).toHaveBeenCalledWith("org-1", [
			"user-9",
		]);
		expect(result).toMatchObject({ affectedUser: "Dev Tester" });
	});

	it("is NOT_FOUND for another project's entry in the same organization", async () => {
		mocks.getProblemLogEntry.mockResolvedValue({
			...ENTRY,
			projectId: "proj-2",
		});
		await expectOrpcError(
			call(getProcedure, { projectId: "proj-1", entryId: "entry-1" }),
			"NOT_FOUND",
		);
		expect(mocks.listProblemLogStatusHistory).not.toHaveBeenCalled();
	});
});

describe("setStatus", () => {
	it("changes the status as the caller, carrying the note and impersonator", async () => {
		await call(
			setStatusProcedure,
			{
				projectId: "proj-1",
				entryId: "entry-1",
				status: "RESOLVED",
				note: "Fixed",
			},
			{ ...CONTEXT, session: { impersonatedBy: "admin-9" } },
		);
		expect(mocks.setProblemLogEntryStatus).toHaveBeenCalledWith({
			organizationId: "org-1",
			entryId: "entry-1",
			status: "RESOLVED",
			note: "Fixed",
			actor: {
				userId: "user-1",
				emailSnapshot: "dev@example.com",
				nameSnapshot: "Dev",
				impersonatedById: "admin-9",
			},
		});
	});

	it("refuses an entry still awaiting review", async () => {
		mocks.getProblemLogEntry.mockResolvedValue({
			...ENTRY,
			reviewState: "PENDING",
		});
		await expectOrpcError(
			call(setStatusProcedure, {
				projectId: "proj-1",
				entryId: "entry-1",
				status: "RESOLVED",
			}),
			"BAD_REQUEST",
		);
		expect(mocks.setProblemLogEntryStatus).not.toHaveBeenCalled();
	});

	it("is NOT_FOUND for another project's entry", async () => {
		mocks.getProblemLogEntry.mockResolvedValue({
			...ENTRY,
			projectId: "proj-2",
		});
		await expectOrpcError(
			call(setStatusProcedure, {
				projectId: "proj-1",
				entryId: "entry-1",
				status: "RESOLVED",
			}),
			"NOT_FOUND",
		);
		expect(mocks.setProblemLogEntryStatus).not.toHaveBeenCalled();
	});
});

describe("report", () => {
	it("reads the project's own organization with the filters and range", async () => {
		mocks.listProblemLogReportRows.mockResolvedValue({
			rows: [],
			truncated: false,
		});
		const from = new Date("2026-10-01T00:00:00Z");
		const to = new Date("2026-10-31T23:59:59Z");
		const result = await call(reportProcedure, {
			projectId: "proj-1",
			status: "OPEN",
			from,
			to,
		});
		expect(mocks.listProblemLogReportRows).toHaveBeenCalledWith({
			organizationId: "org-1",
			projectId: "proj-1",
			entryId: undefined,
			status: "OPEN",
			category: undefined,
			from,
			to,
		});
		expect(result).toMatchObject({ rows: [], truncated: false });
		expect((result as { generatedAt: unknown }).generatedAt).toBeInstanceOf(
			Date,
		);
	});
});

describe("permission wiring", () => {
	// The Permissions proxy above cannot tell keys apart, so read the source.
	const source = (file: string) =>
		readFileSync(join(__dirname, "..", "procedures", file), "utf8");

	it.each([
		["list.ts", "PROBLEM_LOG_READ"],
		["get.ts", "PROBLEM_LOG_READ"],
		["set-status.ts", "PROBLEM_LOG_MANAGE"],
		["review.ts", "PROBLEM_LOG_MANAGE"],
		["report.ts", "PROBLEM_LOG_READ"],
	])("%s requires %s", (file, permission) => {
		expect(source(file)).toContain(
			`requireProjectPermission(Permissions.${permission})`,
		);
	});
});
