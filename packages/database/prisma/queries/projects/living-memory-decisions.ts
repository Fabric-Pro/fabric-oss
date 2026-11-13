/**
 * Living Memory decision candidates: the decisions an AI found in synced
 * knowledge files (`ProjectContextDecisionExtraction`), offered in the
 * Decisions tab beside the meeting candidates.
 *
 * Only a file's CURRENT version is offered: the extraction whose
 * `contentHash` equals the context's own. An older version's decisions were
 * superseded by the edit that replaced it, and offering both would ask a
 * reviewer to judge the same file twice.
 *
 * A candidate is keyed `contextId:contentHash:index`. The create flow stores
 * that key's parts in the new decision's `sourceMetadata`, which is how a
 * converted candidate stops being offered; a dismissed one is recorded in the
 * extraction's `dismissedIndexes`.
 *
 * A settled decision stays settled across edits: every edit to the file is a
 * new extraction with new keys, so a decision whose text (compared trimmed,
 * whitespace-collapsed and lowercased) was already converted or dismissed in
 * any version of the same file is not offered again. The "candidates ready"
 * notification applies that rule too ({@link openLivingMemoryDecisions} for
 * whether to announce, {@link summarizeOpenLivingMemoryDecisions} for what to
 * say), so the tab and the notification agree.
 *
 * A decision can name the project's feature or bug it came from
 * (`workItem`). It is offered, and copied onto the created decision, only
 * while the project still has that work item.
 */

import { type ArchitectureDecisionStatus, db, Prisma } from "../../client";
import { advisoryObjectKey } from "../lib/refresh-lock-key";
import {
	type ArchitectureDecisionDetail,
	type CreateArchitectureDecisionInput,
	createArchitectureDecisionWhen,
	isSimilarDecision,
} from "./architecture-decisions";

const LIVING_MEMORY_CANDIDATE_ADVISORY_CLASS = 0x4c4d4463; // "LMDc"

/** `ArchitectureDecision.sourceKind` of a decision created from a candidate. */
export const LIVING_MEMORY_DECISION_SOURCE_KIND = "living_memory";

/**
 * The decisions an update can replace. Accepting an update marks its target
 * superseded only from one of these, so only these are offered as a target.
 */
export const IN_FORCE_DECISION_STATUSES: readonly ArchitectureDecisionStatus[] =
	["ACCEPTED", "PROPOSED"];

/** The project's feature or bug a decision came from. */
export type LivingMemoryDecisionWorkItem = {
	id: string;
	identifier: string;
};

/**
 * One entry of `ProjectContextDecisionExtraction.decisions`. A type alias, not
 * an interface, so it stays assignable to Prisma's JSON input type.
 */
export type LivingMemoryDecision = {
	text: string;
	rationale?: string;
	sourceQuote?: string;
	workItem?: LivingMemoryDecisionWorkItem;
};

export interface LivingMemoryDecisionCandidate {
	extractionId: string;
	contextId: string;
	contentHash: string;
	sourcePath: string;
	extractedAt: Date;
	decisionIndex: number;
	text: string;
	rationale?: string;
	/** When it matches an existing decision, the one it most likely updates. */
	matchedDecision?: { id: string; identifier: string; title: string };
	/** The work item it came from, while the project still has it. */
	workItem?: LivingMemoryDecisionWorkItem;
}

/** A file whose current version met an extraction limit. */
export interface LivingMemoryLimitedFile {
	sourcePath: string;
	/** Only the first part of the file was read. */
	truncated: boolean;
	/** Only the first decisions the file listed were kept. */
	capped: boolean;
}

/** The fields of an extraction the open-candidate rule reads. */
export type LivingMemoryExtractionDecisions = {
	contextId: string;
	contentHash: string;
	decisions: Prisma.JsonValue;
	dismissedIndexes: number[];
};

/** One entry of an extraction that is still offered for review. */
export interface OpenLivingMemoryDecision {
	index: number;
	decision: LivingMemoryDecision;
}

/**
 * Read a stored `decisions` value back. Tolerant on purpose: the column is
 * JSON, so an entry without usable text is skipped rather than trusted, and
 * its position is kept so indexes stay stable.
 */
export function parseLivingMemoryDecisions(
	value: Prisma.JsonValue,
): Array<LivingMemoryDecision | null> {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.map((entry) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			return null;
		}
		const text = typeof entry.text === "string" ? entry.text.trim() : "";
		if (!text) {
			return null;
		}
		const workItem = parseWorkItem(entry.workItem);
		return {
			text,
			...(typeof entry.rationale === "string" && entry.rationale.trim()
				? { rationale: entry.rationale.trim() }
				: {}),
			...(typeof entry.sourceQuote === "string" &&
			entry.sourceQuote.trim()
				? { sourceQuote: entry.sourceQuote.trim() }
				: {}),
			...(workItem ? { workItem } : {}),
		};
	});
}

