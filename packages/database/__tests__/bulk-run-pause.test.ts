/**
 * Bulk runs paused for a ChatGPT plan reset (Fizzy #2770): every transition
 * is a compare-and-set on the status and the pause count, so the scheduled
 * resume, "Run now on API billing", Cancel and the sweep can race and exactly
 * one wins. Run against an in-memory table that applies the same `where`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown> & { id: string };

const table = vi.hoisted(() => ({ rows: new Map<string, Row>() }));
const providers = vi.hoisted(() => ({ rows: [] as Row[] }));
/** Project documents, which a paused batch or setup queues for its resume. */
const documents = vi.hoisted(() => ({ rows: [] as Row[] }));

function matches(row: Row, where: Record<string, unknown>): boolean {
	return Object.entries(where).every(([key, condition]) => {
		const value = row[key];
		if (
			condition &&
			typeof condition === "object" &&
			!(condition instanceof Date)
		) {
			const c = condition as { in?: unknown[]; not?: unknown; lt?: Date };
			if (c.in) {
				return c.in.includes(value);
			}
			if ("not" in c) {
				return value !== c.not && value !== undefined;
			}
			if (c.lt) {
				return value instanceof Date && value < c.lt;
			}
		}
		return value === condition;
	});
}

const notices = vi.hoisted(() => ({ stopped: vi.fn() }));

vi.mock("../prisma/queries/chatgpt-plan-work-notifications", () => ({
	notifyBulkRunPlanStopped: notices.stopped,
}));

vi.mock("../prisma/client", () => {
	const delegate = {
		findUnique: async ({ where }: { where: { id: string } }) => {
			// A snapshot, as Prisma returns: later writes do not change it.
			const row = table.rows.get(where.id);
			return row ? { ...row } : null;
		},
		updateMany: async ({
			where,
			data,
		}: {
			where: Record<string, unknown>;
			data: Record<string, unknown>;
		}) => {
			let count = 0;
			for (const row of table.rows.values()) {
				if (matches(row, where)) {
					Object.assign(row, data);
					count++;
				}
			}
			return { count };
		},
		findMany: async ({ where }: { where: Record<string, unknown> }) =>
			[...table.rows.values()]
				.filter((row) => matches(row, where))
				.map((row) => ({ ...row })),
	};
	return {
		db: {
			projectScan: delegate,
			scanFindingReview: delegate,
			scanFindingGrouping: delegate,
			agentTask: delegate,
			projectDocument: {
				findMany: async ({
					where,
				}: {
					where: Record<string, unknown>;
				}) =>
					documents.rows
						.filter((row) => matches(row, where))
						.map((row) => ({ id: row.id })),
			},
			cloudProviderConfig: {
				findMany: async ({
					where,
				}: {
					where: Record<string, unknown>;
				}) => providers.rows.filter((row) => matches(row, where)),
			},
		},
	};
});

import {
	approveBulkRunApiOverride,
	BULK_RUN_RESUME_NEVER_STARTED_MESSAGE,
	type BulkRunResumeState,
	bulkRunApiResumeWorkflowId,
	bulkRunResumeWorkflowId,
	cancelPausedBulkRun,
	claimBulkRunResume,
	failOverdueBulkRunResumes,
	getBulkRunPauseStage,
	organizationHasLlmApiProvider,
	recordBulkRunPause,
	revertBulkRunApiOverride,
} from "../prisma/queries/bulk-run-pause";

const NOW = new Date("2026-10-12T12:00:00.000Z");
const HOUR = 60 * 60_000;
const state: BulkRunResumeState = {
	workflowType: "securityAccessibilityScanWorkflow",
	taskQueue: "fabric-worker",
	workflowIdBase: "security-scan-scan-1",
	input: { scanId: "scan-1" },
	progress: { security: { progress: { doneItemKeys: ["a"] } } },
};

