/**
 * Restore from the 7-day recovery archive (Fizzy #2355).
 *
 * The properties that make the window trustworthy: an expired archive is
 * refused even if the daily purge has not run yet, a meeting relinked in the
 * meantime is refused rather than silently colliding with the unique key, and
 * the archive row is deleted only AFTER the rows are back — losing it to a
 * failed restore would make the deletion permanent by accident.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	dbMock,
	getMeetingArchiveMock,
	deleteMeetingArchiveMock,
	recordAuditMock,
	requireAdminMock,
	startWorkflowMock,
} = vi.hoisted(() => ({
	dbMock: {
		project: { findFirst: vi.fn() },
		projectLinkedMeeting: { findFirst: vi.fn() },
		$transaction: vi.fn(),
	},
	getMeetingArchiveMock: vi.fn(),
	deleteMeetingArchiveMock: vi.fn(),
	recordAuditMock: vi.fn(),
	requireAdminMock: vi.fn(),
	startWorkflowMock: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: dbMock,
	getMeetingArchive: getMeetingArchiveMock,
	deleteMeetingArchive: deleteMeetingArchiveMock,
}));

vi.mock("@repo/logs", () => ({
	logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({
		workflow: { start: startWorkflowMock },
	}),
}));

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: recordAuditMock,
}));

vi.mock("../../../lib/require-context-source-admin", () => ({
	requireContextSourceAdmin: requireAdminMock,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const build = () => {
		const chain: Record<string, unknown> = {};
		for (const k of ["use", "route", "input"]) {
			chain[k] = () => chain;
		}
		chain.handler = (fn: unknown) => fn;
		return chain;
	};
	return {
		tenantProtectedProcedure: build(),
		requireProjectPermission: () => undefined,
		Permissions: { PROJECT_UPDATE: "project:update" },
	};
});

import { restoreMeetingProcedure } from "../restore-meeting";

const handler = restoreMeetingProcedure as unknown as (args: {
	input: Record<string, unknown>;
	context: Record<string, unknown>;
}) => Promise<Record<string, unknown>>;

const CONTEXT = {
	user: { id: "user_1", name: "Test User", email: "dev@example.com" },
	session: {},
};

const PAYLOAD = {
	version: 1 as const,
	meeting: {
		linkedByUserId: "linker_1",
		joinUrl: "https://teams.microsoft.com/l/meetup-join/abc",
		subject: "Weekly sync",
		organizer: "dev@example.com",
		includedInDigest: true,
		linkedAt: new Date("2026-08-01"),
		deactivatedAt: null,
	},
	transcripts: [
		{
			meetingId: "m1",
			transcriptId: "t1",
			meetingSubject: "Weekly sync",
			meetingDate: new Date("2026-08-02"),
			summary: "s",
			keywords: [],
			speakerNames: [],
			contentLength: 10,
			wasSummarized: false,
			syncedAt: new Date("2026-08-02"),
			content: "hello",
			contextFilename: null,
		},
	],
};

function archive(overrides: Record<string, unknown> = {}) {
	return {
		id: "arch_1",
		projectId: "proj_1",
		joinUrl: PAYLOAD.meeting.joinUrl,
		payload: PAYLOAD,
		payloadTruncated: false,
		scheduledPurgeAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
		...overrides,
	};
}

const INPUT = {
	projectId: "proj_1",
	organizationId: null,
	archiveId: "arch_1",
};

beforeEach(() => {
	vi.clearAllMocks();
	dbMock.project.findFirst.mockResolvedValue({
		id: "proj_1",
		userId: "owner_1",
		organizationId: null,
	});
	dbMock.projectLinkedMeeting.findFirst.mockResolvedValue(null);
	dbMock.$transaction.mockImplementation(async () => ({
		meetingId: "linked_new",
		contextIds: ["ctx_1"],
	}));
	getMeetingArchiveMock.mockResolvedValue(archive());
	deleteMeetingArchiveMock.mockResolvedValue({ count: 1 });
	requireAdminMock.mockResolvedValue(undefined);
	startWorkflowMock.mockResolvedValue({ workflowId: "wf" });
});

describe("restoreMeetingProcedure", () => {
	it("rebuilds the meeting, re-embeds, and only then drops the archive", async () => {
		const result = await handler({ input: INPUT, context: CONTEXT });

		expect(result.success).toBe(true);
		expect(result.linkedMeetingId).toBe("linked_new");
		expect(result.transcriptsRestored).toBe(1);
		expect(result.reindexing).toBe(1);

		// Re-embedded: the vectors were purged at delete time, so without this
		// the meeting comes back readable but permanently unsearchable.
		expect(startWorkflowMock).toHaveBeenCalledWith(
			"contextEmbeddingWorkflow",
			expect.objectContaining({
				args: [expect.objectContaining({ contextId: "ctx_1" })],
			}),
		);
		expect(deleteMeetingArchiveMock).toHaveBeenCalledTimes(1);
	});

	it("refuses an expired archive even before the purge job has removed it", async () => {
		getMeetingArchiveMock.mockResolvedValue(
			archive({ scheduledPurgeAt: new Date(Date.now() - 1000) }),
		);

		await expect(
			handler({ input: INPUT, context: CONTEXT }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		// The archive survives: expiry is the purge job's call, not restore's.
		expect(deleteMeetingArchiveMock).not.toHaveBeenCalled();
	});

	it("refuses when the meeting was linked again in the meantime", async () => {
		dbMock.projectLinkedMeeting.findFirst.mockResolvedValue({
			id: "linked_existing",
		});

		await expect(
			handler({ input: INPUT, context: CONTEXT }),
		).rejects.toMatchObject({ code: "CONFLICT" });

		expect(dbMock.$transaction).not.toHaveBeenCalled();
		expect(deleteMeetingArchiveMock).not.toHaveBeenCalled();
	});

	it("stamps restored rows with the project's organization, not the caller's", async () => {
		dbMock.project.findFirst.mockResolvedValue({
			id: "proj_1",
			userId: "owner_1",
			organizationId: "org_real",
		});

		const contentRows: Record<string, unknown>[] = [];
		let linkedRow: Record<string, unknown> | undefined;
		const capture = (
			id: string,
			sink: (d: Record<string, unknown>) => void,
		) => ({
			create: async (args: { data: Record<string, unknown> }) => {
				sink(args.data);
				return { id };
			},
		});
		dbMock.$transaction.mockImplementation(
			async (fn: (tx: unknown) => Promise<unknown>) =>
				fn({
					projectLinkedMeeting: capture("linked_new", (d) => {
						linkedRow = d;
					}),
					projectContext: capture("ctx_1", (d) => {
						contentRows.push(d);
					}),
					projectMeetingTranscript: capture("tr_1", (d) => {
						contentRows.push(d);
					}),
				}),
		);

		await handler({
			input: { ...INPUT, organizationId: "org_forged" },
			context: CONTEXT,
		});

		// The organization is read off the authorized project row. Resolving it
		// from the input let the caller choose which tenant a restore wrote
		// into — the project lookup happened to fail closed, but only because
		// it also filtered on the claim.
		expect(contentRows.length).toBeGreaterThan(0);
		for (const data of [...contentRows, linkedRow]) {
			expect(data?.organizationId).toBe("org_real");
		}
		// Content rows carry the tenant. The linked meeting is the exception:
		// its `userId` is the LINKER, asserted in its own test below.
		for (const data of contentRows) {
			expect(data.userId).toBeNull();
		}

		// Same organization on the audit row and the re-embedding workflow, or
		// the restore is accounted to one tenant and indexed under another.
		expect(recordAuditMock).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ organizationId: "org_real" }),
		);
		expect(startWorkflowMock).toHaveBeenCalledWith(
			"contextEmbeddingWorkflow",
			expect.objectContaining({
				args: [expect.objectContaining({ organizationId: "org_real" })],
			}),
		);

		// The lookup itself is by id alone: the middleware already authorized
		// this project for this user, so re-filtering on a caller-supplied
		// organization only decided which claim could 404 it.
		expect(dbMock.project.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: "proj_1" } }),
		);
	});

	it("keeps a personal project's rows on the project owner, not the caller", async () => {
		dbMock.project.findFirst.mockResolvedValue({
			id: "proj_1",
			userId: "owner_1",
			organizationId: null,
		});

		const contentRows: Record<string, unknown>[] = [];
		const capture = (id: string) => ({
			create: async (args: { data: Record<string, unknown> }) => {
				contentRows.push(args.data);
				return { id };
			},
		});
		dbMock.$transaction.mockImplementation(
			async (fn: (tx: unknown) => Promise<unknown>) =>
				fn({
					projectLinkedMeeting: { create: async () => ({ id: "l" }) },
					projectContext: capture("ctx_1"),
					projectMeetingTranscript: capture("tr_1"),
				}),
		);

		// CONTEXT is user_1, who is not owner_1 — a project member restoring
		// someone else's personal project must not re-tenant its rows onto
		// themselves.
		await handler({ input: INPUT, context: CONTEXT });

		expect(contentRows.length).toBeGreaterThan(0);
		for (const data of contentRows) {
			expect(data.userId).toBe("owner_1");
			expect(data.organizationId).toBeUndefined();
		}
	});

	it("puts the meeting back under whoever linked it", async () => {
		dbMock.project.findFirst.mockResolvedValue({
			id: "proj_1",
			userId: "owner_1",
			organizationId: "org_real",
		});

		let linked: Record<string, unknown> | undefined;
		dbMock.$transaction.mockImplementation(
			async (fn: (tx: unknown) => Promise<unknown>) =>
				fn({
					projectLinkedMeeting: {
						create: async (args: {
							data: Record<string, unknown>;
						}) => {
							linked = args.data;
							return { id: "linked_new" };
						},
					},
					projectContext: {
						create: async () => ({ id: "ctx_1" }),
					},
					projectMeetingTranscript: { create: async () => ({}) },
				}),
		);

		await handler({ input: INPUT, context: CONTEXT });

		// On this table `userId` is who LINKED the meeting, not the tenant —
		// linking writes it for org projects too. Restoring through the tenant
		// expression replaced it with null, losing the attribution silently,
		// because nothing reads the column yet.
		expect(linked?.userId).toBe("linker_1");
		expect(linked?.organizationId).toBe("org_real");
	});

	it("refuses a missing archive", async () => {
		getMeetingArchiveMock.mockResolvedValue(null);

		await expect(
			handler({ input: INPUT, context: CONTEXT }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("is gated by the same admin check as deleting", async () => {
		requireAdminMock.mockRejectedValue(
			Object.assign(new Error("nope"), { code: "FORBIDDEN" }),
		);

		await expect(
			handler({ input: INPUT, context: CONTEXT }),
		).rejects.toThrow();
		expect(dbMock.$transaction).not.toHaveBeenCalled();
	});

	it("records who restored it, and never puts the subject in the audit row", async () => {
		await handler({ input: INPUT, context: CONTEXT });

		expect(recordAuditMock).toHaveBeenCalledWith(
			CONTEXT,
			expect.objectContaining({ action: "project.meeting.restored" }),
		);
		const meta = recordAuditMock.mock.calls[0]?.[1]?.metadata ?? {};
		// A meeting subject can name a real client, and this row outlives the
		// meeting it describes.
		expect(JSON.stringify(meta)).not.toContain("Weekly sync");
	});
});
