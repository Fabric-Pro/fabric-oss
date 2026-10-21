/**
 * A document batch, a project setup and a legacy (non-artifact) child write a
 * document only while their run still holds it (Fizzy #2946). A person's save
 * over a stalled run completes the document, and a newer generation stamps
 * its own identity; a run that reaches the document late must write nothing
 * over either.
 *
 * - `updateProjectDocumentStatus` with `heldBy` starts a document only while
 *   the batch or setup still holds it, records the child's workflow id on it,
 *   and answers `{ held: false }` otherwise; with `heldByPause` it fails only
 *   the documents a refused pause still held; with `generationStartedAt` it
 *   writes only while the row is still that attempt and never starts one.
 * - `saveProjectDocument` and `createDocumentVersion` with
 *   `generationStartedAt` save and version only while the row is still that
 *   attempt's: a refused save throws the stale failure the child already
 *   handles and leaves no snapshot, and a refused version is skipped.
 *
 * The rows live in a small in-memory table the activities read and write by
 * the conditions they send; a transaction that throws is rolled back, as
 * Postgres does.
 */

import { normalizeQuoteArtifacts } from "@repo/utils/quote-artifacts";
import { ApplicationFailure } from "@temporalio/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DOCUMENT_GENERATION_STALE } from "../../lib/proposal-artifact/types";

type Row = {
	id: string;
	status: string;
	workflowId: string | null;
	generationStartedAt: Date | null;
	generationProgress: number;
	generationError: string | null;
	generationQueueReason: string | null;
	liveRunId: string | null;
	liveAttempt: number | null;
	liveContent: string | null;
	content: string;
	version: number;
	wordCount?: number;
};

type Condition = Record<string, unknown>;

const store = vi.hoisted(() => ({
	rows: new Map<string, Record<string, unknown>>(),
	versions: [] as Array<Record<string, unknown>>,
	/** The workflow the activity runs for. */
	workflowId: undefined as string | undefined,
	/**
	 * Runs once after the next document read, to land a racing write. That
	 * write is another transaction's, so it survives this one's rollback.
	 */
	afterRead: undefined as (() => void) | undefined,
	racesInTransaction: [] as Array<() => void>,
}));

const sameValue = (value: unknown, expected: unknown): boolean =>
	expected instanceof Date
		? value instanceof Date && value.getTime() === expected.getTime()
		: value === expected;

const matchesValue = (value: unknown, condition: unknown): boolean => {
	if (condition === null) {
		return value === null || value === undefined;
	}
	if (condition instanceof Date || typeof condition !== "object") {
		return sameValue(value, condition);
	}
	return Object.entries(condition as Condition).every(([op, arg]) => {
		switch (op) {
			case "in":
				return (arg as unknown[]).some((item) =>
					sameValue(value, item),
				);
			case "startsWith":
				return (
					typeof value === "string" && value.startsWith(arg as string)
				);
			case "gte":
				return value != null && Number(value) >= Number(arg);
			case "lte":
				return value != null && Number(value) <= Number(arg);
			default:
				throw new Error(`Unsupported condition ${op}`);
		}
	});
};

const matches = (row: Record<string, unknown>, where: Condition): boolean =>
	Object.entries(where).every(([key, condition]) =>
		key === "OR"
			? (condition as Condition[]).some((arm) => matches(row, arm))
			: matchesValue(row[key], condition),
	);