function seed(overrides: Partial<Row> = {}): Row {
	const row: Row = {
		id: "scan-1",
		projectId: "project-1",
		status: "RUNNING",
		pauseCount: 0,
		firstPausedAt: null,
		resumesAt: null,
		resumeState: null,
		apiOverrideAt: null,
		apiOverrideByUserId: null,
		...overrides,
	};
	table.rows.set(row.id, row);
	return row;
}

function pause(expectedPauseCount: number, resumesAt: Date, now = NOW) {
	return recordBulkRunPause({
		kind: "PROJECT_SCAN",
		runId: "scan-1",
		expectedPauseCount,
		resumesAt,
		resumeState: state,
		resumeWorkflowId: bulkRunResumeWorkflowId(
			"security-scan-scan-1",
			expectedPauseCount + 1,
		),
		now,
	});
}

beforeEach(() => {
	notices.stopped.mockClear();
	table.rows.clear();
	documents.rows = [];
});

describe("recordBulkRunPause", () => {
	it("marks the run WAITING_FOR_PLAN with resumesAt, the progress and the resume's id", async () => {
		const row = seed();
		const resumesAt = new Date(NOW.getTime() + 3 * HOUR);

		await expect(pause(0, resumesAt)).resolves.toEqual({
			status: "paused",
			pauseCount: 1,
			resumesAt,
		});
		expect(row).toMatchObject({
			status: "WAITING_FOR_PLAN",
			resumesAt,
			pauseCount: 1,
			firstPausedAt: NOW,
			resumeState: state,
			workflowId: "security-scan-scan-1-resume-1",
		});
	});

	it("answers a retried write with its own earlier one", async () => {
		seed();
		const resumesAt = new Date(NOW.getTime() + 3 * HOUR);
		await pause(0, resumesAt);

		await expect(
			pause(0, new Date(NOW.getTime() + 4 * HOUR)),
		).resolves.toEqual({ status: "paused", pauseCount: 1, resumesAt });
	});

	it("refuses a seventh pause", async () => {
		seed({ pauseCount: 6, firstPausedAt: NOW });

		await expect(pause(6, new Date(NOW.getTime() + HOUR))).resolves.toEqual(
			{ status: "cap", pauseCount: 6 },
		);
	});

	it("refuses a resume more than 24 hours after the first pause", async () => {
		const row = seed({
			pauseCount: 2,
			firstPausedAt: new Date(NOW.getTime() - 22 * HOUR),
		});

		await expect(
			pause(2, new Date(NOW.getTime() + 3 * HOUR)),
		).resolves.toEqual({ status: "cap", pauseCount: 2 });
		expect(row.status).toBe("RUNNING");
	});

	it("leaves a cancelled run alone", async () => {
		seed({ status: "FAILED" });

		await expect(pause(0, new Date(NOW.getTime() + HOUR))).resolves.toEqual(
			{ status: "gone" },
		);
	});

	it("saves a retry's state over the earlier attempt's while the run still waits", async () => {
		const row = seed();
		const resumesAt = new Date(NOW.getTime() + 3 * HOUR);
		await pause(0, resumesAt);
		const retried: BulkRunResumeState = {
			...state,
			progress: { security: { progress: { doneItemKeys: ["a", "b"] } } },
		};

		await expect(
			recordBulkRunPause({
				kind: "PROJECT_SCAN",
				runId: "scan-1",
				expectedPauseCount: 0,
				resumesAt: new Date(NOW.getTime() + 4 * HOUR),
				resumeState: retried,
				resumeWorkflowId: "security-scan-scan-1-resume-1",
			}),
		).resolves.toEqual({ status: "paused", pauseCount: 1, resumesAt });
		expect(row).toMatchObject({
			status: "WAITING_FOR_PLAN",
			resumesAt,
			resumeState: retried,
		});
	});

	it("answers a retry after a resume took the run back with resumed, and changes nothing", async () => {
		const approved = seed({
			status: "PENDING",
			pauseCount: 1,
			resumeState: state,
			apiOverrideAt: NOW,
			workflowId: "security-scan-scan-1-resume-1-api",
		});
		const snapshot = { ...approved };

		await expect(pause(0, new Date(NOW.getTime() + HOUR))).resolves.toEqual(
			{ status: "resumed", pauseCount: 1 },
		);
		expect(approved).toEqual(snapshot);

		seed({ status: "RUNNING", pauseCount: 1, resumeState: state });
		await expect(pause(0, new Date(NOW.getTime() + HOUR))).resolves.toEqual(
			{ status: "resumed", pauseCount: 1 },
		);
	});

	it("answers a retry after a Cancel of the paused run with gone", async () => {
		seed({ status: "FAILED", pauseCount: 1, resumeState: state });

		await expect(pause(0, new Date(NOW.getTime() + HOUR))).resolves.toEqual(
			{ status: "gone" },
		);
	});
});