function parseWorkItem(
	value: Prisma.JsonValue | undefined,
): LivingMemoryDecisionWorkItem | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	return typeof value.id === "string" &&
		value.id &&
		typeof value.identifier === "string" &&
		value.identifier
		? { id: value.id, identifier: value.identifier }
		: null;
}

/**
 * Of the given work item ids, the ones the project still has, with their
 * current identifiers. A work item deleted since the file was read is not
 * linked.
 */
async function existingWorkItems(
	projectId: string,
	ids: string[],
): Promise<Map<string, string>> {
	if (ids.length === 0) {
		return new Map();
	}
	const rows = await db.userStory.findMany({
		where: { projectId, id: { in: [...new Set(ids)] } },
		select: { id: true, identifier: true },
	});
	return new Map(rows.map((row) => [row.id, row.identifier]));
}

/** The decision's work item, as `existing` still has it. */
function linkedWorkItem(
	decision: LivingMemoryDecision,
	existing: Map<string, string>,
): { workItem: LivingMemoryDecisionWorkItem } | null {
	const id = decision.workItem?.id;
	const identifier = id ? existing.get(id) : undefined;
	return id && identifier ? { workItem: { id, identifier } } : null;
}

/** How two versions of a file are compared for "the same decision". */
export function normalizeLivingMemoryDecisionText(text: string): string {
	return text.trim().replace(/\s+/g, " ").toLowerCase();
}

function candidateKey(
	contextId: string,
	contentHash: string,
	index: number,
): string {
	return `${contextId}:${contentHash}:${index}`;
}

/** The candidate keys already turned into decisions in this project. */
async function convertedCandidateKeys(
	projectId: string,
	client: Prisma.TransactionClient = db,
): Promise<Set<string>> {
	const rows = await client.architectureDecision.findMany({
		where: {
			projectId,
			deletedAt: null,
			sourceKind: LIVING_MEMORY_DECISION_SOURCE_KIND,
		},
		select: { sourceMetadata: true },
	});
	const keys = new Set<string>();
	for (const row of rows) {
		const meta = row.sourceMetadata;
		if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
			continue;
		}
		const { contextId, contentHash, index } = meta;
		if (
			typeof contextId === "string" &&
			typeof contentHash === "string" &&
			typeof index === "number"
		) {
			keys.add(candidateKey(contextId, contentHash, index));
		}
	}
	return keys;
}

/**
 * Per context, the normalized text of every decision a reviewer already
 * settled in any of the given versions of that file: converted into a
 * decision or dismissed.
 */
function settledDecisionTexts(
	extractions: LivingMemoryExtractionDecisions[],
	converted: Set<string>,
): Map<string, Set<string>> {
	const settled = new Map<string, Set<string>>();
	for (const extraction of extractions) {
		const dismissed = new Set(extraction.dismissedIndexes);
		parseLivingMemoryDecisions(extraction.decisions).forEach(
			(decision, index) => {
				if (
					!decision ||
					(!dismissed.has(index) &&
						!converted.has(
							candidateKey(
								extraction.contextId,
								extraction.contentHash,
								index,
							),
						))
				) {
					return;
				}
				const texts =
					settled.get(extraction.contextId) ?? new Set<string>();
				texts.add(normalizeLivingMemoryDecisionText(decision.text));
				settled.set(extraction.contextId, texts);
			},
		);
	}
	return settled;
}

/**
 * The entries of `extraction` still open for review. Converted and dismissed
 * entries of this version are in `settled` too, so one text test covers them
 * and the same decision settled in an earlier version alike.
 */
function openDecisionsOf(
	extraction: LivingMemoryExtractionDecisions,
	settled: Map<string, Set<string>>,
): OpenLivingMemoryDecision[] {
	const done = settled.get(extraction.contextId);
	const open: OpenLivingMemoryDecision[] = [];
	parseLivingMemoryDecisions(extraction.decisions).forEach(
		(decision, index) => {
			if (
				decision &&
				!done?.has(normalizeLivingMemoryDecisionText(decision.text))
			) {
				open.push({ index, decision });
			}
		},
	);
	return open;
}

