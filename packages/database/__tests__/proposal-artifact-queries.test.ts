/**
 * Proposal artifact (Fizzy #2801) — query tests that need no database.
 *
 * The fake client below APPLIES each query's `where`, `orderBy`, `select`,
 * `include` and `omit` to in-memory rows instead of recording the arguments,
 * so a guard is proven by what it lets through and what it refuses, not by
 * the shape someone typed into it. RLS and the real row locks are proven
 * against Postgres in `proposal-artifact.integration.test.ts`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const fake = vi.hoisted(() => {
	const delegate = () => ({
		findFirst: vi.fn(),
		findUnique: vi.fn(),
		findUniqueOrThrow: vi.fn(),
		findMany: vi.fn(),
		count: vi.fn(),
		createMany: vi.fn(),
		update: vi.fn(),
		updateMany: vi.fn(),
		upsert: vi.fn(),
		deleteMany: vi.fn(),
	});
	return {
		projectDocument: delegate(),
		projectDocumentAnalysis: delegate(),
		projectDocumentFinding: delegate(),
		projectDocumentStyle: delegate(),
		$transaction: vi.fn(),
	};
});

vi.mock("../prisma/client", () => ({ db: fake, Prisma: {} }));

import {
	computeDocumentContentHash,
	getDocumentById,
	listDocuments,
} from "../prisma/queries/projects/documents";
import {
	type CreateAnalysisRunInput,
	type CreateAnalysisRunResult,
	claimLiveAttempt,
	clearLiveContent,
	completeAnalysisRun,
	createAnalysisRun,
	DocumentStyleValidationError,
	failAnalysisRun,
	getAnalysisRunInput,
	getDocumentStyle,
	getLatestAnalysisForDocument,
	markAnalysisRunning,
	normalizeDocumentStyleFields,
	PROPOSAL_ANALYSIS_ERROR_MESSAGE_MAX_LENGTH,
	PROPOSAL_ANALYSIS_SOURCE_CONTEXT_MAX_LENGTH,
	PROPOSAL_ANALYSIS_STATUSES,
	PROPOSAL_FINDING_SEVERITIES,
	PROPOSAL_FINDING_TYPES,
	ProposalArtifactTenantError,
	resetLiveSections,
	upsertDocumentStyle,
	writeLiveSections,
} from "../prisma/queries/projects/proposal-artifact";
import {
	createOrganizationContext,
	createPersonalContext,
	grantProjectAccess,
	runWithTenantContext,
} from "../src/tenant-context";
import { mergeWithTenantFilter } from "../src/tenant-db";

// ---------------------------------------------------------------------------
// A tiny evaluator for the Prisma operators these queries use
// ---------------------------------------------------------------------------

function matches(row: Row, where: Row | undefined): boolean {
	if (!where) {
		return true;
	}
	return Object.entries(where).every(([key, condition]) => {
		if (key === "OR") {
			return (condition as Row[]).some((branch) => matches(row, branch));
		}
		if (key === "AND") {
			return (condition as Row[]).every((branch) => matches(row, branch));
		}
		if (condition instanceof Date) {
			// Postgres compares timestamps by value, not by object identity.
			return (
				row[key] instanceof Date &&
				(row[key] as Date).getTime() === condition.getTime()
			);
		}
		if (
			condition !== null &&
			typeof condition === "object" &&
			!(condition instanceof Date)
		) {
			const operator = condition as { in?: unknown[]; lte?: number };
			if (operator.in) {
				return operator.in.includes(row[key]);
			}
			if (operator.lte !== undefined) {
				return (
					typeof row[key] === "number" &&
					(row[key] as number) <= operator.lte
				);
			}
			throw new Error(`fake: unsupported operator on ${key}`);
		}
		return row[key] === condition;
	});
}

function sortRows(rows: Row[], orderBy: unknown): Row[] {
	const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [])
		.flatMap((entry) => Object.entries(entry as Row))
		.map(([field, direction]) => [field, direction === "desc" ? -1 : 1]);
	return [...rows].sort((a, b) => {
		for (const [field, sign] of keys) {
			const left = a[field as string] as number | string | Date;
			const right = b[field as string] as number | string | Date;
			if (left < right) {
				return -1 * (sign as number);
			}
			if (left > right) {
				return 1 * (sign as number);
			}
		}
		return 0;
	});
}

let idCounter = 0;
const nextId = (prefix: string) => `${prefix}-${++idCounter}`;

const store = {
	documents: [] as Row[],
	analyses: [] as Row[],
	findings: [] as Row[],
	styles: [] as Row[],
	projects: new Map<string, { organizationId: string | null }>(),
	versions: new Map<string, Row[]>(),
};

function findingsOf(analysisId: string): Row[] {
	return store.findings.filter((f) => f.analysisId === analysisId);
}

/** Project an analysis row through a Prisma `select`, including findings. */
function selectAnalysis(row: Row, select: Row): Row {
	const out: Row = {};
	for (const [key, value] of Object.entries(select)) {
		if (key === "findings") {
			const spec = value as { orderBy?: unknown; select: Row };
			out.findings = sortRows(
				findingsOf(row.id as string),
				spec.orderBy,
			).map((finding) => selectScalars(finding, spec.select));
		} else if (value === true) {
			out[key] = row[key];
		}
	}
	return out;
}

function selectScalars(row: Row, select: Row): Row {
	return Object.fromEntries(
		Object.keys(select)
			.filter((key) => select[key] === true)
			.map((key) => [key, row[key]]),
	);
}