describe("getBulkRunPauseStage", () => {
	const stage = () =>
		getBulkRunPauseStage({
			kind: "PROJECT_SCAN",
			runId: "scan-1",
			expectedPauseCount: 1,
		});

	it("reads where a run stands for the pause it started at a count", async () => {
		seed({ status: "RUNNING", pauseCount: 1 });
		await expect(stage()).resolves.toBe("pausing");
		seed({ status: "WAITING_FOR_PLAN", pauseCount: 2 });
		await expect(stage()).resolves.toBe("paused");
		seed({ status: "PENDING", pauseCount: 2, apiOverrideAt: NOW });
		await expect(stage()).resolves.toBe("resumed");
		seed({ status: "COMPLETED", pauseCount: 2 });
		await expect(stage()).resolves.toBe("resumed");
		seed({ status: "WAITING_FOR_PLAN", pauseCount: 3 });
		await expect(stage()).resolves.toBe("resumed");
		seed({ status: "FAILED", pauseCount: 2 });
		await expect(stage()).resolves.toBe("gone");
		seed({ status: "FAILED", pauseCount: 1 });
		await expect(stage()).resolves.toBe("gone");
		table.rows.clear();
		await expect(stage()).resolves.toBe("gone");
	});
});

/**
 * A paused batch or setup resumes only the documents its run still holds
 * (Fizzy #2946): each waits QUEUED under the scheduled resume, and one that
 * does not was taken since.
 */