/**
 * The entries of one extraction still open for review, by the rule the
 * Decisions tab lists them with: whether its "candidates ready" notification
 * has anything to announce. Reads every version of the extraction's file,
 * because a decision settled in an earlier version is not offered again.
 */
export async function openLivingMemoryDecisions(
	extraction: LivingMemoryExtractionDecisions & { projectId: string },
): Promise<OpenLivingMemoryDecision[]> {
	const [versions, converted] = await Promise.all([
		db.projectContextDecisionExtraction.findMany({
			where: {
				projectId: extraction.projectId,
				contextId: extraction.contextId,
			},
			select: {
				contextId: true,
				contentHash: true,
				decisions: true,
				dismissedIndexes: true,
			},
		}),
		convertedCandidateKeys(extraction.projectId),
	]);
	return openDecisionsOf(
		extraction,
		settledDecisionTexts(versions, converted),
	);
}

/**
 * Each synced file's current extraction, newest first, with its entries that
 * were not converted or dismissed in any version of that file. The one rule
 * behind both the Decisions tab's list and the notification's total.
 */
async function openCurrentExtractions(input: {
	projectId: string;
	organizationId?: string | null;
}) {
	const [extractions, converted] = await Promise.all([
		db.projectContextDecisionExtraction.findMany({
			where: {
				projectId: input.projectId,
				organizationId: input.organizationId ?? null,
			},
			select: {
				id: true,
				contextId: true,
				contentHash: true,
				sourcePath: true,
				extractedAt: true,
				decisions: true,
				dismissedIndexes: true,
				context: { select: { contentHash: true } },
			},
			orderBy: { extractedAt: "desc" },
		}),
		convertedCandidateKeys(input.projectId),
	]);
	const settled = settledDecisionTexts(extractions, converted);
	return extractions
		.filter(
			(extraction) =>
				extraction.context.contentHash === extraction.contentHash,
		)
		.map((extraction) => ({
			extraction,
			open: openDecisionsOf(extraction, settled),
		}));
}

/**
 * What the Decisions tab offers for review right now: how many Living Memory
 * candidates, from how many files.
 */
export async function summarizeOpenLivingMemoryDecisions(input: {
	projectId: string;
	organizationId?: string | null;
}): Promise<{ candidateCount: number; fileCount: number }> {
	const files = (await openCurrentExtractions(input)).filter(
		({ open }) => open.length > 0,
	);
	return {
		candidateCount: files.reduce((sum, { open }) => sum + open.length, 0),
		fileCount: files.length,
	};
}

/**
 * The open Living Memory candidates for a project, newest first. A project
 * with no synced files has no extractions and gets an empty list.
 */
export async function listLivingMemoryDecisionCandidates(input: {
	projectId: string;
	organizationId?: string | null;
}): Promise<LivingMemoryDecisionCandidate[]> {
	const [current, existing] = await Promise.all([
		openCurrentExtractions(input),
		db.architectureDecision.findMany({
			where: {
				projectId: input.projectId,
				deletedAt: null,
				status: { in: [...IN_FORCE_DECISION_STATUSES] },
			},
			select: { id: true, identifier: true, title: true, decision: true },
		}),
	]);
	const workItems = await existingWorkItems(
		input.projectId,
		current.flatMap(({ open }) =>
			open.flatMap(({ decision }) =>
				decision.workItem ? [decision.workItem.id] : [],
			),
		),
	);

	const candidates: LivingMemoryDecisionCandidate[] = [];
	for (const { extraction, open } of current) {
		for (const { index, decision } of open) {
			const match = existing.find(
				(e) =>
					isSimilarDecision(decision.text, e.title) ||
					isSimilarDecision(decision.text, e.decision),
			);
			candidates.push({
				extractionId: extraction.id,
				contextId: extraction.contextId,
				contentHash: extraction.contentHash,
				sourcePath: extraction.sourcePath,
				extractedAt: extraction.extractedAt,
				decisionIndex: index,
				text: decision.text,
				...(decision.rationale
					? { rationale: decision.rationale }
					: {}),
				...(match
					? {
							matchedDecision: {
								id: match.id,
								identifier: match.identifier,
								title: match.title,
							},
						}
					: {}),
				...linkedWorkItem(decision, workItems),
			});
		}
	}
	return candidates;
}

export type LivingMemoryCandidateLookup =
	| { status: "found"; candidate: LivingMemoryDecisionCandidate }
	| { status: "not_found" }
	| { status: "stale" }
	| { status: "converted" };