/** A document row as Prisma would return it under `select`/`include`/`omit`. */
function shapeDocument(
	row: Row,
	args: { select?: Row; include?: Row; omit?: Row },
): Row {
	const project = store.projects.get(row.projectId as string);
	if (args.select) {
		const out = selectScalars(row, args.select);
		if (args.select.project) {
			out.project = selectScalars(
				{ ...project, id: row.projectId },
				(args.select.project as { select: Row }).select,
			);
		}
		return out;
	}
	const out: Row = Object.fromEntries(
		Object.entries(row).filter(([key]) => !args.omit?.[key]),
	);
	for (const key of Object.keys(args.include ?? {})) {
		if (key === "project") {
			out.project = { id: row.projectId, ...project };
		} else if (key === "versions") {
			out.versions = store.versions.get(row.id as string) ?? [];
		} else if (key === "_count") {
			out._count = {
				versions: (store.versions.get(row.id as string) ?? []).length,
			};
		} else if (key === "analyses") {
			out.analyses = store.analyses.filter(
				(a) => a.documentId === row.id,
			);
		} else if (key === "style") {
			out.style =
				store.styles.find((s) => s.documentId === row.id) ?? null;
		}
	}
	return out;
}

function updateRows(rows: Row[], where: Row, data: Row): { count: number } {
	const hits = rows.filter((row) => matches(row, where));
	for (const row of hits) {
		Object.assign(row, data);
	}
	return { count: hits.length };
}

function installFake(): void {
	fake.$transaction.mockImplementation(
		async (fn: (tx: typeof fake) => unknown) => fn(fake),
	);

	const doc = fake.projectDocument;
	doc.updateMany.mockImplementation(({ where, data }) =>
		updateRows(store.documents, where, data),
	);
	doc.update.mockImplementation(({ where, data }) => {
		const row = store.documents.find((r) => r.id === where.id);
		if (!row) {
			throw new Error("fake: record to update not found");
		}
		Object.assign(row, data);
		return row;
	});
	doc.findUnique.mockImplementation((args) => {
		const row = store.documents.find((r) => r.id === args.where.id);
		return row ? shapeDocument(row, args) : null;
	});
	doc.findFirst.mockImplementation((args) => {
		const row = store.documents.find((r) => matches(r, args.where));
		return row ? shapeDocument(row, args) : null;
	});
	doc.findMany.mockImplementation((args) =>
		store.documents
			.filter((r) => matches(r, args.where))
			.map((r) => shapeDocument(r, args)),
	);
	doc.count.mockImplementation(
		(args) => store.documents.filter((r) => matches(r, args.where)).length,
	);

	const analysis = fake.projectDocumentAnalysis;
	analysis.createMany.mockImplementation(({ data, skipDuplicates }) => {
		let count = 0;
		for (const input of data as Row[]) {
			if (store.analyses.some((a) => a.runKey === input.runKey)) {
				if (skipDuplicates) {
					continue;
				}
				throw new Error("fake: unique constraint failed on runKey");
			}
			store.analyses.push({
				id: nextId("analysis"),
				contextCount: 0,
				startedAt: null,
				createdAt: new Date(Date.UTC(2026, 9, 7, 9, 0, idCounter)),
				updatedAt: new Date(Date.UTC(2026, 9, 7, 9, 0, idCounter)),
				...input,
			});
			count += 1;
		}
		return { count };
	});
	const findRun = (where: Row) =>
		store.analyses.find((a) =>
			where.runKey ? a.runKey === where.runKey : a.id === where.id,
		);
	analysis.findUnique.mockImplementation(({ where, select }) => {
		const row = findRun(where);
		return row ? selectAnalysis(row, select) : null;
	});
	analysis.findUniqueOrThrow.mockImplementation(({ where, select }) => {
		const row = findRun(where);
		if (!row) {
			throw new Error("fake: no run");
		}
		return selectAnalysis(row, select);
	});
	analysis.updateMany.mockImplementation(({ where, data }) =>
		updateRows(store.analyses, where, data),
	);
	analysis.findFirst.mockImplementation(({ where, orderBy, select }) => {
		const [row] = sortRows(
			store.analyses.filter((a) => matches(a, where)),
			orderBy,
		);
		return row ? selectAnalysis(row, select) : null;
	});

	const finding = fake.projectDocumentFinding;
	finding.deleteMany.mockImplementation(({ where }) => {
		const before = store.findings.length;
		store.findings = store.findings.filter((f) => !matches(f, where));
		return { count: before - store.findings.length };
	});
	finding.createMany.mockImplementation(({ data }) => {
		for (const input of data as Row[]) {
			store.findings.push({ id: nextId("finding"), ...input });
		}
		return { count: (data as Row[]).length };
	});

	const style = fake.projectDocumentStyle;
	style.findFirst.mockImplementation(({ where, select }) => {
		const row = store.styles.find((s) => matches(s, where));
		return row ? selectScalars(row, select) : null;
	});
	style.upsert.mockImplementation(({ where, create, update, select }) => {
		const existing = store.styles.find(
			(s) => s.documentId === where.documentId,
		);
		if (existing) {
			Object.assign(existing, update, { updatedAt: new Date() });
			return selectScalars(existing, select);
		}
		const created: Row = {
			id: nextId("style"),
			updatedAt: new Date(),
			...create,
		};
		store.styles.push(created);
		return selectScalars(created, select);
	});
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORG = "org-example";
const OTHER_ORG = "org-other";
const PROJECT = "project-example";
const PERSONAL_PROJECT = "project-personal";
const DOC = "doc-example";
const RUN = "run-current";
const EARLIER = new Date("2026-10-07T08:00:00.000Z");
const NOW = new Date("2026-10-07T09:30:00.000Z");
const MAIN = "# Example proposal\n\n## Scope\n\nWhat the engagement covers.";

function seedDocument(overrides: Row = {}): Row {
	const row: Row = {
		id: DOC,
		projectId: PROJECT,
		type: "PROPOSAL",
		title: "Example proposal",
		content: MAIN,
		version: 3,
		status: "GENERATING",
		liveContent: null,
		liveRunId: RUN,
		liveAttempt: null,
		organizationId: ORG,
		updatedAt: EARLIER,
		...overrides,
	};
	store.documents.push(row);
	return row;
}

function documentRow(id = DOC): Row {
	const row = store.documents.find((r) => r.id === id);
	if (!row) {
		throw new Error(`no document ${id}`);
	}
	return row;
}

function analysisRow(id: string): Row {
	const row = store.analyses.find((a) => a.id === id);
	if (!row) {
		throw new Error(`no analysis ${id}`);
	}
	return row;
}

/** Record a run for a document whose live run is still {@link RUN}. */
async function recordRun(
	input: Omit<CreateAnalysisRunInput, "liveRunId">,
): Promise<CreateAnalysisRunResult> {
	const run = await createAnalysisRun({ liveRunId: RUN, ...input });
	if (run === "superseded") {
		throw new Error("expected the run to be recorded, not superseded");
	}
	return run;
}

beforeEach(() => {
	vi.clearAllMocks();
	idCounter = 0;
	store.documents = [];
	store.analyses = [];
	store.findings = [];
	store.styles = [];
	store.projects = new Map([
		[PROJECT, { organizationId: ORG }],
		[PERSONAL_PROJECT, { organizationId: null }],
	]);
	store.versions = new Map();
	installFake();
});

// ---------------------------------------------------------------------------
// Value sets
// ---------------------------------------------------------------------------

describe("value sets agree with the schema enums", () => {
	const schema = readFileSync(
		join(__dirname, "../prisma/schema.prisma"),
		"utf8",
	);
	function enumValues(name: string): string[] {
		const block = schema.match(
			new RegExp(`\\nenum ${name} \\{([^}]*)\\}`),
		)?.[1];
		expect(block).toBeDefined();
		return (block ?? "")
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => /^[A-Z_]+$/.test(line));
	}

	it.each([
		["ProjectDocumentAnalysisStatus", PROPOSAL_ANALYSIS_STATUSES],
		["ProjectDocumentFindingSeverity", PROPOSAL_FINDING_SEVERITIES],
		["ProjectDocumentFindingType", PROPOSAL_FINDING_TYPES],
	])("%s", (name, values) => {
		expect(enumValues(name)).toEqual([...values]);
	});
});