describe("the documents a paused batch or setup resumes", () => {
	const BATCH_BASE = "batch-document-generation-project-1-1";
	const batchState: BulkRunResumeState = {
		workflowType: "batchDocumentGenerationWorkflow",
		taskQueue: "project-documents",
		workflowIdBase: BATCH_BASE,
		input: {
			projectId: "project-1",
			aiToken: "",
			documents: [
				{ id: "doc-2", type: "PROPOSAL" },
				{ id: "doc-3", type: "PRD" },
			],
		},
		progress: { results: [] },
	};
	const queued = (id: string, workflowId: string): Row => ({
		id,
		status: "QUEUED",
		workflowId,
	});
	const approve = (kind: "DOCUMENT_BATCH" | "PROJECT_SETUP") =>
		approveBulkRunApiOverride({
			kind,
			runId: "task-1",
			userId: "user-2",
			now: NOW,
		});
	const documentIds = (saved: unknown) =>
		(
			saved as { input: { documents: Array<{ id: string }> } }
		).input.documents.map((doc) => doc.id);

	it("Run now starts a batch from the documents still queued for its scheduled resume, and saves that list", async () => {
		const row = seed({
			id: "task-1",
			status: "WAITING_FOR_PLAN",
			pauseCount: 1,
			resumeState: batchState,
			resumesAt: NOW,
		});
		documents.rows = [
			queued("doc-2", `${BATCH_BASE}-resume-1`),
			// Its scheduled resume never started, so a person's generation
			// of it took the row.
			queued("doc-3", "project-document-generation-doc-3-4567ef01"),
		];

		const approved = await approve("DOCUMENT_BATCH");

		expect(documentIds(approved?.resumeState)).toEqual(["doc-2"]);
		expect(documentIds(row.resumeState)).toEqual(["doc-2"]);
		expect(row.status).toBe("PENDING");
	});

	it("Run now marks a setup's document taken since finished, so its resume skips it", async () => {
		const SETUP_BASE = "existing-setup-project-1-1";
		const progress = {
			documents: [
				{ id: "doc-1", type: "PRD" },
				{ id: "doc-2", type: "PROPOSAL" },
				{ id: "doc-3", type: "ARCHITECTURE" },
			],
			documentIds: ["doc-1"],
			finishedDocumentIds: ["doc-1"],
		};
		const row = seed({
			id: "task-1",
			status: "WAITING_FOR_PLAN",
			pauseCount: 1,
			resumeState: {
				...batchState,
				workflowType: "existingProjectSetupWorkflow",
				workflowIdBase: SETUP_BASE,
				input: { projectId: "project-1", aiToken: "" },
				progress,
			},
			resumesAt: NOW,
		});
		documents.rows = [
			queued("doc-2", "project-document-generation-doc-2-0123abcd"),
			queued("doc-3", `${SETUP_BASE}-resume-1`),
		];

		const approved = await approve("PROJECT_SETUP");

		const expected = {
			...progress,
			finishedDocumentIds: ["doc-1", "doc-2"],
		};
		expect(approved?.resumeState.progress).toEqual(expected);
		expect((row.resumeState as BulkRunResumeState).progress).toEqual(
			expected,
		);
	});

	it("a failed schedule, a newer generation, the retry, then Run now: Run now starts without the taken document", async () => {
		const row = seed({ id: "task-1", status: "RUNNING" });
		const resumesAt = new Date(NOW.getTime() + HOUR);
		const record = (resumeState: BulkRunResumeState) =>
			recordBulkRunPause({
				kind: "DOCUMENT_BATCH",
				runId: "task-1",
				expectedPauseCount: 0,
				resumesAt,
				resumeState,
				resumeWorkflowId: `${BATCH_BASE}-resume-1`,
				now: NOW,
			});
		// The first attempt queued both and recorded the pause; its
		// schedule then failed.
		await record(batchState);
		documents.rows = [
			queued("doc-2", `${BATCH_BASE}-resume-1`),
			queued("doc-3", "project-document-generation-doc-3-4567ef01"),
		];
		// The retry holds doc-2 only.
		await record({
			...batchState,
			input: { ...batchState.input, documents: [{ id: "doc-2" }] },
		});
		expect(documentIds(row.resumeState)).toEqual(["doc-2"]);

		const approved = await approve("DOCUMENT_BATCH");

		expect(documentIds(approved?.resumeState)).toEqual(["doc-2"]);
	});

	it("Run now starts a batch as saved when every document still waits for its resume", async () => {
		const row = seed({
			id: "task-1",
			status: "WAITING_FOR_PLAN",
			pauseCount: 1,
			resumeState: batchState,
			resumesAt: NOW,
		});
		documents.rows = [
			queued("doc-2", `${BATCH_BASE}-resume-1`),
			queued("doc-3", `${BATCH_BASE}-resume-1`),
		];

		const approved = await approve("DOCUMENT_BATCH");

		expect(approved?.resumeState).toBe(batchState);
		expect(row.resumeState).toBe(batchState);
	});
});

