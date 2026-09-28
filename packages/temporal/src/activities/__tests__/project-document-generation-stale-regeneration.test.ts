/**
 * A regeneration must not write stale slot-preserving content over a newer
 * document (Fizzy #2589, KTD17).
 *
 * `generateDocumentWithAgent` splices the slots of `currentDocument` — the
 * body the run started from — into the generated body. If a person adds,
 * deletes or moves a slot while the run generates, writing that body restores
 * the old slot layout over their newer document. So, only when a slot is
 * involved:
 *
 *  - the generation activity binds a baseline: it reads the stored document
 *    and, if it still holds exactly `currentDocument`, returns its version as
 *    `baselineVersion`; if not, the document already moved and the run is
 *    abandoned as stale right there;
 *  - `saveProjectDocument` given that baseline writes the content AND the
 *    pre-regeneration snapshot in one transaction, conditional on the version
 *    still being the baseline; on conflict nothing is written and the run is
 *    abandoned with a non-retryable failure;
 *  - `createDocumentVersion` given the same baseline creates the version row
 *    and advances the document's version in one transaction, and only while
 *    the regenerated body is still the live one at the baseline. A write that
 *    landed after the save leaves no row and no bump, and the run is abandoned
 *    the same way. A retry of an attempt that already committed succeeds
 *    without a second row.
 *
 * With no slot on either side, no activity changes at all: no extra read, no
 * baseline, and the save and the version step issue exactly the queries they
 * always have.
 *
 * Mocks mirror the sibling `project-document-generation-visual-slots.test.ts`,
 * except that `ApplicationFailure` is the real class, so non-retryability and
 * the failure type are asserted rather than assumed.
 */

import { ApplicationFailure } from "@temporalio/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const tx = {
		projectDocument: {
			findUnique: vi.fn(),
			updateMany: vi.fn(),
		},
		documentVersion: {
			findFirst: vi.fn(),
			create: vi.fn(),
		},
	};
	return {
		runsStream: vi.fn(),
		hasProjectAccess: vi.fn(),
		projectFindUnique: vi.fn(),
		fetchAndRenderPrompt: vi.fn(),
		projectDocument: {
			findUnique: vi.fn(),
			update: vi.fn(),
			updateMany: vi.fn(),
		},
		documentVersion: {
			findFirst: vi.fn(),
			create: vi.fn(),
		},
		tx,
		transaction: vi.fn(async (fn: (client: typeof tx) => unknown) =>
			fn(tx),
		),
	};
});

vi.mock("@langchain/langgraph-sdk", () => ({
	Client: class {
		assistants = { getSchemas: vi.fn().mockResolvedValue({}) };
		runs = {
			stream: (...args: unknown[]) => mocks.runsStream(...args),
		};
	},
}));

vi.mock("@repo/database", () => ({
	db: {
		project: {
			findUnique: (...args: unknown[]) =>
				mocks.projectFindUnique(...args),
		},
		projectDocument: mocks.projectDocument,
		documentVersion: mocks.documentVersion,
		$transaction: mocks.transaction,
	},
	hasProjectAccess: (...args: unknown[]) => mocks.hasProjectAccess(...args),
	recordAuditDurable: vi.fn(),
	listEmbeddedDocumentsForSweep: vi.fn().mockResolvedValue([]),
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
	getAIModelWithMetadata: vi.fn().mockResolvedValue({
		model: {},
		metadata: { modelString: "example-model", provider: "openai" },
		trackUsage: vi.fn(),
	}),
	logModelUsageAsync: vi.fn(),
	streamText: vi.fn(),
}));

vi.mock("@repo/ai/skills", () => ({
	isTextContentType: vi.fn(),
	loadSkillBundle: vi.fn(),
	readSkillFile: vi.fn(),
}));

vi.mock("../prompt-activities", () => ({
	fetchAndRenderPrompt: (...args: unknown[]) =>
		mocks.fetchAndRenderPrompt(...args),
	renderPromptWithContext: vi.fn(),
}));