// ---------------------------------------------------------------------------
// Live sections
// ---------------------------------------------------------------------------

describe("live sections", () => {
	it("a write from the current run and attempt saves the sections and moves updatedAt", async () => {
		seedDocument({ liveAttempt: 1 });

		const outcome = await writeLiveSections({
			documentId: DOC,
			runId: RUN,
			attempt: 1,
			content: "## Scope\n\nDone.",
			now: NOW,
		});

		expect(outcome).toBe("written");
		expect(documentRow().liveContent).toBe("## Scope\n\nDone.");
		expect(documentRow().updatedAt).toEqual(NOW);
		// The final save owns the body.
		expect(documentRow().content).toBe(MAIN);
	});

	it("a write before any attempt has claimed the run is accepted", async () => {
		seedDocument({ liveAttempt: null });
		expect(
			await writeLiveSections({
				documentId: DOC,
				runId: RUN,
				attempt: 1,
				content: "## Scope",
				now: NOW,
			}),
		).toBe("written");
	});

	it("a write from another run is superseded and changes nothing", async () => {
		seedDocument({ liveRunId: "run-newer", liveContent: "## Newer" });
		const before = structuredClone(documentRow());

		const outcome = await writeLiveSections({
			documentId: DOC,
			runId: RUN,
			attempt: 1,
			content: "## Stale",
			now: NOW,
		});

		expect(outcome).toBe("superseded");
		expect(documentRow()).toEqual(before);
	});

	it("after attempt 2 claims the run, a write from attempt 1 is superseded", async () => {
		seedDocument({ liveAttempt: 1, liveContent: "## From attempt 1" });

		expect(
			await claimLiveAttempt({ documentId: DOC, runId: RUN, attempt: 2 }),
		).toBe("written");
		expect(documentRow().liveAttempt).toBe(2);

		const before = structuredClone(documentRow());
		expect(
			await writeLiveSections({
				documentId: DOC,
				runId: RUN,
				attempt: 1,
				content: "## Late write from attempt 1",
				now: NOW,
			}),
		).toBe("superseded");
		expect(documentRow()).toEqual(before);

		expect(
			await writeLiveSections({
				documentId: DOC,
				runId: RUN,
				attempt: 2,
				content: "## From attempt 2",
				now: NOW,
			}),
		).toBe("written");
		expect(documentRow().liveContent).toBe("## From attempt 2");
	});

	it("an earlier attempt cannot take the run back from a later one", async () => {
		seedDocument({ liveAttempt: 2 });
		expect(
			await claimLiveAttempt({ documentId: DOC, runId: RUN, attempt: 1 }),
		).toBe("superseded");
		expect(documentRow().liveAttempt).toBe(2);
	});

	it("a claim for another run is superseded", async () => {
		seedDocument({ liveRunId: "run-newer" });
		expect(
			await claimLiveAttempt({ documentId: DOC, runId: RUN, attempt: 1 }),
		).toBe("superseded");
		expect(documentRow().liveAttempt).toBeNull();
	});

	it.each(["QUEUED", "COMPLETE", "FAILED"])(
		"a write when the document is %s (no longer GENERATING) is superseded",
		async (status) => {
			seedDocument({ status, liveAttempt: 1 });
			const before = structuredClone(documentRow());
			expect(
				await writeLiveSections({
					documentId: DOC,
					runId: RUN,
					attempt: 1,
					content: "## Scope",
					now: NOW,
				}),
			).toBe("superseded");
			expect(documentRow()).toEqual(before);
		},
	);

	it("strips null bytes from streamed sections before writing them", async () => {
		seedDocument();
		await writeLiveSections({
			documentId: DOC,
			runId: RUN,
			attempt: 1,
			content: "## Scope\u0000\n\nBody",
			now: NOW,
		});
		expect(documentRow().liveContent).toBe("## Scope\n\nBody");
	});

	it("resetLiveSections points the document at the new run and drops the old preview and claim", async () => {
		seedDocument({
			status: "COMPLETE",
			liveRunId: "run-previous",
			liveAttempt: 3,
			liveContent: "## Left behind",
		});

		await resetLiveSections({ documentId: DOC, runId: RUN });

		expect(documentRow()).toMatchObject({
			liveRunId: RUN,
			liveContent: null,
			liveAttempt: null,
			content: MAIN,
		});
	});

	it("resetLiveSections throws for a document that no longer exists", async () => {
		await expect(
			resetLiveSections({ documentId: "doc-missing", runId: RUN }),
		).rejects.toThrow();
	});

	it("resetLiveSections with the attempt identity takes the document over while it still carries that identity", async () => {
		seedDocument({
			generationStartedAt: new Date(EARLIER),
			liveRunId: "run-previous",
			liveAttempt: 2,
			liveContent: "## Left behind",
		});

		expect(
			await resetLiveSections({
				documentId: DOC,
				runId: RUN,
				generationStartedAt: new Date(EARLIER),
			}),
		).toBe("written");
		expect(documentRow()).toMatchObject({
			liveRunId: RUN,
			liveContent: null,
			liveAttempt: null,
		});
	});

	it("resetLiveSections from an attempt a newer request replaced is superseded and changes nothing", async () => {
		// A newer dispatch stamped its own identity and its plan took over.
		seedDocument({
			generationStartedAt: NOW,
			liveRunId: "run-newer",
			liveAttempt: 1,
			liveContent: "## Newer",
		});
		const before = structuredClone(documentRow());

		expect(
			await resetLiveSections({
				documentId: DOC,
				runId: RUN,
				generationStartedAt: EARLIER,
			}),
		).toBe("superseded");
		expect(documentRow()).toEqual(before);
	});

	it("resetLiveSections with the attempt identity is superseded for a document that no longer exists", async () => {
		expect(
			await resetLiveSections({
				documentId: "doc-missing",
				runId: RUN,
				generationStartedAt: EARLIER,
			}),
		).toBe("superseded");
	});

	it("clearLiveContent drops the run's own preview in any status", async () => {
		seedDocument({ status: "FAILED", liveContent: "## Partial" });
		expect(
			await clearLiveContent({ documentId: DOC, runId: RUN, now: NOW }),
		).toBe("written");
		expect(documentRow().liveContent).toBeNull();
		expect(documentRow().liveRunId).toBe(RUN);
	});

	it("clearLiveContent with a stale run id is a no-op", async () => {
		seedDocument({ liveRunId: "run-newer", liveContent: "## Newer" });
		const before = structuredClone(documentRow());
		expect(
			await clearLiveContent({ documentId: DOC, runId: RUN, now: NOW }),
		).toBe("superseded");
		expect(documentRow()).toEqual(before);
	});

	it("clearLiveContent from the attempt that owns the run drops its preview", async () => {
		seedDocument({ liveAttempt: 2, liveContent: "## Partial" });
		expect(
			await clearLiveContent({
				documentId: DOC,
				runId: RUN,
				attempt: 2,
				now: NOW,
			}),
		).toBe("written");
		expect(documentRow().liveContent).toBeNull();
	});

	it("clearLiveContent from an attempt a later one replaced leaves the retry's preview", async () => {
		// Attempt 1 timed out, attempt 2 claimed the run and is writing; the
		// first attempt's fallback clear arrives late.
		seedDocument({ liveAttempt: 2, liveContent: "## The retry's section" });
		const before = structuredClone(documentRow());
		expect(
			await clearLiveContent({
				documentId: DOC,
				runId: RUN,
				attempt: 1,
				now: NOW,
			}),
		).toBe("superseded");
		expect(documentRow()).toEqual(before);
	});
});