/**
 * One candidate, for the create flow. `stale` when the file changed since the
 * candidate was read (only the current version is offered), `converted` when
 * a decision was already created from it. Its work item is re-read, so a
 * work item deleted since is not linked.
 */
export async function getLivingMemoryDecisionCandidate(input: {
	projectId: string;
	organizationId?: string | null;
	extractionId: string;
	decisionIndex: number;
}): Promise<LivingMemoryCandidateLookup> {
	const extraction = await db.projectContextDecisionExtraction.findFirst({
		where: {
			id: input.extractionId,
			projectId: input.projectId,
			organizationId: input.organizationId ?? null,
		},
		select: {
			id: true,
			contextId: true,
			contentHash: true,
			sourcePath: true,
			extractedAt: true,
			decisions: true,
			dismissedIndexes: true,
			context: { select: { contentHash: true } },
		},
	});
	const decision = extraction
		? parseLivingMemoryDecisions(extraction.decisions)[input.decisionIndex]
		: null;
	if (!extraction || !decision) {
		return { status: "not_found" };
	}
	if (extraction.context.contentHash !== extraction.contentHash) {
		return { status: "stale" };
	}
	const converted = await convertedCandidateKeys(input.projectId);
	if (
		converted.has(
			candidateKey(
				extraction.contextId,
				extraction.contentHash,
				input.decisionIndex,
			),
		)
	) {
		return { status: "converted" };
	}
	const workItems = await existingWorkItems(
		input.projectId,
		decision.workItem ? [decision.workItem.id] : [],
	);
	return {
		status: "found",
		candidate: {
			extractionId: extraction.id,
			contextId: extraction.contextId,
			contentHash: extraction.contentHash,
			sourcePath: extraction.sourcePath,
			extractedAt: extraction.extractedAt,
			decisionIndex: input.decisionIndex,
			text: decision.text,
			...(decision.rationale ? { rationale: decision.rationale } : {}),
			...linkedWorkItem(decision, workItems),
		},
	};
}

export type LivingMemoryDecisionCreation =
	| { status: "created"; decision: ArchitectureDecisionDetail }
	| { status: "converted" };

/**
 * Create the decision for a candidate, at most once. The existence check and
 * the insert share one transaction behind an advisory lock on the candidate
 * key, so a second concurrent request (a double click) waits for the first,
 * then sees its decision and answers `converted` instead of creating a
 * duplicate. `decision.sourceMetadata` must carry the candidate key's parts.
 */