vi.mock("@temporalio/activity", async () => {
	const temporalCommon = await import("@temporalio/common");
	return {
		Context: { current: { heartbeat: vi.fn() } },
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

// Import AFTER mocks
import { normalizeQuoteArtifacts } from "@repo/utils/quote-artifacts";
import {
	createDocumentVersion,
	generateDocumentWithAgent,
	repairMalformedMermaidFences,
	saveProjectDocument,
} from "../project-document-generation";

const SLOT =
	'<visual-slot data-slot-id="slot-a" data-kind="timeline" data-hint="Phase dates"></visual-slot>';

/** A stored Proposal with one slot in its phases. */
const SLOTTED = `# Proposal

## Implementation Phases

Phase one covers discovery.

${SLOT}

Phase two covers delivery.
`;

/** The same Proposal without a slot. */
const SLOT_FREE = `# Proposal

## Implementation Phases

Phase one covers discovery.

Phase two covers delivery.
`;

/** SLOTTED after a person moved its slot below the second phase. */
const SLOT_MOVED = `# Proposal

## Implementation Phases

Phase one covers discovery.

Phase two covers delivery.

${SLOT}
`;

const SLOTTED_WORDS = SLOTTED.split(/\s+/).filter(Boolean).length;

/** What the agent returns: rewritten prose, no slot. */
const REGENERATED = `# Proposal

## Implementation Phases

Phase one covers discovery and design.

Phase two covers delivery.
`;

const STALE_FAILURE_TYPE = "DOCUMENT_GENERATION_STALE";
const STALE_PATTERN = /changed while it was being regenerated/;

function agentReturns(document: string) {
	mocks.runsStream.mockImplementation(() =>
		(async function* () {
			yield { event: "metadata", data: {} };
			yield { event: "values", data: { document } };
		})(),
	);
}

function generate(currentDocument?: string) {
	return generateDocumentWithAgent({
		projectId: "project-1",
		documentId: "doc-1",
		documentType: "PROPOSAL",
		prompt: "",
		contexts: [],
		userId: "user-1",
		organizationId: "org-1",
		aiToken: "token-1",
		currentDocument,
	});
}

/** The regenerated slotted body, saved against `baselineVersion`. */
function saveAgainst(baselineVersion: number) {
	return saveProjectDocument("doc-1", SLOTTED, "user-1", { baselineVersion });
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => {
			throw new Error("expected a failure");
		},
		(error: unknown) => error,
	);
}

function expectStaleFailure(error: unknown) {
	expect(error).toBeInstanceOf(ApplicationFailure);
	const failure = error as ApplicationFailure;
	expect(failure.type).toBe(STALE_FAILURE_TYPE);
	// No retry loop: a moved document stays moved.
	expect(failure.nonRetryable).toBe(true);
	// Written for the person who opens the document — it becomes the row's
	// `generationError` through the workflow's existing failure path.
	expect(failure.message).toMatch(STALE_PATTERN);
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.projectFindUnique.mockResolvedValue({
		name: "Example project",
		description: "An example.",
		goals: null,
		techStack: [],
		features: [],
		projectTypes: [],
		qaStrategyLevel: null,
	});
	mocks.fetchAndRenderPrompt.mockResolvedValue(null);
	mocks.documentVersion.findFirst.mockResolvedValue(null);
	mocks.documentVersion.create.mockResolvedValue({});
	mocks.projectDocument.update.mockResolvedValue({});
	mocks.tx.documentVersion.findFirst.mockResolvedValue(null);
	mocks.tx.documentVersion.create.mockResolvedValue({});
	mocks.tx.projectDocument.updateMany.mockResolvedValue({ count: 1 });
});

describe("generateDocumentWithAgent — the regeneration baseline", () => {
	it("reads nothing and reports no baseline when no slot is involved", async () => {
		agentReturns(REGENERATED);

		const result = await generate(SLOT_FREE);

		expect(result).not.toHaveProperty("baselineVersion");
		expect(mocks.projectDocument.findUnique).not.toHaveBeenCalled();
	});

	it("reports the stored version when the document still holds the body its slots were lifted from", async () => {
		agentReturns(REGENERATED);
		mocks.projectDocument.findUnique.mockResolvedValue({
			content: SLOTTED,
			version: 4,
		});

		const result = await generate(SLOTTED);

		expect(result.baselineVersion).toBe(4);
		expect(result.content).toContain(SLOT);
		expect(mocks.projectDocument.findUnique).toHaveBeenCalledWith({
			where: { id: "doc-1" },
			select: { content: true, version: true },
		});
	});

	it("also binds a baseline when only the generated body holds a slot", async () => {
		// The agent invented a slot; the splice strips it, but the write is
		// guarded all the same (the rule the v1 API route applies too).
		agentReturns(`${REGENERATED}\n${SLOT}\n`);
		mocks.projectDocument.findUnique.mockResolvedValue({
			content: SLOT_FREE,
			version: 2,
		});

		const result = await generate(SLOT_FREE);

		expect(result.baselineVersion).toBe(2);
		expect(result.content).not.toContain("<visual-slot");
	});

	it("takes the read itself as the baseline when the run lifted nothing", async () => {
		// Batch and setup runs pass no `currentDocument`: there is no body to
		// bind, so a stored body that differs is not evidence of a move.
		agentReturns(`${REGENERATED}\n${SLOT}\n`);
		mocks.projectDocument.findUnique.mockResolvedValue({
			content: "# Proposal\n\nWhatever the row already held.\n",
			version: 9,
		});

		const result = await generate(undefined);

		expect(result.baselineVersion).toBe(9);
	});

	it("abandons the run as stale when the document moved during generation", async () => {
		agentReturns(REGENERATED);
		// A person moved the slot while the model was writing.
		mocks.projectDocument.findUnique.mockResolvedValue({
			content: SLOT_MOVED,
			version: 5,
		});

		expectStaleFailure(await failureOf(generate(SLOTTED)));
	});
});

describe("saveProjectDocument — slot-free save is unchanged", () => {
	it("issues exactly today's queries: read, snapshot, unconditional update", async () => {
		mocks.projectDocument.findUnique.mockResolvedValue({
			status: "GENERATING",
			content: "# Old",
			version: 3,
		});

		await saveProjectDocument("doc-1", "# New", "user-1");

		expect(mocks.projectDocument.findUnique).toHaveBeenCalledWith({
			where: { id: "doc-1" },
			select: { status: true, content: true, version: true },
		});
		expect(mocks.documentVersion.findFirst).toHaveBeenCalledWith({
			where: { documentId: "doc-1", version: 3 },
		});
		expect(mocks.documentVersion.create).toHaveBeenCalledWith({
			data: {
				documentId: "doc-1",
				version: 3,
				content: "# Old",
				changeDescription: "Pre-regeneration snapshot (auto)",
				changedBy: "user-1",
			},
		});
		expect(mocks.projectDocument.update).toHaveBeenCalledTimes(1);
		expect(mocks.projectDocument.update).toHaveBeenCalledWith({
			where: { id: "doc-1" },
			data: {
				content: "# New",
				wordCount: 2,
				status: "COMPLETE",
				updatedAt: expect.any(Date),
			},
		});
		expect(mocks.transaction).not.toHaveBeenCalled();
		expect(mocks.projectDocument.updateMany).not.toHaveBeenCalled();
	});
});

describe("saveProjectDocument — guarded by the generation baseline", () => {
	it("writes the snapshot and the content in one transaction, conditional on the baseline", async () => {
		mocks.tx.projectDocument.findUnique.mockResolvedValue({
			status: "GENERATING",
			content: SLOTTED,
			version: 3,
		});

		await saveAgainst(3);

		expect(mocks.transaction).toHaveBeenCalledTimes(1);
		expect(mocks.tx.documentVersion.create).toHaveBeenCalledWith({
			data: {
				documentId: "doc-1",
				version: 3,
				content: SLOTTED,
				changeDescription: "Pre-regeneration snapshot (auto)",
				changedBy: "user-1",
			},
		});
		expect(mocks.tx.projectDocument.updateMany).toHaveBeenCalledWith({
			where: { id: "doc-1", version: 3 },
			data: {
				content: SLOTTED,
				wordCount: SLOTTED_WORDS,
				status: "COMPLETE",
				updatedAt: expect.any(Date),
			},
		});
		// Nothing through the unguarded client.
		expect(mocks.projectDocument.update).not.toHaveBeenCalled();
		expect(mocks.documentVersion.create).not.toHaveBeenCalled();
	});

	it("writes nothing and abandons the run when the version moved past the baseline", async () => {
		mocks.tx.projectDocument.findUnique.mockResolvedValue({
			status: "GENERATING",
			content: `${SLOTTED}\nA person's newer paragraph.\n`,
			version: 4,
		});

		expectStaleFailure(await failureOf(saveAgainst(3)));

		expect(mocks.tx.documentVersion.create).not.toHaveBeenCalled();
		expect(mocks.tx.projectDocument.updateMany).not.toHaveBeenCalled();
		expect(mocks.projectDocument.update).not.toHaveBeenCalled();
		expect(mocks.documentVersion.create).not.toHaveBeenCalled();
	});

	it("rolls the snapshot back when a write lands between the read and the update", async () => {
		mocks.tx.projectDocument.findUnique
			.mockResolvedValueOnce({
				status: "GENERATING",
				content: SLOTTED,
				version: 3,
			})
			.mockResolvedValueOnce({ version: 4 });
		mocks.tx.projectDocument.updateMany.mockResolvedValue({ count: 0 });

		expectStaleFailure(await failureOf(saveAgainst(3)));

		// The snapshot was written inside the transaction, and the transaction
		// callback rejected — so the database rolls it back with the update.
		expect(mocks.tx.documentVersion.create).toHaveBeenCalledTimes(1);
		const transactionOutcome = mocks.transaction.mock.results[0]?.value;
		await expect(transactionOutcome).rejects.toThrow(STALE_PATTERN);
		expect(mocks.projectDocument.update).not.toHaveBeenCalled();
		expect(mocks.documentVersion.create).not.toHaveBeenCalled();
	});
});

describe("createDocumentVersion — slot-free version step is unchanged", () => {
	it("issues exactly today's queries: history maximum, row, unconditional version bump", async () => {
		mocks.documentVersion.findFirst.mockResolvedValue({ version: 3 });

		await createDocumentVersion("doc-1", "# New", "user-1", "prompt-v1");

		expect(mocks.documentVersion.findFirst).toHaveBeenCalledTimes(1);
		expect(mocks.documentVersion.findFirst).toHaveBeenCalledWith({
			where: { documentId: "doc-1" },
			orderBy: { version: "desc" },
			select: { version: true },
		});
		expect(mocks.documentVersion.create).toHaveBeenCalledWith({
			data: {
				documentId: "doc-1",
				content: "# New",
				version: 4,
				changeDescription: "Regenerated version",
				changedBy: "user-1",
				promptVersionId: "prompt-v1",
			},
		});
		expect(mocks.projectDocument.update).toHaveBeenCalledTimes(1);
		expect(mocks.projectDocument.update).toHaveBeenCalledWith({
			where: { id: "doc-1" },
			data: { version: 4 },
		});
		// No read of the live document, no transaction, no conditional write.
		expect(mocks.projectDocument.findUnique).not.toHaveBeenCalled();
		expect(mocks.transaction).not.toHaveBeenCalled();
		expect(mocks.projectDocument.updateMany).not.toHaveBeenCalled();
	});
});

// -----------------------------------------------------------------------------
// The version step of a guarded regeneration, against an in-memory document
// -----------------------------------------------------------------------------

type VersionRow = {
	version: number;
	content: string;
	changeDescription: string | null;
	changedBy: string | null;
	promptVersionId: string | null;
};

/**
 * One document and its version history behind the transaction client.
 * `$transaction` restores both when its callback throws, as Postgres rolls
 * back, so "nothing written" is asserted on state rather than on calls.
 */
type DocumentState = {
	document: { content: string; version: number };
	versions: VersionRow[];
};

type DocumentStore = DocumentState & {
	/**
	 * A writer that commits, in its own transaction, between this
	 * transaction's read and its update: a rollback here does not undo it.
	 */
	beforeConditionalUpdate?: (state: DocumentState) => void;
};

const VERSION_FILTER_KEYS = new Set([
	"documentId",
	"version",
	"content",
	"changeDescription",
	"changedBy",
	"promptVersionId",
]);

function versionRowMatches(row: VersionRow, where: Record<string, unknown>) {
	return Object.entries(where).every(([key, condition]) => {
		if (!VERSION_FILTER_KEYS.has(key)) {
			throw new Error(`The fake store does not filter on ${key}`);
		}
		if (key === "documentId") {
			return condition === "doc-1";
		}
		const value = row[key as keyof VersionRow];
		if (condition !== null && typeof condition === "object") {
			const {
				gte,
				lte,
				in: oneOf,
				...unsupported
			} = condition as {
				gte?: number;
				lte?: number;
				in?: unknown[];
			};
			if (Object.keys(unsupported).length > 0) {
				throw new Error(
					`The fake store cannot apply that filter to ${key}`,
				);
			}
			return (
				(gte === undefined || (value as number) >= gte) &&
				(lte === undefined || (value as number) <= lte) &&
				(oneOf === undefined || oneOf.includes(value))
			);
		}
		return value === condition;
	});
}

function installStore(store: DocumentStore): DocumentStore {
	let rollbackTo: DocumentState | undefined;
	mocks.transaction.mockImplementation(
		async (fn: (client: typeof mocks.tx) => unknown) => {
			rollbackTo = structuredClone({
				document: store.document,
				versions: store.versions,
			});
			try {
				return await fn(mocks.tx);
			} catch (error) {
				store.document = rollbackTo.document;
				store.versions = rollbackTo.versions;
				throw error;
			} finally {
				rollbackTo = undefined;
			}
		},
	);
	mocks.tx.projectDocument.findUnique.mockImplementation(async () => ({
		...store.document,
	}));
	mocks.tx.projectDocument.updateMany.mockImplementation(
		async ({
			where,
			data,
		}: {
			where: { id: string; version?: number; content?: string };
			data: Partial<DocumentStore["document"]>;
		}) => {
			const concurrentWriter = store.beforeConditionalUpdate;
			store.beforeConditionalUpdate = undefined;
			if (concurrentWriter) {
				concurrentWriter(store);
				if (rollbackTo) {
					concurrentWriter(rollbackTo);
				}
			}
			const matches =
				where.id === "doc-1" &&
				(where.version === undefined ||
					where.version === store.document.version) &&
				(where.content === undefined ||
					where.content === store.document.content);
			if (!matches) {
				return { count: 0 };
			}
			store.document = { ...store.document, ...data };
			return { count: 1 };
		},
	);
	mocks.tx.documentVersion.findFirst.mockImplementation(
		async ({
			where,
			orderBy,
		}: {
			where: Record<string, unknown>;
			orderBy?: { version: "asc" | "desc" };
		}) => {
			const rows = store.versions.filter((row) =>
				versionRowMatches(row, where),
			);
			if (orderBy?.version === "desc") {
				rows.sort((a, b) => b.version - a.version);
			}
			return rows[0] ?? null;
		},
	);
	mocks.tx.documentVersion.create.mockImplementation(
		async ({ data }: { data: VersionRow & { documentId: string } }) => {
			store.versions.push({
				version: data.version,
				content: data.content,
				changeDescription: data.changeDescription ?? null,
				changedBy: data.changedBy ?? null,
				promptVersionId: data.promptVersionId ?? null,
			});
			return data;
		},
	);
	return store;
}

/** What `saveProjectDocument` writes for the string the workflow hands it. */
function asSaved(raw: string): string {
	return normalizeQuoteArtifacts(repairMalformedMermaidFences(raw));
}

const PERSON_EDIT = `${SLOTTED}\nA person's newer paragraph.\n`;

/**
 * A generated body with an unclosed mermaid fence: the save repairs it before
 * writing, so the live body and the string the workflow hands the version
 * step differ.
 */
const UNCLOSED_FENCE = `# Proposal\n\n\`\`\`mermaid\ngraph TD\n  A --> B\n\n## Implementation Phases\n\n${SLOT}\n`;

/**
 * The document right after a guarded save at baseline 3: the regenerated
 * body is live, the version is still 3, and the pre-regeneration snapshot
 * holds the body it replaced.
 */
function afterGuardedSave(generated: string = SLOTTED): DocumentStore {
	return {
		document: { content: asSaved(generated), version: 3 },
		versions: [
			{
				version: 1,
				content: "# Proposal\n",
				changeDescription: "Initial version",
				changedBy: "user-1",
				promptVersionId: null,
			},
			{
				version: 2,
				content: "# Proposal\n\nA draft.\n",
				changeDescription: null,
				changedBy: "user-2",
				promptVersionId: null,
			},
			{
				version: 3,
				content: SLOT_FREE,
				changeDescription: "Pre-regeneration snapshot (auto)",
				changedBy: "user-1",
				promptVersionId: null,
			},
		],
	};
}

/** The version step of the run that generated `generated` at `baselineVersion`. */
function versionAgainst(baselineVersion: number, generated: string = SLOTTED) {
	return createDocumentVersion("doc-1", generated, "user-1", "prompt-v1", {
		baselineVersion,
	});
}

function expectNoUnguardedWrites() {
	expect(mocks.documentVersion.findFirst).not.toHaveBeenCalled();
	expect(mocks.documentVersion.create).not.toHaveBeenCalled();
	expect(mocks.projectDocument.update).not.toHaveBeenCalled();
}

describe("createDocumentVersion — guarded by the regeneration baseline", () => {
	it("creates the row and advances the version in one transaction while the regenerated body is live", async () => {
		const store = installStore(afterGuardedSave());

		await versionAgainst(3);

		expect(mocks.transaction).toHaveBeenCalledTimes(1);
		expect(store.document).toEqual({ content: SLOTTED, version: 4 });
		expect(store.versions).toHaveLength(4);
		expect(store.versions.at(-1)).toEqual({
			version: 4,
			content: SLOTTED,
			changeDescription: "Regenerated version",
			changedBy: "user-1",
			promptVersionId: "prompt-v1",
		});
		// The advance is conditional on exactly what was checked.
		expect(mocks.tx.projectDocument.updateMany).toHaveBeenCalledWith({
			where: { id: "doc-1", version: 3, content: SLOTTED },
			data: { version: 4 },
		});
		expectNoUnguardedWrites();
	});

	it("numbers the row from the history maximum, as the unguarded step does", async () => {
		const store = afterGuardedSave();
		// A row above the live version, left by an older non-atomic version
		// step whose bump never landed.
		store.versions.push({
			version: 5,
			content: "# Proposal\n\nAn orphaned regeneration.\n",
			changeDescription: "Regenerated version",
			changedBy: "user-1",
			promptVersionId: "prompt-v1",
		});
		installStore(store);

		await versionAgainst(3);

		expect(store.document.version).toBe(6);
		expect(store.versions.at(-1)?.version).toBe(6);
	});

	it("compares the live body with what the save wrote, and versions that body, not the raw generated string", async () => {
		const store = installStore(afterGuardedSave(UNCLOSED_FENCE));

		await versionAgainst(3, UNCLOSED_FENCE);

		expect(store.document).toEqual({
			content: asSaved(UNCLOSED_FENCE),
			version: 4,
		});
		// Restoring this row gives back the repaired body the document shows,
		// not the malformed fence the save fixed.
		expect(store.versions.at(-1)?.content).toBe(asSaved(UNCLOSED_FENCE));
	});

	it("writes nothing and abandons the run when a person's save moved the document after the regenerated body was saved", async () => {
		const store = afterGuardedSave();
		// The editor's save found the pre-regeneration snapshot already at 3,
		// so it wrote no row of its own: only content and version moved.
		store.document = { content: PERSON_EDIT, version: 4 };
		installStore(store);
		const before = structuredClone(store.versions);

		expectStaleFailure(await failureOf(versionAgainst(3)));

		expect(store.document).toEqual({ content: PERSON_EDIT, version: 4 });
		expect(store.versions).toEqual(before);
		expect(mocks.tx.documentVersion.create).not.toHaveBeenCalled();
		expect(mocks.tx.projectDocument.updateMany).not.toHaveBeenCalled();
		expectNoUnguardedWrites();
	});

	it("writes nothing when the regenerated body was reverted without a version bump", async () => {
		// Keeping the old content after a regeneration reverts the body but
		// leaves the version (`skipVersionBump`): the version alone still
		// matches, the content does not.
		const store = afterGuardedSave();
		store.document = { content: SLOT_FREE, version: 3 };
		installStore(store);
		const before = structuredClone(store.versions);

		expectStaleFailure(await failureOf(versionAgainst(3)));

		expect(store.document).toEqual({ content: SLOT_FREE, version: 3 });
		expect(store.versions).toEqual(before);
		expectNoUnguardedWrites();
	});

	it("rolls the row back when a writer commits between the check and the conditional update", async () => {
		const store = installStore(afterGuardedSave());
		const before = structuredClone(store.versions);
		store.beforeConditionalUpdate = (state) => {
			state.document = { content: PERSON_EDIT, version: 4 };
		};

		expectStaleFailure(await failureOf(versionAgainst(3)));

		// The row was created inside the transaction and rolled back with it.
		expect(mocks.tx.documentVersion.create).toHaveBeenCalledTimes(1);
		expect(store.versions).toEqual(before);
		// The writer's document stands: not re-labelled with the stale body's
		// version number.
		expect(store.document).toEqual({ content: PERSON_EDIT, version: 4 });
		const transactionOutcome = mocks.transaction.mock.results[0]?.value;
		await expect(transactionOutcome).rejects.toThrow(STALE_PATTERN);
		expectNoUnguardedWrites();
	});
});

describe("createDocumentVersion — a retry after a committed attempt", () => {
	it("succeeds without a second row when the earlier attempt committed and its result was lost", async () => {
		const store = installStore(afterGuardedSave());
		await versionAgainst(3);
		const committed = structuredClone({
			document: store.document,
			versions: store.versions,
		});

		await expect(versionAgainst(3)).resolves.toBeUndefined();

		expect(store.document).toEqual(committed.document);
		expect(store.versions).toEqual(committed.versions);
		expect(store.versions.filter((row) => row.version === 4)).toHaveLength(
			1,
		);
	});

	it("recognizes its committed row when the save repaired the generated body", async () => {
		expect(asSaved(UNCLOSED_FENCE)).not.toBe(UNCLOSED_FENCE);
		const store = installStore(afterGuardedSave(UNCLOSED_FENCE));
		await versionAgainst(3, UNCLOSED_FENCE);
		const committed = structuredClone({
			document: store.document,
			versions: store.versions,
		});

		await expect(
			versionAgainst(3, UNCLOSED_FENCE),
		).resolves.toBeUndefined();

		expect(store.document).toEqual(committed.document);
		expect(store.versions).toEqual(committed.versions);
	});

	it("still succeeds when a person saved over the committed version before the retry", async () => {
		const store = installStore(afterGuardedSave());
		await versionAgainst(3);
		expect(store.document).toEqual({ content: SLOTTED, version: 4 });
		// Their save found this run's row already at 4 and wrote none.
		store.document = { content: PERSON_EDIT, version: 5 };
		const versionsBefore = structuredClone(store.versions);

		await expect(versionAgainst(3)).resolves.toBeUndefined();

		expect(store.document).toEqual({ content: PERSON_EDIT, version: 5 });
		expect(store.versions).toEqual(versionsBefore);
	});

	it("succeeds without a second row when the first row took the baseline's own number", async () => {
		// A first generation into an empty document: no snapshot, no history,
		// so the row is version 1 and the version stays 1.
		const store = installStore({
			document: { content: SLOTTED, version: 1 },
			versions: [],
		});
		await versionAgainst(1);
		expect(store.versions).toEqual([
			{
				version: 1,
				content: SLOTTED,
				changeDescription: "Initial version",
				changedBy: "user-1",
				promptVersionId: "prompt-v1",
			},
		]);

		await expect(versionAgainst(1)).resolves.toBeUndefined();

		expect(store.versions).toHaveLength(1);
		expect(store.document).toEqual({ content: SLOTTED, version: 1 });
	});
});