// ---------------------------------------------------------------------------
// Document reads
// ---------------------------------------------------------------------------

describe("document reads keep the new data where it belongs", () => {
	it("listDocuments rows do not carry liveContent", async () => {
		seedDocument({ liveContent: "## Streaming" });

		const { documents } = await listDocuments({ projectId: PROJECT });

		expect(documents).toHaveLength(1);
		expect(documents[0]).not.toHaveProperty("liveContent");
		expect(documents[0]).toMatchObject({ id: DOC, content: MAIN });
	});

	it("getDocumentById carries the live preview but no analysis or style relation", async () => {
		seedDocument({ liveContent: "## Streaming" });
		store.analyses.push({ id: "analysis-x", documentId: DOC });
		store.styles.push({ id: "style-x", documentId: DOC });

		const document = await getDocumentById(DOC);

		expect(document).not.toBeNull();
		expect(document).not.toHaveProperty("analyses");
		expect(document).not.toHaveProperty("style");
		expect(document?.liveContent).toBe("## Streaming");
		// The run token and attempt guard the worker's writes; no reader
		// needs them, so the document read does not hand them out.
		expect(document).not.toHaveProperty("liveRunId");
		expect(document).not.toHaveProperty("liveAttempt");
		expect(document?.currentContentHash).toBe(
			computeDocumentContentHash(MAIN),
		);
	});
});