vi.mock("@repo/database", () => {
	const projectDocument = {
		findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
			const row = store.rows.get(where.id);
			const copy = row ? { ...row } : null;
			const race = store.afterRead;
			store.afterRead = undefined;
			if (race) {
				race();
				store.racesInTransaction.push(race);
			}
			return copy;
		}),
		updateMany: vi.fn(
			async ({ where, data }: { where: Condition; data: Condition }) => {
				let count = 0;
				for (const row of store.rows.values()) {
					if (matches(row, where)) {
						Object.assign(row, data);
						count++;
					}
				}
				return { count };
			},
		),
		update: vi.fn(
			async ({
				where,
				data,
			}: {
				where: { id: string };
				data: Condition;
			}) => {
				const row = store.rows.get(where.id);
				if (!row) {
					throw new Error("Record to update not found");
				}
				Object.assign(row, data);
				return { ...row };
			},
		),
	};
	const documentVersion = {
		findFirst: vi.fn(
			async ({
				where,
				orderBy,
			}: {
				where: Condition;
				orderBy?: { version: "desc" };
			}) => {
				const found = store.versions.filter((row) =>
					matches(row, where),
				);
				if (orderBy) {
					found.sort(
						(a, b) => (b.version as number) - (a.version as number),
					);
				}
				return found[0] ? { ...found[0] } : null;
			},
		),
		findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
			const row = store.versions.find(
				(version) => version.id === where.id,
			);
			return row ? { ...row } : null;
		}),
		create: vi.fn(async ({ data }: { data: Condition }) => {
			const row = {
				id: `version-${store.versions.length + 1}`,
				changeDescription: null,
				changedBy: null,
				promptVersionId: null,
				createdAt: new Date(),
				...data,
			};
			store.versions.push(row);
			return { ...row };
		}),
	};
	const client = { projectDocument, documentVersion };
	return {
		db: {
			...client,
			$transaction: vi.fn(async (fn: (tx: typeof client) => unknown) => {
				const rows = new Map(
					[...store.rows].map(([id, row]) => [id, { ...row }]),
				);
				const versions = store.versions.map((row) => ({ ...row }));
				store.racesInTransaction = [];
				try {
					return await fn(client);
				} catch (error) {
					store.rows = rows;
					store.versions = versions;
					for (const race of store.racesInTransaction) {
						race();
					}
					throw error;
				}
			}),
		},
		bulkRunResumeWorkflowId: (base: string, count: number) =>
			`${base}-resume-${count}`,
		bulkRunApiResumeWorkflowId: (base: string, count: number) =>
			`${base}-resume-${count}-api`,
		hasProjectAccess: vi.fn(),
		recordAuditDurable: vi.fn(),
		listEmbeddedDocumentsForSweep: vi.fn().mockResolvedValue([]),
	};
});

vi.mock("@langchain/langgraph-sdk", () => ({
	Client: class {},
}));

vi.mock("@repo/rag", () => ({
	buildDocumentRetrievalQuery: () => "build document retrieval query",
	searchSimilarProjectContexts: vi.fn(),
	extractBaseContextId: (id: string) => id,
	enrichContextsWithRoleTags: vi.fn(),
	applyContextSummary: vi.fn(),
	rerankContexts: vi.fn(),
	embedProjectDocument: vi.fn(),
	reembedProjectDocument: vi.fn(),
	deleteStaleDocumentEmbeddingChunks: vi.fn(),
	searchSimilarEpisodes: vi.fn().mockResolvedValue([]),
}));

vi.mock("@repo/ai", () => ({
	DEFAULT_BASE_URLS: {},
	getAIModelWithMetadata: vi.fn(),
	logModelUsageAsync: vi.fn(),
	streamText: vi.fn(),
}));

vi.mock("@repo/ai/skills", () => ({
	isTextContentType: vi.fn(),
	loadSkillBundle: vi.fn(),
	readSkillFile: vi.fn(),
}));

vi.mock("../prompt-activities", () => ({
	fetchAndRenderPrompt: vi.fn(),
	renderPromptWithContext: vi.fn(),
}));

vi.mock("../../client", () => ({
	getTemporalClient: vi.fn(),
}));

vi.mock("@temporalio/activity", async () => {
	const temporalCommon = await import("@temporalio/common");
	return {
		Context: {
			current: () => ({
				info: { workflowExecution: { workflowId: store.workflowId } },
				cancellationSignal: undefined,
				heartbeat: vi.fn(),
			}),
		},
		heartbeat: vi.fn(),
		ApplicationFailure: temporalCommon.ApplicationFailure,
	};
});