export async function createDecisionFromLivingMemoryCandidate(
	candidate: Pick<
		LivingMemoryDecisionCandidate,
		"contextId" | "contentHash" | "decisionIndex"
	>,
	decision: CreateArchitectureDecisionInput,
): Promise<LivingMemoryDecisionCreation> {
	const key = candidateKey(
		candidate.contextId,
		candidate.contentHash,
		candidate.decisionIndex,
	);
	const created = await createArchitectureDecisionWhen(
		decision,
		async (tx) => {
			// `$executeRaw`, not `$queryRaw`: `pg_advisory_xact_lock()` returns
			// `void`, which Prisma cannot deserialize.
			await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LIVING_MEMORY_CANDIDATE_ADVISORY_CLASS}::int, ${advisoryObjectKey(key)}::int)`;
			const converted = await convertedCandidateKeys(
				decision.projectId,
				tx,
			);
			return !converted.has(key);
		},
	);
	return created
		? { status: "created", decision: created }
		: { status: "converted" };
}

/**
 * The decision an update replaces, for a decision created with "Create as
 * update": what accepting it marks superseded. Null for every other decision.
 */
export function livingMemoryUpdateTargetId(decision: {
	sourceKind: string | null;
	sourceMetadata: Prisma.JsonValue;
}): string | null {
	const meta = decision.sourceMetadata;
	if (
		decision.sourceKind !== LIVING_MEMORY_DECISION_SOURCE_KIND ||
		!meta ||
		typeof meta !== "object" ||
		Array.isArray(meta) ||
		typeof meta.supersedes !== "string"
	) {
		return null;
	}
	return meta.supersedes;
}

/**
 * The files whose current version met an extraction limit, by path, so the
 * Decisions tab can say which files were only partly read.
 */
export async function listLivingMemoryLimitedFiles(input: {
	projectId: string;
	organizationId?: string | null;
}): Promise<LivingMemoryLimitedFile[]> {
	const extractions = await db.projectContextDecisionExtraction.findMany({
		where: {
			projectId: input.projectId,
			organizationId: input.organizationId ?? null,
			OR: [{ contentTruncated: true }, { decisionsCapped: true }],
		},
		select: {
			contentHash: true,
			sourcePath: true,
			contentTruncated: true,
			decisionsCapped: true,
			context: { select: { contentHash: true } },
		},
		orderBy: { sourcePath: "asc" },
	});
	return extractions
		.filter(
			(extraction) =>
				extraction.context.contentHash === extraction.contentHash,
		)
		.map((extraction) => ({
			sourcePath: extraction.sourcePath,
			truncated: extraction.contentTruncated,
			capped: extraction.decisionsCapped,
		}));
}

/**
 * The synced files a member's "Scan for decisions" reads: those a
 * repository's first sync skipped (`skipped`), and those whose current
 * version has no extraction at all, such as files synced before decisions
 * were read from Living Memory. `skipped` differs by caller: the count wants
 * a mark that still names the current version, the scan any mark it clears.
 */
function awaitingDecisionScanWhere(
	scope: { projectId: string; organizationId: string | null },
	skipped: Prisma.Sql,
): Prisma.Sql {
	return Prisma.sql`c."projectId" = ${scope.projectId}
		AND c."organizationId" IS NOT DISTINCT FROM ${scope.organizationId}
		AND c."indexingExcluded" = false
		AND (
			${skipped}
			OR (
				c."sourcePath" IS NOT NULL
				AND c."contentHash" IS NOT NULL
				AND c."embeddedAt" IS NOT NULL
				AND NOT EXISTS (
					SELECT 1 FROM project_context_decision_extraction e
					WHERE e."contextId" = c.id
					  AND e."contentHash" = c."contentHash"
				)
			)
		)`;
}

/**
 * How many synced files have not been read for decisions: skipped by a
 * repository's first sync, or never read. A skipped file edited since is not
 * counted as skipped: its new version was read as usual.
 */
export async function countLivingMemoryFilesAwaitingDecisionScan(input: {
	projectId: string;
	organizationId?: string | null;
}): Promise<number> {
	const [row] = await db.$queryRaw<Array<{ count: number }>>`
		SELECT count(*)::integer AS count
		  FROM project_context c
		 WHERE ${awaitingDecisionScanWhere(
				{
					projectId: input.projectId,
					organizationId: input.organizationId ?? null,
				},
				Prisma.sql`c."decisionScanSkippedHash" = c."contentHash"`,
			)}`;
	return row?.count ?? 0;
}

/** One page of those files, by id, for a scan a member asked for. */
export async function listLivingMemoryFilesAwaitingDecisionScan(input: {
	projectId: string;
	organizationId: string | null;
	afterId?: string;
	limit: number;
}): Promise<
	Array<{ id: string; projectId: string; organizationId: string | null }>
> {
	return db.$queryRaw<
		Array<{ id: string; projectId: string; organizationId: string | null }>
	>`
		SELECT c.id, c."projectId", c."organizationId"
		  FROM project_context c
		 WHERE ${awaitingDecisionScanWhere(
				input,
				Prisma.sql`c."decisionScanSkippedHash" IS NOT NULL`,
			)}
		   ${input.afterId ? Prisma.sql`AND c.id > ${input.afterId}` : Prisma.empty}
		 ORDER BY c.id ASC
		 LIMIT ${input.limit}::integer`;
}

/** The file no longer waits on a scan. */
export async function clearLivingMemoryDecisionScanSkip(file: {
	id: string;
	projectId: string;
	organizationId: string | null;
}): Promise<void> {
	await db.projectContext.updateMany({
		where: {
			id: file.id,
			projectId: file.projectId,
			organizationId: file.organizationId,
		},
		data: { decisionScanSkippedHash: null },
	});
}

/** Record a declined candidate so it is not offered again. */
export async function dismissLivingMemoryDecision(input: {
	projectId: string;
	organizationId?: string | null;
	extractionId: string;
	decisionIndex: number;
}): Promise<boolean> {
	const extraction = await db.projectContextDecisionExtraction.findFirst({
		where: {
			id: input.extractionId,
			projectId: input.projectId,
			organizationId: input.organizationId ?? null,
		},
		select: { id: true, decisions: true, dismissedIndexes: true },
	});
	if (
		!extraction ||
		!parseLivingMemoryDecisions(extraction.decisions)[input.decisionIndex]
	) {
		return false;
	}
	if (extraction.dismissedIndexes.includes(input.decisionIndex)) {
		return true;
	}
	await db.projectContextDecisionExtraction.update({
		where: { id: extraction.id },
		data: { dismissedIndexes: { push: input.decisionIndex } },
	});
	return true;
}