// ---------------------------------------------------------------------------
// Analysis runs
// ---------------------------------------------------------------------------

describe("createAnalysisRun", () => {
	it("stores the saved body read back from the document, its hash and version, as PENDING", async () => {
		seedDocument({ status: "COMPLETE" });

		const result = await recordRun({
			documentId: DOC,
			runKey: "proposal-analysis-example",
			sourceContext: "Context block",
			contextCount: 2,
			promptVersionId: "prompt-version-1",
		});

		expect(result).toMatchObject({ status: "PENDING", created: true });
		expect(analysisRow(result.analysisId)).toMatchObject({
			organizationId: ORG,
			projectId: PROJECT,
			documentId: DOC,
			analyzedContent: MAIN,
			contentHash: computeDocumentContentHash(MAIN),
			documentVersion: 3,
			sourceContext: "Context block",
			contextCount: 2,
			promptVersionId: "prompt-version-1",
			errorCode: null,
			completedAt: null,
		});
	});

	it("is idempotent per run key: a retried creation returns the first row unchanged", async () => {
		seedDocument({ status: "COMPLETE" });
		const first = await recordRun({
			documentId: DOC,
			runKey: "proposal-analysis-example",
			sourceContext: "First",
			contextCount: 1,
		});
		await markAnalysisRunning(first.analysisId, NOW);

		const retried = await recordRun({
			documentId: DOC,
			runKey: "proposal-analysis-example",
			sourceContext: "Second",
			contextCount: 9,
		});

		expect(retried).toEqual({
			analysisId: first.analysisId,
			status: "RUNNING",
			created: false,
		});
		expect(store.analyses).toHaveLength(1);
		expect(analysisRow(first.analysisId).sourceContext).toBe("First");
	});

	it("can record a run that must not start as FAILED with a capped message", async () => {
		seedDocument({ status: "COMPLETE" });

		const result = await recordRun({
			documentId: DOC,
			runKey: "proposal-analysis-guest",
			sourceContext: "",
			contextCount: 0,
			failure: {
				errorCode: "GUEST_TRIGGERED",
				errorMessage: "x".repeat(2000),
			},
			now: NOW,
		});

		expect(result.status).toBe("FAILED");
		const row = analysisRow(result.analysisId);
		expect(row.errorCode).toBe("GUEST_TRIGGERED");
		expect(row.errorMessage).toHaveLength(
			PROPOSAL_ANALYSIS_ERROR_MESSAGE_MAX_LENGTH,
		);
		expect(row.completedAt).toEqual(NOW);
	});

	it("bounds the stored source context", async () => {
		seedDocument({ status: "COMPLETE" });
		const result = await recordRun({
			documentId: DOC,
			runKey: "proposal-analysis-large",
			sourceContext: "c".repeat(
				PROPOSAL_ANALYSIS_SOURCE_CONTEXT_MAX_LENGTH + 50,
			),
			contextCount: 40,
		});
		expect(analysisRow(result.analysisId).sourceContext).toHaveLength(
			PROPOSAL_ANALYSIS_SOURCE_CONTEXT_MAX_LENGTH,
		);
	});

	it("refuses a document outside an organization project, writing nothing", async () => {
		seedDocument({ projectId: PERSONAL_PROJECT, organizationId: null });
		await expect(
			recordRun({
				documentId: DOC,
				runKey: "proposal-analysis-personal",
				sourceContext: "",
				contextCount: 0,
			}),
		).rejects.toBeInstanceOf(ProposalArtifactTenantError);
		expect(store.analyses).toHaveLength(0);
	});

	it("refuses when the caller's organization is not the document's", async () => {
		seedDocument();
		await expect(
			recordRun({
				documentId: DOC,
				runKey: "proposal-analysis-other",
				sourceContext: "",
				contextCount: 0,
				organizationId: OTHER_ORG,
			}),
		).rejects.toBeInstanceOf(ProposalArtifactTenantError);
		expect(store.analyses).toHaveLength(0);
	});

	it("refuses a run key that already belongs to another document", async () => {
		seedDocument();
		seedDocument({ id: "doc-second" });
		await recordRun({
			documentId: DOC,
			runKey: "proposal-analysis-shared",
			sourceContext: "",
			contextCount: 0,
		});
		await expect(
			recordRun({
				documentId: "doc-second",
				runKey: "proposal-analysis-shared",
				sourceContext: "",
				contextCount: 0,
			}),
		).rejects.toBeInstanceOf(ProposalArtifactTenantError);
	});

	it.each([
		["a PENDING run", undefined],
		[
			"a run that must not start",
			{ errorCode: "GUEST_TRIGGERED", errorMessage: "Not for guests." },
		],
	])(
		"records nothing for %s once a newer run owns the document",
		async (_case, failure) => {
			// A newer generation planned and saved its own Main.
			seedDocument({
				status: "COMPLETE",
				liveRunId: "run-newer",
				content: "# The newer run's proposal",
			});

			const result = await createAnalysisRun({
				documentId: DOC,
				runKey: "proposal-analysis-superseded",
				liveRunId: RUN,
				sourceContext: "Context of the older run",
				contextCount: 1,
				...(failure && { failure }),
			});

			expect(result).toBe("superseded");
			expect(store.analyses).toHaveLength(0);
		},
	);

	it("a retry whose first attempt recorded the run returns it, even after a newer run took the document", async () => {
		seedDocument({ status: "COMPLETE" });
		const first = await recordRun({
			documentId: DOC,
			runKey: "proposal-analysis-example",
			sourceContext: "First",
			contextCount: 1,
		});
		// The first attempt's answer was lost; meanwhile a newer run planned.
		documentRow().liveRunId = "run-newer";

		const retried = await createAnalysisRun({
			documentId: DOC,
			runKey: "proposal-analysis-example",
			liveRunId: RUN,
			sourceContext: "Second",
			contextCount: 9,
		});

		expect(retried).toEqual({
			analysisId: first.analysisId,
			status: "PENDING",
			created: false,
		});
		expect(store.analyses).toHaveLength(1);
		expect(analysisRow(first.analysisId).analyzedContent).toBe(MAIN);
	});
});