describe("claimBulkRunResume", () => {
	it("the scheduled resume claims a waiting row at its pause count", async () => {
		const row = seed({
			status: "WAITING_FOR_PLAN",
			pauseCount: 1,
			resumeState: state,
			resumesAt: NOW,
		});

		await expect(
			claimBulkRunResume({
				kind: "PROJECT_SCAN",
				runId: "scan-1",
				pauseCount: 1,
				viaApiOverride: false,
				now: NOW,
			}),
		).resolves.toEqual(state);
		// A fresh start, so the 90-minute stall sweep measures the resume.
		expect(row).toMatchObject({
			status: "RUNNING",
			resumesAt: null,
			startedAt: NOW,
		});
	});

	it("loses to a Cancel, and to a newer pause", async () => {
		seed({ status: "FAILED", pauseCount: 1 });
		await expect(
			claimBulkRunResume({
				kind: "PROJECT_SCAN",
				runId: "scan-1",
				pauseCount: 1,
				viaApiOverride: false,
			}),
		).resolves.toBeNull();

		seed({ status: "WAITING_FOR_PLAN", pauseCount: 2 });
		await expect(
			claimBulkRunResume({
				kind: "PROJECT_SCAN",
				runId: "scan-1",
				pauseCount: 1,
				viaApiOverride: false,
			}),
		).resolves.toBeNull();
	});

	it("after Run now, only the API resume claims; the scheduled one ends", async () => {
		seed({
			status: "WAITING_FOR_PLAN",
			pauseCount: 1,
			resumeState: state,
		});
		await approveBulkRunApiOverride({
			kind: "PROJECT_SCAN",
			runId: "scan-1",
			userId: "user-2",
			now: NOW,
		});

		await expect(
			claimBulkRunResume({
				kind: "PROJECT_SCAN",
				runId: "scan-1",
				pauseCount: 1,
				viaApiOverride: false,
			}),
		).resolves.toBeNull();
		await expect(
			claimBulkRunResume({
				kind: "PROJECT_SCAN",
				runId: "scan-1",
				pauseCount: 1,
				viaApiOverride: true,
			}),
		).resolves.toEqual(state);
	});
});

describe("approveBulkRunApiOverride", () => {
	it("records who let the run bill the provider, and the resume that starts now", async () => {
		const row = seed({
			status: "WAITING_FOR_PLAN",
			pauseCount: 3,
			resumeState: state,
			resumesAt: NOW,
		});

		await expect(
			approveBulkRunApiOverride({
				kind: "PROJECT_SCAN",
				runId: "scan-1",
				userId: "user-2",
				now: NOW,
			}),
		).resolves.toEqual({
			pauseCount: 3,
			resumeState: state,
			workflowId: bulkRunApiResumeWorkflowId("security-scan-scan-1", 3),
			scheduledWorkflowId: "security-scan-scan-1-resume-3",
			resumesAt: NOW,
		});
		expect(row).toMatchObject({
			status: "PENDING",
			apiOverrideAt: NOW,
			apiOverrideByUserId: "user-2",
			resumesAt: null,
			workflowId: "security-scan-scan-1-resume-3-api",
		});
	});

	it("refuses a run that is not paused", async () => {
		seed({ status: "RUNNING", resumeState: state });

		await expect(
			approveBulkRunApiOverride({
				kind: "PROJECT_SCAN",
				runId: "scan-1",
				userId: "user-2",
			}),
		).resolves.toBeNull();
	});
});

describe("cancelPausedBulkRun", () => {
	it("ends a paused run FAILED with the message", async () => {
		const row = seed({
			status: "WAITING_FOR_PLAN",
			pauseCount: 1,
			resumeState: state,
		});

		await expect(
			cancelPausedBulkRun({
				kind: "PROJECT_SCAN",
				runId: "scan-1",
				message: "Cancelled by user",
				now: NOW,
			}),
		).resolves.toEqual({ pauseCount: 1, resumeState: state });
		expect(row).toMatchObject({
			status: "FAILED",
			error: "Cancelled by user",
			completedAt: NOW,
		});
	});
});