vi.mock("../lib/activity-logger", () => ({
	activityLogger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

import {
	createDocumentVersion,
	saveProjectDocument,
	updateProjectDocumentStatus,
} from "../project-document-generation";

const NOW = new Date("2026-10-21T12:00:00.000Z");
/** The attempt a parent started, minutes before the write. */
const ATTEMPT = "2026-10-21T11:50:00.000Z";
const BATCH = "batch-document-generation-project-1-1";
const SETUP = "existing-setup-project-1-1";
const NEWER_RUN = "project-document-generation-doc-1-0123abcd";

const seed = (row: Partial<Row> & { id: string }): void => {
	store.rows.set(row.id, {
		status: "DRAFT",
		workflowId: null,
		generationStartedAt: null,
		generationProgress: 0,
		generationError: null,
		generationQueueReason: null,
		liveRunId: null,
		liveAttempt: null,
		liveContent: null,
		content: "",
		version: 1,
		...row,
	});
};
const row = (id = "doc-1") => store.rows.get(id) as Row;
const unchanged = (id = "doc-1") => ({ ...row(id) });

const expectStale = (error: unknown) => {
	expect(error).toBeInstanceOf(ApplicationFailure);
	expect((error as ApplicationFailure).type).toBe(DOCUMENT_GENERATION_STALE);
	expect((error as ApplicationFailure).nonRetryable).toBe(true);
};

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	store.rows = new Map();
	store.versions = [];
	store.workflowId = BATCH;
	store.afterRead = undefined;
});

describe("updateProjectDocumentStatus — a bulk run starting a document", () => {
	const start = (
		heldBy: Parameters<typeof updateProjectDocumentStatus>[0]["heldBy"],
	) =>
		updateProjectDocumentStatus({
			documentId: "doc-1",
			status: "GENERATING",
			progress: 0,
			heldBy,
		});
	const batchChild = `${BATCH}-child-doc-1`;

	it("starts a first run's document, records its child and answers the attempt", async () => {
		seed({
			id: "doc-1",
			status: "DRAFT",
			liveRunId: "run-old",
			liveContent: "# Preview",
		});

		await expect(
			start({ kind: "DOCUMENT_BATCH", childWorkflowId: batchChild }),
		).resolves.toEqual({ generationStartedAt: NOW.toISOString() });

		expect(row()).toMatchObject({
			status: "GENERATING",
			generationProgress: 0,
			generationStartedAt: NOW,
			workflowId: batchChild,
			liveRunId: null,
			liveAttempt: null,
			liveContent: null,
			generationQueueReason: null,
		});
	});

	it("starts a setup's document queued under the setup, and one an older setup created GENERATING", async () => {
		store.workflowId = SETUP;
		seed({
			id: "doc-1",
			status: "QUEUED",
			workflowId: SETUP,
			generationStartedAt: new Date(ATTEMPT),
		});
		seed({ id: "doc-2", status: "GENERATING", workflowId: null });

		await expect(
			start({
				kind: "PROJECT_SETUP",
				childWorkflowId: `${SETUP}-doc-doc-1`,
			}),
		).resolves.toEqual({ generationStartedAt: NOW.toISOString() });
		await expect(
			updateProjectDocumentStatus({
				documentId: "doc-2",
				status: "GENERATING",
				progress: 5,
				startsAttempt: true,
				heldBy: {
					kind: "PROJECT_SETUP",
					childWorkflowId: `${SETUP}-doc-doc-2`,
				},
			}),
		).resolves.toEqual({ generationStartedAt: NOW.toISOString() });

		expect(row()).toMatchObject({
			status: "GENERATING",
			workflowId: `${SETUP}-doc-doc-1`,
			generationStartedAt: NOW,
		});
		expect(row("doc-2")).toMatchObject({
			status: "GENERATING",
			generationProgress: 5,
			workflowId: `${SETUP}-doc-doc-2`,
		});
	});

	it("leaves a first run's document another run took, and says it is not held", async () => {
		seed({
			id: "doc-1",
			status: "GENERATING",
			workflowId: NEWER_RUN,
			generationStartedAt: new Date(ATTEMPT),
		});
		const before = unchanged();

		await expect(
			start({ kind: "DOCUMENT_BATCH", childWorkflowId: batchChild }),
		).resolves.toEqual({ held: false });

		expect(row()).toEqual(before);
	});

	it("leaves a first run's document a person's save completed", async () => {
		seed({
			id: "doc-1",
			status: "COMPLETE",
			workflowId: null,
			content: "# Their edit",
		});
		const before = unchanged();

		await expect(
			start({ kind: "DOCUMENT_BATCH", childWorkflowId: batchChild }),
		).resolves.toEqual({ held: false });

		expect(row()).toEqual(before);
	});

	it("starts the document again when its own earlier attempt already started it", async () => {
		// The write landed, its result was lost, and the activity retries.
		seed({
			id: "doc-1",
			status: "GENERATING",
			workflowId: batchChild,
			generationStartedAt: new Date(ATTEMPT),
		});

		await expect(
			start({ kind: "DOCUMENT_BATCH", childWorkflowId: batchChild }),
		).resolves.toEqual({ generationStartedAt: NOW.toISOString() });
		expect(row().generationStartedAt).toEqual(NOW);
	});

	it("leaves a first run's document a person typed into while it waited", async () => {
		seed({
			id: "doc-1",
			status: "DRAFT",
			workflowId: null,
			content: "# Their notes",
		});
		const before = unchanged();

		await expect(
			start({ kind: "DOCUMENT_BATCH", childWorkflowId: batchChild }),
		).resolves.toEqual({ held: false });
		expect(row()).toEqual(before);
	});

	it("starts its own earlier attempt's document again whatever its body", async () => {
		seed({
			id: "doc-1",
			status: "GENERATING",
			workflowId: batchChild,
			content: "# Their notes",
		});

		await expect(
			start({ kind: "DOCUMENT_BATCH", childWorkflowId: batchChild }),
		).resolves.toEqual({ generationStartedAt: NOW.toISOString() });
	});

	describe("a document the stale-generation sweep failed by age", () => {
		const setupChild = `${SETUP}-doc-doc-1`;
		const swept = (content = "") =>
			seed({
				id: "doc-1",
				status: "FAILED",
				workflowId: null,
				generationError: "Generation timed out.",
				content,
			});

		it("is taken back by a setup's first run that created it before its documents were queued", async () => {
			store.workflowId = SETUP;
			swept();

			await expect(
				start({ kind: "PROJECT_SETUP", childWorkflowId: setupChild }),
			).resolves.toEqual({ generationStartedAt: NOW.toISOString() });
			expect(row()).toMatchObject({
				status: "GENERATING",
				workflowId: setupChild,
				generationStartedAt: NOW,
				generationError: null,
			});
		});

		it("is never taken by a batch", async () => {
			swept();
			const before = unchanged();

			await expect(
				start({ kind: "DOCUMENT_BATCH", childWorkflowId: batchChild }),
			).resolves.toEqual({ held: false });
			expect(row()).toEqual(before);
		});

		it("is never taken by a setup's resume", async () => {
			store.workflowId = `${SETUP}-resume-1`;
			swept();
			const before = unchanged();

			await expect(
				start({
					kind: "PROJECT_SETUP",
					childWorkflowId: `${SETUP}-resume-1-doc-doc-1`,
					resumeOf: {
						runId: "setup-task-1",
						pauseCount: 1,
						workflowIdBase: SETUP,
					},
				}),
			).resolves.toEqual({ held: false });
			expect(row()).toEqual(before);
		});

		it("is not taken back once a person typed into it", async () => {
			store.workflowId = SETUP;
			swept("# Their notes");
			const before = unchanged();

			await expect(
				start({ kind: "PROJECT_SETUP", childWorkflowId: setupChild }),
			).resolves.toEqual({ held: false });
			expect(row()).toEqual(before);
		});
	});

	describe("a resume", () => {
		const resumeOf = {
			runId: "task-1",
			pauseCount: 1,
			workflowIdBase: BATCH,
		};

		it("starts a document the pause queued for it under the scheduled id", async () => {
			store.workflowId = `${BATCH}-resume-1`;
			seed({
				id: "doc-1",
				status: "QUEUED",
				workflowId: `${BATCH}-resume-1`,
			});

			await expect(
				start({
					kind: "DOCUMENT_BATCH",
					childWorkflowId: `${BATCH}-resume-1-child-doc-1`,
					resumeOf,
				}),
			).resolves.toEqual({ generationStartedAt: NOW.toISOString() });
			expect(row()).toMatchObject({
				status: "GENERATING",
				workflowId: `${BATCH}-resume-1-child-doc-1`,
			});
		});

		it("starts a document Run now moved to its own id, and one it has not moved yet", async () => {
			store.workflowId = `${BATCH}-resume-1-api`;
			seed({
				id: "doc-1",
				status: "QUEUED",
				workflowId: `${BATCH}-resume-1-api`,
			});
			// Run now starts the resume before it moves the documents.
			seed({
				id: "doc-2",
				status: "QUEUED",
				workflowId: `${BATCH}-resume-1`,
			});

			await expect(
				start({
					kind: "DOCUMENT_BATCH",
					childWorkflowId: `${BATCH}-resume-1-api-child-doc-1`,
					resumeOf,
				}),
			).resolves.toEqual({ generationStartedAt: NOW.toISOString() });
			await expect(
				updateProjectDocumentStatus({
					documentId: "doc-2",
					status: "GENERATING",
					progress: 0,
					heldBy: {
						kind: "DOCUMENT_BATCH",
						childWorkflowId: `${BATCH}-resume-1-api-child-doc-2`,
						resumeOf,
					},
				}),
			).resolves.toEqual({ generationStartedAt: NOW.toISOString() });
		});

		it.each([
			["queued for another resume", "QUEUED", `${BATCH}-resume-2`],
			["generating under another run", "GENERATING", NEWER_RUN],
			[
				"queued under the scheduled id but no longer queued",
				"GENERATING",
				`${BATCH}-resume-1`,
			],
			["never queued for a resume", "DRAFT", null],
		])("leaves a document %s", async (_label, status, workflowId) => {
			store.workflowId = `${BATCH}-resume-1`;
			seed({ id: "doc-1", status, workflowId });
			const before = unchanged();

			await expect(
				start({
					kind: "DOCUMENT_BATCH",
					childWorkflowId: `${BATCH}-resume-1-child-doc-1`,
					resumeOf,
				}),
			).resolves.toEqual({ held: false });
			expect(row()).toEqual(before);
		});

		it("leaves a document a person typed into while it waited for the resume", async () => {
			store.workflowId = `${BATCH}-resume-1`;
			seed({
				id: "doc-1",
				status: "QUEUED",
				workflowId: `${BATCH}-resume-1`,
				content: "# Their notes",
			});
			const before = unchanged();

			await expect(
				start({
					kind: "DOCUMENT_BATCH",
					childWorkflowId: `${BATCH}-resume-1-child-doc-1`,
					resumeOf,
				}),
			).resolves.toEqual({ held: false });
			expect(row()).toEqual(before);
		});

		it("starts the document again when its own earlier attempt already started it", async () => {
			store.workflowId = `${BATCH}-resume-1`;
			seed({
				id: "doc-1",
				status: "GENERATING",
				workflowId: `${BATCH}-resume-1-child-doc-1`,
			});

			await expect(
				start({
					kind: "DOCUMENT_BATCH",
					childWorkflowId: `${BATCH}-resume-1-child-doc-1`,
					resumeOf,
				}),
			).resolves.toEqual({ generationStartedAt: NOW.toISOString() });
		});
	});
});

describe("updateProjectDocumentStatus — failing a refused pause's documents", () => {
	const fail = (
		documentId: string,
		heldByPause: Parameters<
			typeof updateProjectDocumentStatus
		>[0]["heldByPause"] = { kind: "DOCUMENT_BATCH" },
	) =>
		updateProjectDocumentStatus({
			documentId,
			status: "FAILED",
			progress: 0,
			error: "Every ChatGPT plan stayed spent.",
			heldByPause,
		});

	it("fails the documents the run still holds, and those queued for the resume that never starts", async () => {
		seed({ id: "doc-1", status: "GENERATING", workflowId: null });
		seed({
			id: "doc-2",
			status: "GENERATING",
			workflowId: `${BATCH}-child-doc-2`,
		});
		seed({
			id: "doc-3",
			status: "QUEUED",
			workflowId: `${BATCH}-resume-1`,
		});

		for (const id of ["doc-1", "doc-2", "doc-3"]) {
			await expect(fail(id)).resolves.toBeUndefined();
			expect(row(id)).toMatchObject({
				status: "FAILED",
				generationError: "Every ChatGPT plan stayed spent.",
			});
		}
	});

	it("never fails a document a person's save completed", async () => {
		seed({
			id: "doc-1",
			status: "COMPLETE",
			workflowId: `${BATCH}-resume-1`,
		});
		const before = unchanged();

		await fail("doc-1");
		expect(row()).toEqual(before);
	});

	it("never fails a document a newer run took", async () => {
		seed({ id: "doc-1", status: "GENERATING", workflowId: NEWER_RUN });
		const before = unchanged();

		await fail("doc-1");
		expect(row()).toEqual(before);
	});

	it("names a resume's next resume as its pause does", async () => {
		store.workflowId = `${BATCH}-resume-1-api`;
		const resumeOf = {
			runId: "task-1",
			pauseCount: 1,
			workflowIdBase: BATCH,
		};
		seed({
			id: "doc-1",
			status: "QUEUED",
			workflowId: `${BATCH}-resume-2`,
		});
		seed({
			id: "doc-2",
			status: "GENERATING",
			workflowId: `${BATCH}-resume-1-api-child-doc-2`,
		});
		// Under the scheduled resume's id, which Run now replaced: not this
		// run's.
		seed({
			id: "doc-3",
			status: "QUEUED",
			workflowId: `${BATCH}-resume-1`,
		});
		const before = unchanged("doc-3");

		for (const id of ["doc-1", "doc-2", "doc-3"]) {
			await fail(id, { kind: "DOCUMENT_BATCH", resumeOf });
		}
		expect(row("doc-1").status).toBe("FAILED");
		expect(row("doc-2").status).toBe("FAILED");
		expect(row("doc-3")).toEqual(before);
	});
});

describe("updateProjectDocumentStatus — a legacy attempt's writes", () => {
	it("reports progress on its own attempt and never restamps it", async () => {
		seed({
			id: "doc-1",
			status: "GENERATING",
			generationStartedAt: new Date(ATTEMPT),
			liveRunId: "run-other",
		});

		await expect(
			updateProjectDocumentStatus({
				documentId: "doc-1",
				status: "GENERATING",
				progress: 0,
				generationStartedAt: ATTEMPT,
			}),
		).resolves.toBeUndefined();

		expect(row()).toMatchObject({
			status: "GENERATING",
			generationProgress: 0,
			generationStartedAt: new Date(ATTEMPT),
			liveRunId: "run-other",
		});
	});

	it("writes nothing on a document a newer attempt owns", async () => {
		seed({
			id: "doc-1",
			status: "GENERATING",
			generationStartedAt: new Date("2026-10-21T11:55:00.000Z"),
			generationProgress: 10,
		});
		const before = unchanged();

		for (const status of ["GENERATING", "COMPLETE", "FAILED"] as const) {
			await updateProjectDocumentStatus({
				documentId: "doc-1",
				status,
				progress: 30,
				error: "boom",
				generationStartedAt: ATTEMPT,
			});
		}
		expect(row()).toEqual(before);
	});

	it("does not reopen a document a person's save completed", async () => {
		seed({
			id: "doc-1",
			status: "COMPLETE",
			generationStartedAt: new Date(ATTEMPT),
			generationProgress: 100,
		});
		const before = unchanged();

		await updateProjectDocumentStatus({
			documentId: "doc-1",
			status: "GENERATING",
			progress: 80,
			generationStartedAt: ATTEMPT,
		});
		await updateProjectDocumentStatus({
			documentId: "doc-1",
			status: "FAILED",
			progress: 0,
			error: "boom",
			generationStartedAt: ATTEMPT,
		});
		expect(row()).toEqual(before);
	});

	it("completes its attempt, whether still generating or already saved complete", async () => {
		seed({
			id: "doc-1",
			status: "GENERATING",
			generationStartedAt: new Date(ATTEMPT),
		});
		seed({
			id: "doc-2",
			status: "COMPLETE",
			generationStartedAt: new Date(ATTEMPT),
			generationProgress: 80,
		});

		for (const id of ["doc-1", "doc-2"]) {
			await updateProjectDocumentStatus({
				documentId: id,
				status: "COMPLETE",
				progress: 100,
				generationStartedAt: ATTEMPT,
			});
			expect(row(id)).toMatchObject({
				status: "COMPLETE",
				generationProgress: 100,
				generationStartedAt: new Date(ATTEMPT),
			});
		}
	});
});

describe("saveProjectDocument — a legacy attempt's save", () => {
	const save = (content = "# Regenerated") =>
		saveProjectDocument("doc-1", content, "user-1", {
			generationStartedAt: ATTEMPT,
		});

	it("saves and completes its own running attempt, with the snapshot", async () => {
		seed({
			id: "doc-1",
			status: "GENERATING",
			generationStartedAt: new Date(ATTEMPT),
			content: "# Before",
			version: 3,
		});

		await expect(save()).resolves.toBeUndefined();

		expect(row()).toMatchObject({
			status: "COMPLETE",
			content: "# Regenerated",
			version: 3,
		});
		expect(store.versions).toEqual([
			expect.objectContaining({
				version: 3,
				content: "# Before",
				changeDescription: "Pre-regeneration snapshot (auto)",
			}),
		]);
	});

	it.each([
		[
			"a newer attempt owns",
			{
				status: "GENERATING",
				generationStartedAt: new Date("2026-10-21T11:55:00.000Z"),
			},
		],
		[
			"a person's save completed",
			{ status: "COMPLETE", generationStartedAt: new Date(ATTEMPT) },
		],
		[
			"the stale-generation sweep failed",
			{ status: "FAILED", generationStartedAt: new Date(ATTEMPT) },
		],
	])("refuses a document %s, and writes nothing", async (_label, state) => {
		seed({ id: "doc-1", content: "# Their edit", version: 4, ...state });
		const before = unchanged();

		const error = await save().catch((caught: unknown) => caught);

		expectStale(error);
		expect(row()).toEqual(before);
		expect(store.versions).toEqual([]);
	});

	it("rolls the snapshot back when a newer attempt lands between the read and the write", async () => {
		seed({
			id: "doc-1",
			status: "GENERATING",
			generationStartedAt: new Date(ATTEMPT),
			content: "# Before",
		});
		store.afterRead = () => {
			Object.assign(row(), {
				generationStartedAt: new Date("2026-10-21T11:59:00.000Z"),
			});
		};

		const error = await save().catch((caught: unknown) => caught);

		expectStale(error);
		expect(row()).toMatchObject({
			status: "GENERATING",
			content: "# Before",
			generationStartedAt: new Date("2026-10-21T11:59:00.000Z"),
		});
		expect(store.versions).toEqual([]);
	});

	it("writes nothing again when its own earlier attempt already saved", async () => {
		// The save committed, its result was lost, and the activity retries.
		seed({
			id: "doc-1",
			status: "COMPLETE",
			generationStartedAt: new Date(ATTEMPT),
			content: "# Regenerated",
			version: 3,
		});
		const before = unchanged();

		await expect(save()).resolves.toBeUndefined();
		expect(row()).toEqual(before);
		expect(store.versions).toEqual([]);
	});
});

describe("createDocumentVersion — a legacy attempt's version", () => {
	const version = (content = "# Regenerated", baselineVersion?: number) =>
		createDocumentVersion("doc-1", content, "user-1", "prompt-v1", {
			generationStartedAt: ATTEMPT,
			...(baselineVersion !== undefined && { baselineVersion }),
		});
	const seedVersions = () => {
		store.versions.push({
			id: "version-old",
			documentId: "doc-1",
			version: 3,
			content: "# Before",
			changeDescription: "Pre-regeneration snapshot (auto)",
			changedBy: "user-1",
			promptVersionId: null,
			createdAt: new Date("2026-10-20T09:00:00.000Z"),
		});
	};

	it("versions the body its attempt saved", async () => {
		seed({
			id: "doc-1",
			status: "COMPLETE",
			generationStartedAt: new Date(ATTEMPT),
			content: "# Regenerated",
			version: 3,
		});
		seedVersions();

		await expect(version()).resolves.toBeUndefined();

		expect(row().version).toBe(4);
		expect(store.versions).toHaveLength(2);
		expect(store.versions[1]).toMatchObject({
			version: 4,
			content: "# Regenerated",
			changeDescription: "Regenerated version",
		});
	});

	it("versions the body its attempt saved when the save normalized it", async () => {
		// The child passes the version step the raw body it passed the save,
		// and the save stores it repaired: the step compares the repaired body,
		// so the run's own save is not read as someone else's edit.
		const raw = "# Regenerated ~“~“quoted~”~” text";
		const saved = normalizeQuoteArtifacts(raw);
		expect(saved).not.toBe(raw);
		seed({
			id: "doc-1",
			status: "COMPLETE",
			generationStartedAt: new Date(ATTEMPT),
			content: saved,
			version: 3,
		});
		seedVersions();

		await expect(version(raw)).resolves.toBeUndefined();

		expect(row().version).toBe(4);
		expect(store.versions[1]).toMatchObject({ version: 4, content: saved });
	});

	it.each([
		[
			"its body changed after the save",
			{ content: "# Their edit", generationStartedAt: new Date(ATTEMPT) },
		],
		[
			"a newer attempt owns it",
			{
				content: "# Regenerated",
				generationStartedAt: new Date("2026-10-21T11:55:00.000Z"),
			},
		],
	])("skips the version when %s", async (_label, state) => {
		seed({ id: "doc-1", status: "COMPLETE", version: 3, ...state });
		seedVersions();

		await expect(version()).resolves.toBeUndefined();

		expect(row().version).toBe(3);
		expect(store.versions).toHaveLength(1);
	});

	it.each([
		["its body as saved", "# Regenerated"],
		["a body it has saved since", "# Newer run"],
	])(
		"skips the version, not fails the run, when a newer attempt owns the document under a baseline, with %s",
		async (_label, content) => {
			seed({
				id: "doc-1",
				status: "GENERATING",
				version: 3,
				content,
				generationStartedAt: new Date("2026-10-21T11:55:00.000Z"),
			});

			await expect(version("# Regenerated", 3)).resolves.toBeUndefined();

			expect(row().version).toBe(3);
			expect(store.versions).toEqual([]);
		},
	);

	it("still refuses a moved baseline as stale while the attempt is its own", async () => {
		// A person's save moved the version after this attempt's save.
		seed({
			id: "doc-1",
			status: "COMPLETE",
			version: 4,
			content: "# Their edit",
			generationStartedAt: new Date(ATTEMPT),
		});

		const error = await version("# Regenerated", 3).catch(
			(caught: unknown) => caught,
		);

		expectStale(error);
		expect(row().version).toBe(4);
		expect(store.versions).toEqual([]);
	});

	it("skips the version under a baseline when a newer attempt lands between the read and the bump", async () => {
		seed({
			id: "doc-1",
			status: "COMPLETE",
			generationStartedAt: new Date(ATTEMPT),
			content: "# Regenerated",
			version: 3,
		});
		store.afterRead = () => {
			Object.assign(row(), {
				generationStartedAt: new Date("2026-10-21T11:59:00.000Z"),
			});
		};

		await expect(version("# Regenerated", 3)).resolves.toBeUndefined();

		expect(row().version).toBe(3);
		expect(store.versions).toEqual([]);
	});

	it("rolls the row back when a newer attempt lands between the read and the bump", async () => {
		seed({
			id: "doc-1",
			status: "COMPLETE",
			generationStartedAt: new Date(ATTEMPT),
			content: "# Regenerated",
			version: 3,
		});
		store.afterRead = () => {
			Object.assign(row(), {
				generationStartedAt: new Date("2026-10-21T11:59:00.000Z"),
			});
		};

		await expect(version()).resolves.toBeUndefined();

		expect(row()).toMatchObject({
			version: 3,
			generationStartedAt: new Date("2026-10-21T11:59:00.000Z"),
		});
		expect(store.versions).toEqual([]);
	});

	it("finds its own earlier attempt's row on a retry, and not an older one with the same body", async () => {
		seed({
			id: "doc-1",
			status: "COMPLETE",
			generationStartedAt: new Date(ATTEMPT),
			content: "# Regenerated",
			version: 3,
		});
		// The same body, author and prompt, from a run before this attempt.
		store.versions.push({
			id: "version-earlier-run",
			documentId: "doc-1",
			version: 2,
			content: "# Regenerated",
			changeDescription: "Regenerated version",
			changedBy: "user-1",
			promptVersionId: "prompt-v1",
			createdAt: new Date("2026-10-20T09:00:00.000Z"),
		});
		seedVersions();

		await version();
		expect(row().version).toBe(4);
		expect(store.versions).toHaveLength(3);

		// The bump committed, its result was lost, and the activity retries.
		await expect(version()).resolves.toBeUndefined();
		expect(row().version).toBe(4);
		expect(store.versions).toHaveLength(3);
	});
});
