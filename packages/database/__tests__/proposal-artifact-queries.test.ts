/**
 * Proposal artifact (Fizzy #2801, #2946) — query tests that need no database.
 *
 * The fake client below APPLIES each query's `where`, `orderBy`, `select`,
 * `include` and `omit` to in-memory rows instead of recording the arguments,
 * so a guard is proven by what it lets through and what it refuses, not by
 * the shape someone typed into it. The two raw locking reads of the re-run
 * claim are answered from the same rows. RLS, the real row locks and true
 * concurrency are proven against Postgres in
 * `proposal-artifact.integration.test.ts`.
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
		create: vi.fn(),
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
		projectDocumentFindingResponse: delegate(),
		projectDocumentStyle: delegate(),
		$transaction: vi.fn(),
		$queryRaw: vi.fn(),
	};
});

vi.mock("../prisma/client", () => ({ db: fake, Prisma: {} }));

import {
	computeDocumentContentHash,
	getDocumentById,
	listDocuments,
} from "../prisma/queries/projects/documents";
import {
	type ClaimRerunInput,
	type CreateAnalysisRunInput,
	type CreateAnalysisRunResult,
	claimLiveAttempt,
	claimRerun,
	clearFindingResponse,
	clearLiveContent,
	completeAnalysisRun,
	createAnalysisRun,
	DocumentStyleValidationError,
	FindingResponseValidationError,
	failAnalysisRun,
	getAnalysisForCurrentContent,
	getAnalysisRunInput,
	getDocumentStyle,
	getLatestAnalysisForDocument,
	getRunSourceContext,
	isAnalysisRunTimedOut,
	listResponsesForDocument,
	markAnalysisRunning,
	normalizeDocumentStyleFields,
	normalizeSourceManifest,
	PROPOSAL_ANALYSIS_ERROR_MESSAGE_MAX_LENGTH,
	PROPOSAL_ANALYSIS_KINDS,
	PROPOSAL_ANALYSIS_MATCH_WINDOW,
	PROPOSAL_ANALYSIS_SOURCE_CONTEXT_MAX_LENGTH,
	PROPOSAL_ANALYSIS_STATUSES,
	PROPOSAL_ANALYSIS_TIMED_OUT_FAILURE,
	PROPOSAL_ANALYSIS_TIMEOUT_MS,
	PROPOSAL_EVIDENCE_TEXT_HEAD_LENGTH,
	PROPOSAL_FINDING_RESPONSE_KINDS,
	PROPOSAL_FINDING_RESPONSE_TEXT_MAX_LENGTH,
	PROPOSAL_FINDING_SEVERITIES,
	PROPOSAL_FINDING_TYPES,
	PROPOSAL_SOURCE_MANIFEST_LABEL_MAX_LENGTH,
	PROPOSAL_SOURCE_MANIFEST_MAX_ENTRIES,
	ProposalArtifactTenantError,
	parseStoredSourceManifest,
	readProposalEvidenceSources,
	resetLiveSections,
	type UpsertFindingResponseInput,
	type UpsertFindingResponseResult,
	upsertDocumentStyle,
	upsertFindingResponse,
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
		if (key === "NOT") {
			return !matches(row, condition as Row);
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
let lockLog: string[] = [];

const store = {
	documents: [] as Row[],
	analyses: [] as Row[],
	findings: [] as Row[],
	responses: [] as Row[],
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
		for (const [field, value] of Object.entries(data)) {
			const increment =
				value !== null &&
				typeof value === "object" &&
				!Array.isArray(value) &&
				!(value instanceof Date)
					? (value as { increment?: number }).increment
					: undefined;
			row[field] =
				increment === undefined
					? value
					: (row[field] as number) + increment;
		}
	}
	return { count: hits.length };
}

/** The SQL text of a tagged-template raw query, placeholders as `?`. */
function rawSql(strings: TemplateStringsArray): string {
	return strings.join("?").replace(/\s+/g, " ");
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
				kind: "GENERATION",
				proseHash: null,
				sourceManifest: null,
				sourceRunId: null,
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
	analysis.findMany.mockImplementation(({ where, orderBy, take, select }) =>
		sortRows(
			store.analyses.filter((a) => matches(a, where)),
			orderBy,
		)
			.slice(0, take ?? undefined)
			.map((row) => selectAnalysis(row, select)),
	);
	analysis.create.mockImplementation(({ data, select }) => {
		if (store.analyses.some((a) => a.runKey === data.runKey)) {
			throw new Error("fake: unique constraint failed on runKey");
		}
		// Stamped just before the tests' NOW, as a claim made at NOW would be.
		const at = new Date(NOW.getTime() - 60_000 + ++idCounter * 1000);
		const row: Row = {
			startedAt: null,
			completedAt: null,
			errorCode: null,
			errorMessage: null,
			model: null,
			sourceManifest: null,
			createdAt: at,
			updatedAt: at,
			...data,
		};
		store.analyses.push(row);
		return selectAnalysis(row, select);
	});

	// The re-run claim's two locking reads. The log records which row set
	// each one locked, in order.
	fake.$queryRaw.mockImplementation(
		(strings: TemplateStringsArray, ...values: unknown[]) => {
			const sql = rawSql(strings);
			if (sql.includes('FROM "project_document" d')) {
				lockLog.push("document");
				const row = store.documents.find((d) => d.id === values[0]);
				if (!row) {
					return [];
				}
				return [
					{
						id: row.id,
						projectId: row.projectId,
						content: row.content,
						version: row.version,
						status: row.status,
						organizationId:
							store.projects.get(row.projectId as string)
								?.organizationId ?? null,
					},
				];
			}
			if (sql.includes('FROM "project_document_analysis"')) {
				lockLog.push("runs");
				expect(sql).toContain("\"status\" IN ('PENDING', 'RUNNING')");
				return sortRows(
					store.analyses.filter(
						(a) =>
							a.documentId === values[0] &&
							a.organizationId === values[1] &&
							(a.status === "PENDING" || a.status === "RUNNING"),
					),
					{ id: "asc" },
				).map((a) => ({
					id: a.id,
					status: a.status,
					updatedAt: a.updatedAt,
				}));
			}
			throw new Error(`fake: unexpected raw query ${sql}`);
		},
	);

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

	const response = fake.projectDocumentFindingResponse;
	response.createMany.mockImplementation(({ data, skipDuplicates }) => {
		let count = 0;
		for (const input of data as Row[]) {
			// The unique key is (documentId, stableKey).
			if (
				store.responses.some(
					(r) =>
						r.documentId === input.documentId &&
						r.stableKey === input.stableKey,
				)
			) {
				if (skipDuplicates) {
					continue;
				}
				throw new Error("fake: unique constraint failed");
			}
			const at = new Date(Date.UTC(2026, 9, 7, 10, 0, ++idCounter));
			store.responses.push({
				id: nextId("response"),
				version: 1,
				createdAt: at,
				updatedAt: at,
				...input,
			});
			count += 1;
		}
		return { count };
	});
	response.updateMany.mockImplementation(({ where, data }) =>
		updateRows(store.responses, where, {
			...data,
			updatedAt: new Date(Date.UTC(2026, 9, 7, 11, 0, ++idCounter)),
		}),
	);
	response.findFirst.mockImplementation(({ where, select }) => {
		const row = store.responses.find((r) => matches(r, where));
		return row ? selectScalars(row, select) : null;
	});
	response.findMany.mockImplementation(({ where, orderBy, select }) =>
		sortRows(
			store.responses.filter((r) => matches(r, where)),
			orderBy,
		).map((row) => selectScalars(row, select)),
	);
	response.deleteMany.mockImplementation(({ where }) => {
		const before = store.responses.length;
		store.responses = store.responses.filter((r) => !matches(r, where));
		return { count: before - store.responses.length };
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
	store.responses = [];
	store.styles = [];
	lockLog = [];
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
		["ProjectDocumentAnalysisKind", PROPOSAL_ANALYSIS_KINDS],
		["ProjectDocumentFindingSeverity", PROPOSAL_FINDING_SEVERITIES],
		["ProjectDocumentFindingType", PROPOSAL_FINDING_TYPES],
		["ProjectDocumentFindingResponseKind", PROPOSAL_FINDING_RESPONSE_KINDS],
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
// Analysis review (Fizzy #2946): keys, manifests, the shown run, re-runs and
// answers
// ---------------------------------------------------------------------------

/**
 * A stand-in for the document prose hash: blind to markdown markers and
 * whitespace, as the real one is blind to formatting.
 */
const proseHashOf = (content: string) =>
	`p1:${content.replace(/[\s#*_-]/g, "")}`;

const REWRITTEN = "# Example proposal\n\n## Scope\n\nA different engagement.";

const minutesBefore = (date: Date, minutes: number) =>
	new Date(date.getTime() - minutes * 60_000);

let runClock = 0;
beforeEach(() => {
	runClock = 0;
});

/** A run row as the writers leave it; COMPLETE GENERATION by default. */
function seedRun(overrides: Row = {}): Row {
	runClock += 1;
	const at = new Date(Date.UTC(2026, 9, 7, 8, 0, runClock));
	const row: Row = {
		id: `run-${String(runClock).padStart(3, "0")}`,
		organizationId: ORG,
		projectId: PROJECT,
		documentId: DOC,
		runKey: `proposal-analysis-seeded-${runClock}`,
		status: "COMPLETE",
		kind: "GENERATION",
		analyzedContent: MAIN,
		contentHash: computeDocumentContentHash(MAIN),
		proseHash: proseHashOf(MAIN),
		sourceContext: "### Source 1\nContext",
		sourceManifest: null,
		sourceRunId: null,
		documentVersion: 3,
		contextCount: 1,
		promptVersionId: null,
		model: null,
		errorCode: null,
		errorMessage: null,
		startedAt: at,
		completedAt: at,
		createdAt: at,
		updatedAt: at,
		...overrides,
	};
	store.analyses.push(row);
	return row;
}

function manifestEntry(source: number, overrides: Row = {}) {
	return {
		source,
		kind: "projectContext" as const,
		id: `context-${source}`,
		contextType: "LINK",
		title: `Source ${source}`,
		fingerprint: `f${source}`,
		...overrides,
	};
}

describe("the shared timeout rule", () => {
	it("measures silence, not age: a run times out only past twenty minutes without an update", () => {
		const lastUpdate = new Date(
			NOW.getTime() - PROPOSAL_ANALYSIS_TIMEOUT_MS,
		);
		expect(PROPOSAL_ANALYSIS_TIMEOUT_MS).toBe(20 * 60 * 1000);
		expect(
			isAnalysisRunTimedOut(
				{ status: "RUNNING", updatedAt: lastUpdate },
				NOW,
			),
		).toBe(false);
		expect(
			isAnalysisRunTimedOut(
				{
					status: "RUNNING",
					updatedAt: new Date(lastUpdate.getTime() - 1),
				},
				NOW,
			),
		).toBe(true);
		expect(
			isAnalysisRunTimedOut(
				{ status: "PENDING", updatedAt: minutesBefore(NOW, 21) },
				NOW,
			),
		).toBe(true);
	});

	it.each(["COMPLETE", "FAILED"] as const)(
		"a %s run never times out",
		(status) => {
			expect(
				isAnalysisRunTimedOut(
					{ status, updatedAt: minutesBefore(NOW, 600) },
					NOW,
				),
			).toBe(false);
		},
	);
});

describe("createAnalysisRun records the prose hash and the source manifest", () => {
	it("hashes the body read back from the document and stores the bounded manifest", async () => {
		seedDocument({ status: "COMPLETE" });
		const hash = vi.fn(proseHashOf);

		const run = await recordRun({
			documentId: DOC,
			runKey: "proposal-analysis-example",
			sourceContext: "### Source 1\nContext",
			contextCount: 1,
			computeProseHash: hash,
			sourceManifest: [manifestEntry(1)],
		});

		expect(hash).toHaveBeenCalledWith(MAIN);
		expect(analysisRow(run.analysisId)).toMatchObject({
			kind: "GENERATION",
			proseHash: proseHashOf(MAIN),
			sourceRunId: null,
			sourceManifest: [
				{
					source: 1,
					kind: "projectContext",
					id: "context-1",
					contextType: "LINK",
					title: "Source 1",
					sourceName: null,
					fingerprint: "f1",
				},
			],
		});
		const [stored] = analysisRow(run.analysisId).sourceManifest as Row[];
		expect(stored).not.toHaveProperty("excerpt");
	});

	it("without either, stores neither, exactly as before", async () => {
		seedDocument({ status: "COMPLETE" });
		const run = await recordRun({
			documentId: DOC,
			runKey: "proposal-analysis-example",
			sourceContext: "Context",
			contextCount: 1,
		});
		expect(analysisRow(run.analysisId)).toMatchObject({
			kind: "GENERATION",
			proseHash: null,
			sourceManifest: null,
		});
	});
});

describe("source manifests are bounded on write and parsed on read", () => {
	it("cuts long text, strips null bytes, keeps at most the cap, and leaves out entries the schema refuses", () => {
		const manifest = normalizeSourceManifest([
			manifestEntry(1, {
				title: "Ti\u0000tle",
				sourceName: "n".repeat(
					PROPOSAL_SOURCE_MANIFEST_LABEL_MAX_LENGTH + 40,
				),
			}),
			manifestEntry(0),
			manifestEntry(2, { kind: "document" }),
			manifestEntry(3, { fingerprint: "" }),
			manifestEntry(4, { source: 4.5 }),
			...Array.from(
				{ length: PROPOSAL_SOURCE_MANIFEST_MAX_ENTRIES + 5 },
				(_, index) => manifestEntry(10 + index),
			),
		]);

		expect(manifest).toHaveLength(PROPOSAL_SOURCE_MANIFEST_MAX_ENTRIES);
		expect(manifest[0]).toMatchObject({ source: 1, title: "Title" });
		expect(manifest[0]?.sourceName).toHaveLength(
			PROPOSAL_SOURCE_MANIFEST_LABEL_MAX_LENGTH,
		);
		const sources = manifest.map((entry) => entry.source);
		expect(sources).not.toContain(0);
		expect(sources).not.toContain(2);
		expect(sources).not.toContain(3);
		expect(sources).not.toContain(4.5);
	});

	it("never splits a surrogate pair when it cuts a label", () => {
		const [entry] = normalizeSourceManifest([
			manifestEntry(1, {
				title: `${"a".repeat(PROPOSAL_SOURCE_MANIFEST_LABEL_MAX_LENGTH - 1)}😀`,
			}),
		]);
		expect(entry?.title).toBe(
			"a".repeat(PROPOSAL_SOURCE_MANIFEST_LABEL_MAX_LENGTH - 1),
		);
	});

	it("keeps no source text: an excerpt a writer still hands in is not stored", () => {
		const [entry] = normalizeSourceManifest([
			{
				...manifestEntry(1),
				excerpt: "Text the source no longer holds.",
			} as never,
		]);
		expect(entry).toBeDefined();
		expect(entry).not.toHaveProperty("excerpt");
	});

	it("an old or damaged stored value reads as no manifest, never as an error", () => {
		expect(parseStoredSourceManifest(null)).toBeNull();
		expect(parseStoredSourceManifest({ not: "an array" })).toBeNull();
		expect(parseStoredSourceManifest([{ source: "1" }])).toBeNull();
		const stored = normalizeSourceManifest([manifestEntry(1)]);
		expect(parseStoredSourceManifest(stored)).toEqual(stored);
	});
});

describe("readProposalEvidenceSources reads the cited rows as they are now", () => {
	type RawCall = { sql: string; values: unknown[] };

	function recordRawQueries(answer: (call: RawCall) => Row[]): RawCall[] {
		const calls: RawCall[] = [];
		fake.$queryRaw.mockImplementation(
			(strings: TemplateStringsArray, ...values: unknown[]) => {
				const call = { sql: rawSql(strings), values };
				calls.push(call);
				return answer(call);
			},
		);
		return calls;
	}

	it("reads contexts only in the project and the owning organization, and company sources only of that organization and not being deleted", async () => {
		const calls = recordRawQueries(({ sql }) =>
			sql.includes('FROM "project_context"')
				? [
						{
							id: "context-1",
							type: "TEXT",
							sourceTitle: "Discovery notes",
							originalFilename: null,
							sourcePath: null,
							contentHead: "The client wants SSO.",
						},
					]
				: [
						{
							id: "company-1",
							sourceTitle: "Rate card",
							originalFilename: null,
							contentHead: "Senior rate is fixed.",
						},
					],
		);

		const read = await readProposalEvidenceSources({
			organizationId: ORG,
			projectId: PROJECT,
			contextIds: ["context-1", "context-1"],
			companySourceIds: ["company-1"],
		});

		expect(read).toEqual({
			contexts: [
				{
					id: "context-1",
					type: "TEXT",
					sourceTitle: "Discovery notes",
					originalFilename: null,
					sourcePath: null,
					contentHead: "The client wants SSO.",
				},
			],
			companySources: [
				{
					id: "company-1",
					sourceTitle: "Rate card",
					originalFilename: null,
					contentHead: "Senior rate is fixed.",
				},
			],
		});
		const contexts = calls.find(({ sql }) =>
			sql.includes('FROM "project_context"'),
		);
		const companies = calls.find(({ sql }) =>
			sql.includes('FROM "company_context_source"'),
		);
		expect(contexts?.sql).toContain('c."projectId" = ?');
		expect(contexts?.sql).toContain('c."organizationId" = ?');
		expect(contexts?.values).toEqual([
			PROPOSAL_EVIDENCE_TEXT_HEAD_LENGTH,
			["context-1"],
			PROJECT,
			ORG,
		]);
		expect(companies?.sql).toContain('s."organizationId" = ?');
		expect(companies?.sql).toContain('s."deletingAt" IS NULL');
		expect(companies?.values).toEqual([
			PROPOSAL_EVIDENCE_TEXT_HEAD_LENGTH,
			["company-1"],
			ORG,
		]);
	});

	it("reads only the opening of each row's text and never a source address", async () => {
		const calls = recordRawQueries(() => []);

		await readProposalEvidenceSources({
			organizationId: ORG,
			projectId: PROJECT,
			contextIds: ["context-1"],
			companySourceIds: ["company-1"],
		});

		expect(calls).toHaveLength(2);
		for (const { sql } of calls) {
			expect(sql).toMatch(/left\([cs]\."content", \?\) AS "contentHead"/);
			// The whole body is never selected: that one read is the only one.
			expect(sql.match(/\."content"/g)).toHaveLength(1);
			expect(sql).not.toContain("sourceUrl");
		}
	});

	it("asks nothing for an empty list", async () => {
		const calls = recordRawQueries(() => []);

		expect(
			await readProposalEvidenceSources({
				organizationId: ORG,
				projectId: PROJECT,
				contextIds: [],
				companySourceIds: [],
			}),
		).toEqual({ contexts: [], companySources: [] });
		expect(calls).toEqual([]);
	});
});

describe("findings keep their keys", () => {
	it("completeAnalysisRun stores each finding's key, section, refs and folded titles", async () => {
		seedDocument({ status: "COMPLETE" });
		const { analysisId } = await recordRun({
			documentId: DOC,
			runKey: "proposal-analysis-example",
			sourceContext: "Context",
			contextCount: 1,
		});

		await completeAnalysisRun({
			analysisId,
			findings: [
				{
					severity: "BLOCKING",
					type: "COMMERCIAL",
					title: "Pricing is not stated",
					detail: "The commercial section names no figure.",
					stableKey: "commercial|scope|pricing",
					sectionKey: "scope#0",
					sectionHash: "p1:scope",
					sourceRefs: [2, 0, 1.5, -3, 4],
					foldedTitles: ["No price given"],
				},
				{
					severity: "INFORMATIONAL",
					type: "OPPORTUNITY",
					title: "Follow-on phase",
					detail: "A second phase is implied.",
				},
			],
			now: NOW,
		});

		expect(
			sortRows(findingsOf(analysisId), { position: "asc" }),
		).toMatchObject([
			{
				stableKey: "commercial|scope|pricing",
				sectionKey: "scope#0",
				sectionHash: "p1:scope",
				sourceRefs: [2, 4],
				foldedTitles: ["No price given"],
			},
			{
				stableKey: null,
				sectionKey: null,
				sectionHash: null,
				sourceRefs: [],
				foldedTitles: [],
			},
		]);
	});

	it("a finding written before keys existed reads without error and matches no answer", async () => {
		seedDocument({ status: "COMPLETE" });
		const run = seedRun();
		store.findings.push({
			id: "finding-before-keys",
			organizationId: ORG,
			analysisId: run.id,
			severity: "IMPORTANT",
			type: "RISK",
			title: "Delivery risk",
			detail: "The timeline is tight.",
			recommendation: null,
			sectionHeading: "Scope",
			position: 0,
			stableKey: null,
			sectionKey: null,
			sectionHash: null,
			sourceRefs: [],
			foldedTitles: [],
		});
		await upsertFindingResponse({
			organizationId: ORG,
			projectId: PROJECT,
			documentId: DOC,
			stableKey: "risk|scope|timeline",
			kind: "CONFIRMED",
			findingTitle: "Delivery risk",
			answeredRunId: run.id as string,
			sectionKey: "scope#0",
			sectionHash: "p1:scope",
			authorId: "user-example",
		});

		const shown = await getAnalysisForCurrentContent({
			organizationId: ORG,
			documentId: DOC,
			currentProseHash: proseHashOf(MAIN),
			computeProseHash: proseHashOf,
			now: NOW,
		});
		const [finding] = shown.run?.findings ?? [];
		expect(finding).toMatchObject({
			title: "Delivery risk",
			stableKey: null,
			sourceRefs: [],
			foldedTitles: [],
		});
		const responses = await listResponsesForDocument({
			organizationId: ORG,
			documentId: DOC,
		});
		expect(responses).toHaveLength(1);
		expect(
			responses.some(
				(response) => response.stableKey === finding?.stableKey,
			),
		).toBe(false);
	});
});

describe("a re-run reads its source run's material", () => {
	it("a generation run reads its own context and manifest, as before re-runs existed", async () => {
		seedDocument({ status: "COMPLETE" });
		const manifest = normalizeSourceManifest([manifestEntry(1)]);
		const run = seedRun({
			status: "PENDING",
			proseHash: null,
			sourceManifest: manifest,
		});

		expect(await getAnalysisRunInput(run.id as string)).toEqual({
			analysisId: run.id,
			documentId: DOC,
			projectId: PROJECT,
			organizationId: ORG,
			status: "PENDING",
			kind: "GENERATION",
			analyzedContent: MAIN,
			contentHash: computeDocumentContentHash(MAIN),
			proseHash: null,
			sourceContext: "### Source 1\nContext",
			sourceManifest: manifest,
			sourceContextRunId: run.id,
			sourceRunId: null,
			contextCount: 1,
			documentVersion: 3,
			promptVersionId: null,
		});
	});

	it("a RERUN row with an empty source context reads its source run's context and manifest", async () => {
		seedDocument({ status: "COMPLETE" });
		const manifest = normalizeSourceManifest([manifestEntry(1)]);
		const source = seedRun({
			sourceContext: "### Source 1\nGeneration context",
			sourceManifest: manifest,
		});
		const rerun = seedRun({
			status: "PENDING",
			kind: "RERUN",
			sourceRunId: source.id,
			sourceContext: "",
			analyzedContent: REWRITTEN,
		});

		expect(await getRunSourceContext(rerun.id as string)).toEqual({
			fromRunId: source.id,
			sourceContext: "### Source 1\nGeneration context",
			sourceManifest: manifest,
		});
		expect(await getAnalysisRunInput(rerun.id as string)).toMatchObject({
			kind: "RERUN",
			analyzedContent: REWRITTEN,
			sourceRunId: source.id,
			sourceContextRunId: source.id,
			sourceContext: "### Source 1\nGeneration context",
			sourceManifest: manifest,
		});
	});

	it("a re-run with no source run, or one pointing at another document's run, reads none", async () => {
		seedDocument({ status: "COMPLETE" });
		const none = seedRun({ kind: "RERUN", sourceContext: "" });
		const foreign = seedRun({
			documentId: "doc-other",
			sourceContext: "Another document's context",
		});
		const crossed = seedRun({
			kind: "RERUN",
			sourceRunId: foreign.id,
			sourceContext: "",
		});

		for (const run of [none, crossed]) {
			expect(await getRunSourceContext(run.id as string)).toEqual({
				fromRunId: null,
				sourceContext: "",
				sourceManifest: null,
			});
		}
		expect(await getRunSourceContext("analysis-missing")).toBeNull();
	});
});

describe("getAnalysisForCurrentContent", () => {
	function read(
		currentContent: string,
		overrides: Partial<
			Parameters<typeof getAnalysisForCurrentContent>[0]
		> = {},
	) {
		return getAnalysisForCurrentContent({
			organizationId: ORG,
			documentId: DOC,
			currentProseHash: proseHashOf(currentContent),
			computeProseHash: proseHashOf,
			now: NOW,
			...overrides,
		});
	}

	beforeEach(() => {
		seedDocument({ status: "COMPLETE" });
	});

	it("shows the COMPLETE run that describes the current content, even under a newer one that does not (after a Reject)", async () => {
		const original = seedRun();
		seedRun({
			analyzedContent: REWRITTEN,
			proseHash: proseHashOf(REWRITTEN),
		});

		const result = await read(MAIN);
		expect(result.run?.id).toBe(original.id);
		expect(result.isStale).toBe(false);
		expect(result.newerRun).toBeNull();
	});

	it("shows the run describing restored content however many runs ago it was recorded", async () => {
		const original = seedRun();
		for (let n = 0; n < PROPOSAL_ANALYSIS_MATCH_WINDOW; n += 1) {
			const content = `${REWRITTEN} Version ${n}.`;
			seedRun({
				analyzedContent: content,
				proseHash: proseHashOf(content),
			});
		}

		const result = await read(MAIN);
		expect(result.run?.id).toBe(original.id);
		expect(result.run?.proseHash).toBe(proseHashOf(MAIN));
		expect(result.isStale).toBe(false);
		expect(result.newerRun).toBeNull();
	});

	it("after a Reject, reports nothing when the newest run completed, though a failed run lies between it and the shown one", async () => {
		const shown = seedRun();
		// A regeneration whose analysis failed, then one whose analysis
		// completed; the Reject restored the content the first run describes.
		seedRun({
			status: "FAILED",
			errorCode: "MODEL_ERROR",
			analyzedContent: REWRITTEN,
			proseHash: proseHashOf(REWRITTEN),
		});
		const newest = seedRun({
			analyzedContent: REWRITTEN,
			proseHash: proseHashOf(REWRITTEN),
		});

		const result = await read(MAIN);
		expect(result.run?.id).toBe(shown.id);
		expect(result.isStale).toBe(false);
		expect(result.newerRun).toBeNull();

		// The same history with the newest run still in progress reports it.
		newest.status = "RUNNING";
		newest.completedAt = null;
		newest.updatedAt = minutesBefore(NOW, 1);
		expect((await read(MAIN)).newerRun).toMatchObject({
			id: newest.id,
			status: "RUNNING",
			timedOut: false,
		});
	});

	it("a formatting-only change keeps the run current", async () => {
		const run = seedRun();
		const result = await read(
			"# Example proposal\n\n## Scope\n\n*What the engagement covers.*",
		);
		expect(result.run?.id).toBe(run.id);
		expect(result.isStale).toBe(false);
	});

	it("shows the newest COMPLETE run as stale when none describes the current content", async () => {
		seedRun();
		const newest = seedRun({
			analyzedContent: REWRITTEN,
			proseHash: proseHashOf(REWRITTEN),
		});
		const result = await read("# Example proposal\n\nRewritten by hand.");
		expect(result.run?.id).toBe(newest.id);
		expect(result.isStale).toBe(true);
	});

	it("shows the COMPLETE run under a newer FAILED one, and reports that run", async () => {
		const complete = seedRun();
		const failed = seedRun({ status: "FAILED", errorCode: "MODEL_ERROR" });

		const result = await read(MAIN);
		expect(result.run?.id).toBe(complete.id);
		expect(result.isStale).toBe(false);
		expect(result.newerRun).toEqual({
			id: failed.id,
			kind: "GENERATION",
			status: "FAILED",
			errorCode: "MODEL_ERROR",
			timedOut: false,
			createdAt: failed.createdAt,
		});
	});

	it("reports a newer run in progress, timed out only after twenty minutes of silence", async () => {
		seedRun();
		const running = seedRun({
			status: "RUNNING",
			kind: "RERUN",
			completedAt: null,
			createdAt: minutesBefore(NOW, 25),
			updatedAt: minutesBefore(NOW, 5),
		});

		expect((await read(MAIN)).newerRun).toMatchObject({
			id: running.id,
			kind: "RERUN",
			status: "RUNNING",
			timedOut: false,
		});
		running.updatedAt = minutesBefore(NOW, 21);
		expect((await read(MAIN)).newerRun).toMatchObject({
			id: running.id,
			timedOut: true,
		});
	});

	it("an unfinished run older than the shown one is not reported", async () => {
		seedRun({ status: "FAILED", errorCode: "MODEL_ERROR" });
		seedRun();
		expect((await read(MAIN)).newerRun).toBeNull();
	});

	it("before any run completes, shows no run and reports the one in progress", async () => {
		const pending = seedRun({ status: "PENDING", completedAt: null });
		expect(await read(MAIN)).toEqual({
			run: null,
			isStale: false,
			newerRun: expect.objectContaining({
				id: pending.id,
				status: "PENDING",
			}),
		});
	});

	it("hashes the body of a run recorded before prose hashes existed, and reads bodies only when it must", async () => {
		const legacy = seedRun({ proseHash: null });
		const hash = vi.fn(proseHashOf);

		const result = await read(MAIN, { computeProseHash: hash });
		expect(result.run?.id).toBe(legacy.id);
		expect(result.run?.proseHash).toBe(proseHashOf(MAIN));
		expect(result.isStale).toBe(false);
		expect(hash).toHaveBeenCalledTimes(1);
		expect(hash).toHaveBeenCalledWith(MAIN);

		// A newer run whose stored hash matches needs no body at all.
		const current = seedRun();
		hash.mockClear();
		fake.projectDocumentAnalysis.findMany.mockClear();
		const again = await read(MAIN, { computeProseHash: hash });
		expect(again.run?.id).toBe(current.id);
		expect(hash).not.toHaveBeenCalled();
		const bodyReads =
			fake.projectDocumentAnalysis.findMany.mock.calls.filter(
				([args]) => (args as { select: Row }).select.analyzedContent,
			);
		expect(bodyReads).toHaveLength(0);
	});

	it("recomputes a hash stored by another normalizer version instead of reading it as changed", async () => {
		const run = seedRun({ proseHash: "p0:an-older-projection" });
		const result = await read(MAIN);
		expect(result.run?.id).toBe(run.id);
		expect(result.run?.proseHash).toBe(proseHashOf(MAIN));
		expect(result.isStale).toBe(false);
	});

	it("never returns the analyzed body or the source context, and gives a re-run its source run's manifest", async () => {
		const manifest = normalizeSourceManifest([manifestEntry(1)]);
		const source = seedRun({ sourceManifest: manifest });
		const rerun = seedRun({
			kind: "RERUN",
			sourceRunId: source.id,
			sourceContext: "",
		});

		const result = await read(MAIN);
		expect(result.run?.id).toBe(rerun.id);
		expect(result.run).not.toHaveProperty("analyzedContent");
		expect(result.run).not.toHaveProperty("sourceContext");
		expect(result.run).toMatchObject({
			kind: "RERUN",
			sourceRunId: source.id,
			sourceManifest: manifest,
		});
	});

	it("reads nothing of another organization", async () => {
		seedRun();
		seedRun({ status: "FAILED" });
		expect(await read(MAIN, { organizationId: OTHER_ORG })).toEqual({
			run: null,
			isStale: false,
			newerRun: null,
		});
	});
});

describe("claimRerun", () => {
	function claim(overrides: Partial<ClaimRerunInput> = {}) {
		return claimRerun({
			organizationId: ORG,
			projectId: PROJECT,
			documentId: DOC,
			promptVersionId: "prompt-version-2",
			computeProseHash: proseHashOf,
			now: NOW,
			...overrides,
		});
	}

	async function claimed(overrides: Partial<ClaimRerunInput> = {}) {
		const result = await claim(overrides);
		if (result.outcome !== "claimed") {
			throw new Error(`expected a claim, got ${result.reason}`);
		}
		return result.run;
	}

	it("records a RERUN of the current content that reads the generation run describing it", async () => {
		seedDocument({ status: "COMPLETE", version: 5 });
		const generation = seedRun({ contextCount: 4 });

		const run = await claimed();

		expect(run).toMatchObject({
			sourceRunId: generation.id,
			proseHash: proseHashOf(MAIN),
			contentHash: computeDocumentContentHash(MAIN),
			documentVersion: 5,
			timedOutRunIds: [],
		});
		expect(run.runKey).toBe(
			`proposal-analysis-rerun-${DOC}-${run.analysisId}`,
		);
		expect(analysisRow(run.analysisId)).toMatchObject({
			organizationId: ORG,
			projectId: PROJECT,
			documentId: DOC,
			runKey: run.runKey,
			status: "PENDING",
			kind: "RERUN",
			sourceRunId: generation.id,
			analyzedContent: MAIN,
			contentHash: computeDocumentContentHash(MAIN),
			proseHash: proseHashOf(MAIN),
			sourceContext: "",
			documentVersion: 5,
			contextCount: 4,
			promptVersionId: "prompt-version-2",
		});
		expect(lockLog).toEqual(["document", "runs"]);
	});

	it("a second claim while the first run is pending is a conflict and writes nothing", async () => {
		seedDocument({ status: "COMPLETE" });
		seedRun();

		await claimed();
		const count = store.analyses.length;
		expect(await claim()).toEqual({
			outcome: "conflict",
			reason: "ANALYSIS_IN_PROGRESS",
		});
		expect(store.analyses).toHaveLength(count);
	});

	it("a RUNNING run with no update for more than twenty minutes is marked FAILED and does not block", async () => {
		seedDocument({ status: "COMPLETE" });
		seedRun();
		const stuck = seedRun({
			status: "RUNNING",
			completedAt: null,
			createdAt: minutesBefore(NOW, 40),
			updatedAt: minutesBefore(NOW, 21),
		});

		const run = await claimed();

		expect(run.timedOutRunIds).toEqual([stuck.id]);
		expect(stuck).toMatchObject({
			status: "FAILED",
			errorCode: PROPOSAL_ANALYSIS_TIMED_OUT_FAILURE.errorCode,
			errorMessage: PROPOSAL_ANALYSIS_TIMED_OUT_FAILURE.errorMessage,
			completedAt: NOW,
		});
		// The attempt still running may finish its model call; its completion
		// and any further attempt are refused.
		expect(
			await completeAnalysisRun({
				analysisId: stuck.id as string,
				findings: [],
			}),
		).toBe("superseded");
		expect(await markAnalysisRunning(stuck.id as string, NOW)).toBe(
			"superseded",
		);
	});

	it("a RUNNING run created 25 minutes ago but updated 5 minutes ago (a retried attempt) blocks", async () => {
		seedDocument({ status: "COMPLETE" });
		seedRun();
		const retried = seedRun({
			status: "RUNNING",
			completedAt: null,
			createdAt: minutesBefore(NOW, 25),
			updatedAt: minutesBefore(NOW, 5),
		});
		const count = store.analyses.length;

		expect(await claim()).toEqual({
			outcome: "conflict",
			reason: "ANALYSIS_IN_PROGRESS",
		});
		expect(store.analyses).toHaveLength(count);
		expect(retried.status).toBe("RUNNING");
	});

	it("a run in progress blocks even beside one that timed out, and the timed-out one is left alone", async () => {
		seedDocument({ status: "COMPLETE" });
		const stuck = seedRun({
			status: "RUNNING",
			completedAt: null,
			updatedAt: minutesBefore(NOW, 45),
		});
		seedRun({ status: "PENDING", completedAt: null, updatedAt: NOW });

		expect(await claim()).toMatchObject({ outcome: "conflict" });
		expect(stuck.status).toBe("RUNNING");
	});

	it.each(["QUEUED", "GENERATING"])(
		"a %s document is a conflict and gets no run",
		async (status) => {
			seedDocument({ status });
			seedRun();
			expect(await claim()).toEqual({
				outcome: "conflict",
				reason: "DOCUMENT_GENERATING",
			});
			expect(store.analyses).toHaveLength(1);
			expect(lockLog).toEqual(["document"]);
		},
	);

	it("after a Reject, reads the generation run that described the restored content", async () => {
		seedDocument({ status: "COMPLETE", content: MAIN });
		const original = seedRun({ contextCount: 2 });
		// The rejected regeneration's run, newer but describing other content.
		seedRun({
			analyzedContent: REWRITTEN,
			proseHash: proseHashOf(REWRITTEN),
			contextCount: 7,
		});

		const run = await claimed();
		expect(run.sourceRunId).toBe(original.id);
		expect(analysisRow(run.analysisId).contextCount).toBe(2);
	});

	it("reads the generation run describing restored content however many generations ago it was recorded", async () => {
		seedDocument({ status: "COMPLETE", content: MAIN });
		const original = seedRun({ contextCount: 2 });
		for (let n = 0; n < PROPOSAL_ANALYSIS_MATCH_WINDOW; n += 1) {
			const content = `${REWRITTEN} Version ${n}.`;
			seedRun({
				analyzedContent: content,
				proseHash: proseHashOf(content),
				contextCount: 7,
			});
		}

		const run = await claimed();
		expect(run.sourceRunId).toBe(original.id);
		expect(analysisRow(run.analysisId).contextCount).toBe(2);
	});

	it("matches a generation run recorded before prose hashes existed by hashing its body", async () => {
		seedDocument({ status: "COMPLETE", content: MAIN });
		const legacy = seedRun({ proseHash: null });
		seedRun({
			analyzedContent: REWRITTEN,
			proseHash: proseHashOf(REWRITTEN),
		});

		expect((await claimed()).sourceRunId).toBe(legacy.id);
	});

	it("with no generation run describing the content, reads the newest COMPLETE run that stored source context; a re-run is never the source", async () => {
		seedDocument({
			status: "COMPLETE",
			content: "# Example proposal\n\n## Scope\n\nEdited by hand.",
		});
		const withContext = seedRun({
			analyzedContent: REWRITTEN,
			proseHash: proseHashOf(REWRITTEN),
		});
		// A generation that had no context, and a skipped run.
		seedRun({ sourceContext: "" });
		seedRun({
			status: "FAILED",
			sourceContext: "",
			errorCode: "GUEST_TRIGGERED",
		});
		// A re-run that describes the edited content exactly.
		seedRun({
			kind: "RERUN",
			sourceRunId: withContext.id,
			sourceContext: "",
			analyzedContent:
				"# Example proposal\n\n## Scope\n\nEdited by hand.",
			proseHash: proseHashOf(
				"# Example proposal\n\n## Scope\n\nEdited by hand.",
			),
		});

		expect((await claimed()).sourceRunId).toBe(withContext.id);
	});

	it("reads the newest generation's own sources when its analysis failed after storing them", async () => {
		seedDocument({ status: "COMPLETE", content: MAIN });
		seedRun({ contextCount: 2 });
		const failed = seedRun({
			status: "FAILED",
			errorCode: "MODEL_ERROR",
			sourceContext: "### Source 1\nThe failed run's context",
			contextCount: 5,
		});

		const run = await claimed();
		expect(run.sourceRunId).toBe(failed.id);
		expect(analysisRow(run.analysisId).contextCount).toBe(5);
	});

	it("never reads a failed run that stored no context, though it describes the content", async () => {
		seedDocument({ status: "COMPLETE", content: MAIN });
		const complete = seedRun({ contextCount: 2 });
		// A generation a project guest started: recorded FAILED, no context.
		seedRun({
			status: "FAILED",
			errorCode: "GUEST_TRIGGERED",
			sourceContext: "",
			contextCount: 3,
		});

		expect((await claimed()).sourceRunId).toBe(complete.id);
	});

	it("with no generation run describing the content, falls back to the newest run with context even when its analysis failed", async () => {
		seedDocument({
			status: "COMPLETE",
			content: "# Example proposal\n\n## Scope\n\nEdited by hand.",
		});
		seedRun();
		const failed = seedRun({
			status: "FAILED",
			errorCode: "MODEL_ERROR",
			analyzedContent: REWRITTEN,
			proseHash: proseHashOf(REWRITTEN),
		});
		// Newer still, but recorded FAILED without context.
		seedRun({
			status: "FAILED",
			errorCode: "PROMPT_NOT_BOUND",
			sourceContext: "",
		});

		expect((await claimed()).sourceRunId).toBe(failed.id);
	});

	it("reads a generation run the claim itself found timed out, since it stored its context when recorded", async () => {
		seedDocument({ status: "COMPLETE", content: MAIN });
		seedRun();
		const stuck = seedRun({
			status: "RUNNING",
			completedAt: null,
			updatedAt: minutesBefore(NOW, 21),
		});

		const run = await claimed();
		expect(run.timedOutRunIds).toEqual([stuck.id]);
		expect(run.sourceRunId).toBe(stuck.id);
	});

	it("with no COMPLETE run at all, records a re-run without source material", async () => {
		seedDocument({ status: "COMPLETE" });
		seedRun({
			status: "FAILED",
			sourceContext: "",
			errorCode: "PROMPT_NOT_BOUND",
		});

		const run = await claimed();
		expect(run.sourceRunId).toBeNull();
		expect(analysisRow(run.analysisId)).toMatchObject({
			sourceRunId: null,
			contextCount: 0,
			sourceContext: "",
		});
	});

	it("each claim mints its own run id, so every re-run has its own key", async () => {
		seedDocument({ status: "COMPLETE" });
		seedRun();

		const first = await claimed();
		analysisRow(first.analysisId).status = "COMPLETE";
		const second = await claimed();

		expect(second.analysisId).not.toBe(first.analysisId);
		expect(second.runKey).not.toBe(first.runKey);
		for (const run of [first, second]) {
			expect(run.runKey.endsWith(`-${run.analysisId}`)).toBe(true);
		}
	});

	it.each([
		["another organization", { organizationId: OTHER_ORG }],
		["another project", { projectId: "project-elsewhere" }],
	])(
		"refuses a document of %s and writes nothing",
		async (_label, overrides) => {
			seedDocument({ status: "COMPLETE" });
			seedRun();
			await expect(claim(overrides)).rejects.toBeInstanceOf(
				ProposalArtifactTenantError,
			);
			expect(store.analyses).toHaveLength(1);
		},
	);

	it("refuses a document outside an organization project", async () => {
		seedDocument({
			status: "COMPLETE",
			projectId: PERSONAL_PROJECT,
			organizationId: null,
		});
		await expect(
			claim({ projectId: PERSONAL_PROJECT }),
		).rejects.toBeInstanceOf(ProposalArtifactTenantError);
		expect(store.analyses).toHaveLength(0);
	});
});

describe("finding responses", () => {
	const KEY = "commercial|scope|pricing";
	let answeredRun: Row;

	/** A first answer; an edit spreads in the id and version it saw. */
	function answer(
		overrides: Partial<
			Omit<
				UpsertFindingResponseInput,
				"expectedResponseId" | "expectedVersion"
			>
		> = {},
	): UpsertFindingResponseInput {
		return {
			organizationId: ORG,
			projectId: PROJECT,
			documentId: DOC,
			stableKey: KEY,
			kind: "RESPONDED",
			text: "The fixed fee is in the commercial annex.",
			findingTitle: "Pricing is not stated",
			answeredRunId: answeredRun.id as string,
			sectionKey: "scope#0",
			sectionHash: "p1:scope",
			authorId: "user-example",
			...overrides,
		};
	}

	/** The saved row's id, the other half of the compare-and-swap token. */
	function writtenId(result: UpsertFindingResponseResult): string {
		if (result.outcome !== "written") {
			throw new Error("expected the answer to be written");
		}
		return result.response.id;
	}

	beforeEach(() => {
		seedDocument({ status: "COMPLETE" });
		answeredRun = seedRun();
	});

	it("a first answer is written at version 1 with tenant columns from the document's project", async () => {
		const result = await upsertFindingResponse(answer());

		expect(result).toMatchObject({
			outcome: "written",
			response: {
				documentId: DOC,
				stableKey: KEY,
				kind: "RESPONDED",
				text: "The fixed fee is in the commercial annex.",
				findingTitle: "Pricing is not stated",
				answeredRunId: answeredRun.id,
				sectionKey: "scope#0",
				sectionHash: "p1:scope",
				authorId: "user-example",
				version: 1,
			},
		});
		expect(store.responses).toEqual([
			expect.objectContaining({
				organizationId: ORG,
				projectId: PROJECT,
			}),
		]);
	});

	it("of two first answers for one key, one is written and the other is stale with it: one row, no unique-key error", async () => {
		const outcomes = await Promise.all([
			upsertFindingResponse(answer()),
			upsertFindingResponse(
				answer({ text: "Another answer.", authorId: "user-other" }),
			),
		]);

		expect(outcomes.map((o) => o.outcome).sort()).toEqual([
			"stale",
			"written",
		]);
		expect(store.responses).toHaveLength(1);
		const stale = outcomes.find((o) => o.outcome === "stale");
		expect(stale).toEqual({
			outcome: "stale",
			current: {
				id: store.responses[0]?.id,
				kind: "RESPONDED",
				text: store.responses[0]?.text,
				authorId: store.responses[0]?.authorId,
				version: 1,
				updatedAt: expect.any(Date),
			},
		});
	});

	it("replacing the version read bumps it; a write with an older version is stale and changes nothing", async () => {
		const id = writtenId(await upsertFindingResponse(answer()));
		const replaced = await upsertFindingResponse({
			...answer({
				kind: "CONFIRMED",
				text: null,
				authorId: "user-other",
			}),
			expectedResponseId: id,
			expectedVersion: 1,
		});
		expect(replaced).toMatchObject({
			outcome: "written",
			response: {
				id,
				kind: "CONFIRMED",
				text: null,
				authorId: "user-other",
				version: 2,
			},
		});

		const late = await upsertFindingResponse({
			...answer({ text: "A late edit." }),
			expectedResponseId: id,
			expectedVersion: 1,
		});
		expect(late).toEqual({
			outcome: "stale",
			current: {
				id,
				kind: "CONFIRMED",
				text: null,
				authorId: "user-other",
				version: 2,
				updatedAt: expect.any(Date),
			},
		});
		expect(store.responses).toHaveLength(1);
		expect(store.responses[0]).toMatchObject({
			kind: "CONFIRMED",
			version: 2,
		});
	});

	it("a first answer when one was saved meanwhile is stale", async () => {
		await upsertFindingResponse(answer());
		expect(
			await upsertFindingResponse(answer({ text: "A second first." })),
		).toMatchObject({ outcome: "stale", current: { version: 1 } });
		expect(store.responses[0]?.text).toBe(
			"The fixed fee is in the commercial annex.",
		);
	});

	it("an edit of an answer cleared meanwhile is stale with nothing saved, and creates nothing", async () => {
		const id = writtenId(await upsertFindingResponse(answer()));
		await clearFindingResponse({
			organizationId: ORG,
			documentId: DOC,
			stableKey: KEY,
			responseId: id,
			version: 1,
		});

		expect(
			await upsertFindingResponse({
				...answer(),
				expectedResponseId: id,
				expectedVersion: 1,
			}),
		).toEqual({ outcome: "stale", current: null });
		expect(store.responses).toHaveLength(0);
	});

	it("an edit or a clear naming an answer cleared and given again since is stale, though the new answer is back at version 1 (Fizzy #2946)", async () => {
		const seen = writtenId(await upsertFindingResponse(answer()));
		expect(
			await clearFindingResponse({
				organizationId: ORG,
				documentId: DOC,
				stableKey: KEY,
				responseId: seen,
				version: 1,
			}),
		).toEqual({ outcome: "cleared", kind: "RESPONDED" });
		// A colleague answers the same finding again: a new row at version 1.
		const again = await upsertFindingResponse(
			answer({ text: "A colleague's answer.", authorId: "user-other" }),
		);
		const colleague = writtenId(again);
		expect(colleague).not.toBe(seen);
		expect(again).toMatchObject({ response: { version: 1 } });
		const saved = {
			id: colleague,
			kind: "RESPONDED",
			text: "A colleague's answer.",
			authorId: "user-other",
			version: 1,
			updatedAt: expect.any(Date),
		};

		// A tab still holding the first answer's id and version 1.
		expect(
			await upsertFindingResponse({
				...answer({ text: "An edit of the first answer." }),
				expectedResponseId: seen,
				expectedVersion: 1,
			}),
		).toEqual({ outcome: "stale", current: saved });
		expect(
			await clearFindingResponse({
				organizationId: ORG,
				documentId: DOC,
				stableKey: KEY,
				responseId: seen,
				version: 1,
			}),
		).toEqual({ outcome: "stale", current: saved });
		expect(store.responses).toEqual([
			expect.objectContaining({
				id: colleague,
				text: "A colleague's answer.",
				authorId: "user-other",
				version: 1,
			}),
		]);
	});

	it.each([
		["a version without the answer's id", { expectedVersion: 1 }],
		[
			"an answer's id without its version",
			{ expectedResponseId: "response-1" },
		],
	])("refuses %s before reading anything", async (_label, expectation) => {
		await expect(
			upsertFindingResponse({
				...answer(),
				...expectation,
			} as unknown as UpsertFindingResponseInput),
		).rejects.toBeInstanceOf(TypeError);
		expect(fake.projectDocument.findFirst).not.toHaveBeenCalled();
		expect(fake.$transaction).not.toHaveBeenCalled();
	});

	it.each([
		["a RESPONDED answer with no text", { text: "   " }, "textRequired"],
		[
			"text over the cap",
			{ text: "t".repeat(PROPOSAL_FINDING_RESPONSE_TEXT_MAX_LENGTH + 1) },
			"textTooLong",
		],
		[
			"a kind the respond path never writes",
			{ kind: "RESOLVED" as never },
			"invalidKind",
		],
	])(
		"refuses %s before reading anything",
		async (_label, overrides, code) => {
			await expect(
				upsertFindingResponse(answer(overrides)),
			).rejects.toThrow(expect.objectContaining({ code }));
			await expect(
				upsertFindingResponse(answer(overrides)),
			).rejects.toBeInstanceOf(FindingResponseValidationError);
			expect(fake.projectDocument.findFirst).not.toHaveBeenCalled();
			expect(store.responses).toHaveLength(0);
		},
	);

	it("trims the text, accepts exactly the cap, and stores a bare confirmation's text as null", async () => {
		const long = "t".repeat(PROPOSAL_FINDING_RESPONSE_TEXT_MAX_LENGTH);
		expect(
			await upsertFindingResponse(answer({ text: `  ${long}  ` })),
		).toMatchObject({ outcome: "written", response: { text: long } });
		expect(
			await upsertFindingResponse(
				answer({
					stableKey: "gap|doc|timeline",
					kind: "CONFIRMED",
					text: "  ",
				}),
			),
		).toMatchObject({ outcome: "written", response: { text: null } });
	});

	it.each([
		["another organization", { organizationId: OTHER_ORG }],
		["another project", { projectId: "project-elsewhere" }],
	])(
		"refuses a document of %s and writes nothing",
		async (_label, overrides) => {
			await expect(
				upsertFindingResponse(answer(overrides)),
			).rejects.toBeInstanceOf(ProposalArtifactTenantError);
			expect(store.responses).toHaveLength(0);
		},
	);

	it("refuses an answered run of another document and writes nothing", async () => {
		const foreign = seedRun({ documentId: "doc-other" });
		await expect(
			upsertFindingResponse(
				answer({ answeredRunId: foreign.id as string }),
			),
		).rejects.toBeInstanceOf(ProposalArtifactTenantError);
		expect(store.responses).toHaveLength(0);
	});

	it("lists the document's answers oldest first, never another document's or organization's", async () => {
		await upsertFindingResponse(answer({ stableKey: "a" }));
		await upsertFindingResponse(answer({ stableKey: "b" }));
		store.responses.push({
			id: "response-elsewhere",
			organizationId: ORG,
			projectId: PROJECT,
			documentId: "doc-other",
			stableKey: "c",
			createdAt: NOW,
		});

		const listed = await listResponsesForDocument({
			organizationId: ORG,
			documentId: DOC,
		});
		expect(listed.map((r) => r.stableKey)).toEqual(["a", "b"]);
		expect(listed[0]).not.toHaveProperty("organizationId");
		expect(
			await listResponsesForDocument({
				organizationId: OTHER_ORG,
				documentId: DOC,
			}),
		).toEqual([]);
	});

	it("after the project moves to another organization, its earlier answers and runs are unreachable", async () => {
		const id = writtenId(await upsertFindingResponse(answer()));
		store.projects.set(PROJECT, { organizationId: OTHER_ORG });

		expect(
			await listResponsesForDocument({
				organizationId: OTHER_ORG,
				documentId: DOC,
			}),
		).toEqual([]);
		await expect(
			upsertFindingResponse({
				...answer({ organizationId: OTHER_ORG }),
				expectedResponseId: id,
				expectedVersion: 1,
			}),
		).rejects.toBeInstanceOf(ProposalArtifactTenantError);
		expect(
			(
				await getAnalysisForCurrentContent({
					organizationId: OTHER_ORG,
					documentId: DOC,
					currentProseHash: proseHashOf(MAIN),
					computeProseHash: proseHashOf,
				})
			).run,
		).toBeNull();
	});

	it("clearing removes the answer at the version read, even when no run raises its key any more", async () => {
		const id = writtenId(await upsertFindingResponse(answer()));
		store.analyses = [];
		store.findings = [];

		expect(
			await clearFindingResponse({
				organizationId: ORG,
				documentId: DOC,
				stableKey: KEY,
				responseId: id,
				version: 1,
			}),
		).toEqual({ outcome: "cleared", kind: "RESPONDED" });
		expect(store.responses).toHaveLength(0);
	});

	it("clearing with an old version is stale with the saved answer; a missing key or another organization is not_found", async () => {
		const id = writtenId(await upsertFindingResponse(answer()));
		await upsertFindingResponse({
			...answer({ text: "Edited." }),
			expectedResponseId: id,
			expectedVersion: 1,
		});

		expect(
			await clearFindingResponse({
				organizationId: ORG,
				documentId: DOC,
				stableKey: KEY,
				responseId: id,
				version: 1,
			}),
		).toEqual({
			outcome: "stale",
			current: {
				id,
				kind: "RESPONDED",
				text: "Edited.",
				authorId: "user-example",
				version: 2,
				updatedAt: expect.any(Date),
			},
		});
		expect(
			await clearFindingResponse({
				organizationId: ORG,
				documentId: DOC,
				stableKey: "missing",
				responseId: id,
				version: 1,
			}),
		).toEqual({ outcome: "not_found" });
		expect(
			await clearFindingResponse({
				organizationId: OTHER_ORG,
				documentId: DOC,
				stableKey: KEY,
				responseId: id,
				version: 2,
			}),
		).toEqual({ outcome: "not_found" });
		expect(store.responses).toHaveLength(1);
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

describe("the tenant client never hands analysis, answer or style rows to a project guest", () => {
	const TABLES = [
		"ProjectDocumentAnalysis",
		"ProjectDocumentFinding",
		"ProjectDocumentFindingResponse",
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