describe("failOverdueBulkRunResumes", () => {
	it("fails only paused runs whose resume is past the grace", async () => {
		const overdue = seed({
			id: "scan-overdue",
			status: "WAITING_FOR_PLAN",
			resumesAt: new Date(NOW.getTime() - HOUR),
		});
		const waiting = seed({
			id: "scan-waiting",
			status: "WAITING_FOR_PLAN",
			resumesAt: new Date(NOW.getTime() + 3 * HOUR),
		});
		const justDue = seed({
			id: "scan-just-due",
			status: "WAITING_FOR_PLAN",
			resumesAt: new Date(NOW.getTime() - 10 * 60_000),
		});

		await expect(
			failOverdueBulkRunResumes({
				kind: "PROJECT_SCAN",
				graceMinutes: 30,
				now: NOW,
			}),
		).resolves.toBe(1);
		expect(overdue).toMatchObject({
			status: "FAILED",
			error: BULK_RUN_RESUME_NEVER_STARTED_MESSAGE,
		});
		expect(waiting.status).toBe("WAITING_FOR_PLAN");
		expect(justDue.status).toBe("WAITING_FOR_PLAN");
		// Only the run this sweep failed is announced (Fizzy #3050).
		expect(notices.stopped).toHaveBeenCalledTimes(1);
		expect(notices.stopped).toHaveBeenCalledWith({
			kind: "PROJECT_SCAN",
			runId: "scan-overdue",
			reason: "RESUME_LOST",
		});
	});
});

describe("revertBulkRunApiOverride", () => {
	it("puts an approved run whose resume never started back to wait", async () => {
		const resumesAt = new Date(NOW.getTime() + 2 * HOUR);
		const row = seed({
			status: "WAITING_FOR_PLAN",
			pauseCount: 1,
			resumeState: state,
			resumesAt,
		});
		const approved = await approveBulkRunApiOverride({
			kind: "PROJECT_SCAN",
			runId: "scan-1",
			userId: "user-2",
			now: NOW,
		});

		await expect(
			revertBulkRunApiOverride({
				kind: "PROJECT_SCAN",
				runId: "scan-1",
				pauseCount: 1,
				resumesAt: approved?.resumesAt ?? null,
				scheduledWorkflowId: approved?.scheduledWorkflowId ?? "",
			}),
		).resolves.toBe(true);
		expect(row).toMatchObject({
			status: "WAITING_FOR_PLAN",
			resumesAt,
			workflowId: "security-scan-scan-1-resume-1",
			apiOverrideAt: null,
			apiOverrideByUserId: null,
		});
		// The scheduled resume claims it on time again.
		await expect(
			claimBulkRunResume({
				kind: "PROJECT_SCAN",
				runId: "scan-1",
				pauseCount: 1,
				viaApiOverride: false,
			}),
		).resolves.toEqual(state);
	});
});

describe("organizationHasLlmApiProvider", () => {
	const provider = (overrides: Partial<Row>): Row => ({
		id: "p",
		organizationId: "org-1",
		enabled: true,
		purpose: "ALL",
		encryptedApiKey: "enc",
		clientId: null,
		encryptedClientSecret: null,
		config: null,
		...overrides,
	});

	beforeEach(() => {
		providers.rows = [];
	});

	it("is true for an enabled LLM key of the organization's own", async () => {
		providers.rows = [provider({})];
		await expect(organizationHasLlmApiProvider("org-1")).resolves.toBe(
			true,
		);
	});

	it("ignores an embeddings-only key, a disabled one, one without a credential, and another organization's", async () => {
		providers.rows = [
			provider({ id: "a", purpose: "EMBEDDINGS_ONLY" }),
			provider({ id: "b", enabled: false }),
			provider({ id: "c", encryptedApiKey: null }),
			provider({ id: "d", organizationId: "org-2" }),
		];
		await expect(organizationHasLlmApiProvider("org-1")).resolves.toBe(
			false,
		);
	});
});