describe("analysis run lifecycle", () => {
	async function pendingRun(runKey = "proposal-analysis-example") {
		if (!store.documents.some((d) => d.id === DOC)) {
			seedDocument({ status: "COMPLETE" });
		}
		return (
			await recordRun({
				documentId: DOC,
				runKey,
				sourceContext: "Context",
				contextCount: 1,
			})
		).analysisId;
	}

	const findings = [
		{
			severity: "BLOCKING" as const,
			type: "COMMERCIAL" as const,
			title: "Pricing is not stated",
			detail: "The commercial section names no figure.",
			recommendation: "State the fixed fee.",
			sectionHeading: "Commercials",
		},
		{
			severity: "INFORMATIONAL" as const,
			type: "OPPORTUNITY" as const,
			title: "Follow-on phase",
			detail: "A second phase is implied.",
		},
	];

	it("PENDING becomes RUNNING with a start time; a retried start keeps the first one", async () => {
		const id = await pendingRun();
		expect(await markAnalysisRunning(id, EARLIER)).toBe("written");
		expect(analysisRow(id)).toMatchObject({
			status: "RUNNING",
			startedAt: EARLIER,
		});

		expect(await markAnalysisRunning(id, NOW)).toBe("written");
		expect(analysisRow(id).startedAt).toEqual(EARLIER);
	});

	it.each(["COMPLETE", "FAILED"])(
		"a %s run cannot be started again",
		async (status) => {
			const id = await pendingRun();
			analysisRow(id).status = status;
			expect(await markAnalysisRunning(id, NOW)).toBe("superseded");
			expect(analysisRow(id).status).toBe(status);
		},
	);

	it("completes with findings positioned in order and tenant columns copied from the run", async () => {
		const id = await pendingRun();
		await markAnalysisRunning(id, EARLIER);

		expect(
			await completeAnalysisRun({
				analysisId: id,
				findings,
				model: "example-model",
				now: NOW,
			}),
		).toBe("written");

		expect(analysisRow(id)).toMatchObject({
			status: "COMPLETE",
			completedAt: NOW,
			model: "example-model",
		});
		expect(sortRows(findingsOf(id), { position: "asc" })).toMatchObject([
			{
				organizationId: ORG,
				position: 0,
				severity: "BLOCKING",
				recommendation: "State the fixed fee.",
			},
			{
				organizationId: ORG,
				position: 1,
				type: "OPPORTUNITY",
				recommendation: null,
				sectionHeading: null,
			},
		]);
	});

	it("a second completion of a COMPLETE run is refused and the first findings stay", async () => {
		const id = await pendingRun();
		await markAnalysisRunning(id, EARLIER);
		await completeAnalysisRun({ analysisId: id, findings, now: NOW });
		fake.projectDocumentFinding.createMany.mockClear();
		fake.projectDocumentFinding.deleteMany.mockClear();

		expect(
			await completeAnalysisRun({
				analysisId: id,
				findings: [
					{ ...findings[0], title: "A later attempt's finding" },
				],
				now: NOW,
			}),
		).toBe("superseded");
		expect(
			sortRows(findingsOf(id), { position: "asc" }).map((f) => f.title),
		).toEqual(findings.map((f) => f.title));
		expect(fake.projectDocumentFinding.createMany).not.toHaveBeenCalled();
		expect(fake.projectDocumentFinding.deleteMany).not.toHaveBeenCalled();
	});

	it("zero findings completes the run", async () => {
		const id = await pendingRun();
		await markAnalysisRunning(id, EARLIER);
		expect(
			await completeAnalysisRun({
				analysisId: id,
				findings: [],
				now: NOW,
			}),
		).toBe("written");
		expect(analysisRow(id).status).toBe("COMPLETE");
		expect(findingsOf(id)).toHaveLength(0);
	});

	it("does not touch another run's findings", async () => {
		const first = await pendingRun("proposal-analysis-1");
		const second = await pendingRun("proposal-analysis-2");
		await completeAnalysisRun({ analysisId: first, findings, now: NOW });
		await completeAnalysisRun({
			analysisId: second,
			findings: [findings[0]],
			now: NOW,
		});
		expect(findingsOf(first)).toHaveLength(2);
		expect(findingsOf(second)).toHaveLength(1);
	});

	it("a FAILED run is not resurrected by a late completion, and its findings stay empty", async () => {
		const id = await pendingRun();
		await markAnalysisRunning(id, EARLIER);
		expect(
			await failAnalysisRun({
				analysisId: id,
				errorCode: "ANALYSIS_FAILED",
				errorMessage: "The analysis could not be completed.",
				now: NOW,
			}),
		).toBe("written");

		expect(
			await completeAnalysisRun({ analysisId: id, findings, now: NOW }),
		).toBe("superseded");
		expect(analysisRow(id)).toMatchObject({
			status: "FAILED",
			errorCode: "ANALYSIS_FAILED",
		});
		expect(findingsOf(id)).toHaveLength(0);
		expect(fake.projectDocumentFinding.createMany).not.toHaveBeenCalled();
		expect(fake.projectDocumentFinding.deleteMany).not.toHaveBeenCalled();
	});

	it("failing caps the message and never overwrites a COMPLETE run", async () => {
		const id = await pendingRun();
		expect(
			await failAnalysisRun({
				analysisId: id,
				errorCode: "START_FAILED",
				errorMessage: "m".repeat(900),
				now: NOW,
			}),
		).toBe("written");
		expect(analysisRow(id).errorMessage).toHaveLength(
			PROPOSAL_ANALYSIS_ERROR_MESSAGE_MAX_LENGTH,
		);

		const done = await pendingRun("proposal-analysis-done");
		await completeAnalysisRun({ analysisId: done, findings, now: NOW });
		expect(
			await failAnalysisRun({
				analysisId: done,
				errorCode: "ANALYSIS_FAILED",
				errorMessage: "Late failure.",
			}),
		).toBe("superseded");
		expect(analysisRow(done)).toMatchObject({
			status: "COMPLETE",
			errorCode: null,
		});
	});

	it("getAnalysisRunInput returns the stored body and context for the activity", async () => {
		const id = await pendingRun();
		expect(await getAnalysisRunInput(id)).toMatchObject({
			analysisId: id,
			documentId: DOC,
			organizationId: ORG,
			status: "PENDING",
			analyzedContent: MAIN,
			sourceContext: "Context",
			contextCount: 1,
		});
		expect(await getAnalysisRunInput("analysis-missing")).toBeNull();
	});
});

describe("getLatestAnalysisForDocument", () => {
	it("returns the newest run even when an older run completes later, with findings in order", async () => {
		seedDocument({ status: "COMPLETE" });
		const older = await recordRun({
			documentId: DOC,
			runKey: "proposal-analysis-older",
			sourceContext: "",
			contextCount: 0,
		});
		const newer = await recordRun({
			documentId: DOC,
			runKey: "proposal-analysis-newer",
			sourceContext: "",
			contextCount: 0,
		});
		analysisRow(older.analysisId).createdAt = EARLIER;
		analysisRow(newer.analysisId).createdAt = NOW;
		await markAnalysisRunning(newer.analysisId, NOW);

		// Insert findings out of order: positions decide the order, not rows.
		await completeAnalysisRun({
			analysisId: older.analysisId,
			findings: [
				{
					severity: "IMPORTANT",
					type: "RISK",
					title: "Older",
					detail: "Older run.",
				},
			],
			now: new Date("2026-10-07T10:00:00.000Z"),
		});
		analysisRow(older.analysisId).updatedAt = new Date(
			"2026-10-07T10:00:00.000Z",
		);
		analysisRow(newer.analysisId).updatedAt = NOW;

		const latest = await getLatestAnalysisForDocument({
			documentId: DOC,
			organizationId: ORG,
		});
		expect(latest?.id).toBe(newer.analysisId);
		expect(latest?.status).toBe("RUNNING");
		expect(latest?.findings).toEqual([]);

		await completeAnalysisRun({
			analysisId: newer.analysisId,
			findings: [
				{
					severity: "BLOCKING",
					type: "SCOPE",
					title: "A",
					detail: "a",
				},
				{ severity: "IMPORTANT", type: "GAP", title: "B", detail: "b" },
			],
		});
		store.findings.reverse();
		const completed = await getLatestAnalysisForDocument({
			documentId: DOC,
			organizationId: ORG,
		});
		expect(completed?.findings.map((f) => f.title)).toEqual(["A", "B"]);
	});

	it("never returns the stored body or source context", async () => {
		seedDocument({ status: "COMPLETE" });
		await recordRun({
			documentId: DOC,
			runKey: "proposal-analysis-example",
			sourceContext: "Confidential context",
			contextCount: 1,
		});
		const latest = await getLatestAnalysisForDocument({
			documentId: DOC,
			organizationId: ORG,
		});
		expect(latest).not.toBeNull();
		expect(latest).not.toHaveProperty("analyzedContent");
		expect(latest).not.toHaveProperty("sourceContext");
		expect(latest?.contentHash).toBe(computeDocumentContentHash(MAIN));
	});

	it("returns nothing for another organization, or when there is no run", async () => {
		seedDocument({ status: "COMPLETE" });
		expect(
			await getLatestAnalysisForDocument({
				documentId: DOC,
				organizationId: ORG,
			}),
		).toBeNull();
		await recordRun({
			documentId: DOC,
			runKey: "proposal-analysis-example",
			sourceContext: "",
			contextCount: 0,
		});
		expect(
			await getLatestAnalysisForDocument({
				documentId: DOC,
				organizationId: OTHER_ORG,
			}),
		).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Style
// ---------------------------------------------------------------------------

describe("document style", () => {
	it("normalizes direction and colours", () => {
		expect(
			normalizeDocumentStyleFields({
				styleDirection: "  Calm and editorial  ",
				primaryColor: "#1A2B3C",
				accentColors: ["#ABCDEF", "#000000"],
			}),
		).toEqual({
			styleDirection: "Calm and editorial",
			primaryColor: "#1a2b3c",
			accentColors: ["#abcdef", "#000000"],
		});
		expect(
			normalizeDocumentStyleFields({
				styleDirection: "   ",
				primaryColor: "",
			}),
		).toEqual({
			styleDirection: null,
			primaryColor: null,
			accentColors: [],
		});
	});

	it.each([
		[{ styleDirection: "d".repeat(501) }, "directionTooLong"],
		[{ primaryColor: "blue" }, "invalidColor"],
		[
			{ accentColors: ["#111111", "#222222", "#333333", "#444444"] },
			"tooManyAccentColors",
		],
		[{ accentColors: ["#12345"] }, "invalidColor"],
	])("refuses %j with %s", (input, code) => {
		expect(() => normalizeDocumentStyleFields(input)).toThrow(
			expect.objectContaining({ code }),
		);
	});

	it("accepts exactly three accents and a 500-character direction", () => {
		expect(() =>
			normalizeDocumentStyleFields({
				styleDirection: "d".repeat(500),
				accentColors: ["#111111", "#222222", "#333333"],
			}),
		).not.toThrow();
	});

	it("creates then replaces the style, with tenant columns from the document's project", async () => {
		seedDocument({ status: "COMPLETE" });

		const created = await upsertDocumentStyle({
			documentId: DOC,
			projectId: PROJECT,
			styleDirection: "Bold",
			primaryColor: "#112233",
			accentColors: ["#445566"],
			updatedById: "user-example",
		});
		expect(created).toMatchObject({
			documentId: DOC,
			projectId: PROJECT,
			organizationId: ORG,
			primaryColor: "#112233",
			accentColors: ["#445566"],
		});

		const replaced = await upsertDocumentStyle({
			documentId: DOC,
			projectId: PROJECT,
			organizationId: ORG,
			styleDirection: null,
			primaryColor: null,
			accentColors: [],
			updatedById: "user-other",
		});
		expect(replaced).toMatchObject({
			styleDirection: null,
			primaryColor: null,
			accentColors: [],
			updatedById: "user-other",
		});
		expect(store.styles).toHaveLength(1);

		expect(
			await getDocumentStyle({ documentId: DOC, organizationId: ORG }),
		).toMatchObject({ documentId: DOC, updatedById: "user-other" });
		expect(
			await getDocumentStyle({
				documentId: DOC,
				organizationId: OTHER_ORG,
			}),
		).toBeNull();
	});

	it("validates before reading anything", async () => {
		seedDocument();
		await expect(
			upsertDocumentStyle({
				documentId: DOC,
				projectId: PROJECT,
				styleDirection: null,
				primaryColor: "#zzzzzz",
				accentColors: [],
				updatedById: null,
			}),
		).rejects.toBeInstanceOf(DocumentStyleValidationError);
		expect(fake.projectDocument.findFirst).not.toHaveBeenCalled();
		expect(fake.projectDocumentStyle.upsert).not.toHaveBeenCalled();
	});

	it.each([
		["a document of another project", { projectId: "project-elsewhere" }],
		["another organization", { organizationId: OTHER_ORG }],
	])("refuses %s and writes nothing", async (_label, overrides) => {
		seedDocument();
		await expect(
			upsertDocumentStyle({
				documentId: DOC,
				projectId: PROJECT,
				styleDirection: null,
				primaryColor: null,
				accentColors: [],
				updatedById: null,
				...overrides,
			}),
		).rejects.toBeInstanceOf(ProposalArtifactTenantError);
		expect(fake.projectDocumentStyle.upsert).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Tenant path
// ---------------------------------------------------------------------------

describe("the tenant client never hands analysis or style rows to a project guest", () => {
	const TABLES = [
		"ProjectDocumentAnalysis",
		"ProjectDocumentFinding",
		"ProjectDocumentStyle",
	];

	it.each(TABLES)(
		"%s filters on the organization alone in an organization context",
		(model) => {
			expect(
				runWithTenantContext(
					createOrganizationContext(ORG, "u_1"),
					() => mergeWithTenantFilter(model, undefined),
				),
			).toEqual({ organizationId: ORG });
		},
	);

	it.each(TABLES)(
		"%s matches nothing for a guest with no organization, even on the invited project",
		(model) => {
			const filter = runWithTenantContext(
				createPersonalContext("guest-user"),
				() => {
					grantProjectAccess(PROJECT, ORG);
					return mergeWithTenantFilter(model, { documentId: DOC });
				},
			);
			expect(JSON.stringify(filter)).not.toContain(PROJECT);
			expect(JSON.stringify(filter)).not.toContain(`"${ORG}"`);
			expect(filter).toEqual({
				AND: [{ documentId: DOC }, { organizationId: "___BLOCKED___" }],
			});
		},
	);

	it.each(TABLES)(
		"%s stays in the guest's own organization when the guest's session is elsewhere",
		(model) => {
			const filter = runWithTenantContext(
				createOrganizationContext(OTHER_ORG, "guest-user"),
				() => {
					grantProjectAccess(PROJECT, ORG);
					return mergeWithTenantFilter(model, undefined);
				},
			);
			expect(filter).toEqual({ organizationId: OTHER_ORG });
		},
	);

	it("unlike a project-scoped Glossy table, which ORs the invited project in", () => {
		const filter = runWithTenantContext(
			createPersonalContext("guest-user"),
			() => {
				grantProjectAccess(PROJECT, ORG);
				return mergeWithTenantFilter("GlossyEdition", undefined);
			},
		);
		expect(JSON.stringify(filter)).toContain(PROJECT);
	});
});
