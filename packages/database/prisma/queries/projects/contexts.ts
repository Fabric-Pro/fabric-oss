/**
 * Database queries for ProjectContext model
 * Handles RAG context materials with Qdrant integration
 */

import {
	db,
	type ExtractionStatus,
	type KnowledgeBaseSourceCategory,
	// Value import (not type-only): `Prisma.join` parameterises the raw
	// id lists in `resolveContextIdsWithContent`.
	Prisma,
	type ProjectContextType,
} from "../../client";
import {
	aggregateCodeIndexStatus,
	getProjectCodeIndexes,
} from "../project-code-index";
import { listProjectRepoIntegrations } from "../project-repository-integrations";
import { getProjectRagSettings } from "./rag-settings";

/**
 * Create a new context
 *
 * TENANT ISOLATION: userId and organizationId are required for proper tenant filtering.
 */
export async function createContext(data: {
	projectId: string;
	type: ProjectContextType;
	content: string;
	qdrantId?: string;
	metadata?: Record<string, any>;
	// File upload fields
	s3Path?: string;
	s3Bucket?: string;
	originalFilename?: string;
	mimeType?: string;
	fileSize?: number;
	extractionStatus?: ExtractionStatus;
	sourceUrl?: string;
	sourceTitle?: string;
	/** LINK classification driving the Knowledge Base readiness item (#2165). */
	knowledgeBaseSourceCategory?: KnowledgeBaseSourceCategory;
	knowledgeBaseSourceCategoryOther?: string;
	/** User-declared type label + AI guidance (Fizzy #1888). */
	sourceType?: string;
	aiInstructions?: string;
	// Tenant isolation fields
	userId: string;
	organizationId?: string;
}) {
	return await db.projectContext.create({
		data: {
			projectId: data.projectId,
			type: data.type,
			content: data.content,
			qdrantId: data.qdrantId,
			metadata: data.metadata || {},
			s3Path: data.s3Path,
			s3Bucket: data.s3Bucket,
			originalFilename: data.originalFilename,
			mimeType: data.mimeType,
			fileSize: data.fileSize,
			extractionStatus: data.extractionStatus,
			sourceUrl: data.sourceUrl,
			sourceTitle: data.sourceTitle,
			knowledgeBaseSourceCategory: data.knowledgeBaseSourceCategory,
			knowledgeBaseSourceCategoryOther:
				data.knowledgeBaseSourceCategoryOther,
			sourceType: data.sourceType,
			aiInstructions: data.aiInstructions,
			userId: data.userId,
			organizationId: data.organizationId,
		},
	});
}

/**
 * Create a context for file upload (pending extraction)
 *
 * TENANT ISOLATION: userId and organizationId are required for proper tenant filtering.
 */
export async function createFileContext(data: {
	projectId: string;
	type: ProjectContextType;
	s3Path: string;
	s3Bucket: string;
	originalFilename: string;
	mimeType: string;
	fileSize: number;
	metadata?: Record<string, any>;
	/** User-declared type label + AI guidance (Fizzy #1888). */
	sourceType?: string;
	aiInstructions?: string;
	// Tenant isolation fields
	userId: string;
	organizationId?: string;
}) {
	return await db.projectContext.create({
		data: {
			projectId: data.projectId,
			type: data.type,
			content: "", // Will be filled after extraction
			s3Path: data.s3Path,
			s3Bucket: data.s3Bucket,
			originalFilename: data.originalFilename,
			mimeType: data.mimeType,
			fileSize: data.fileSize,
			extractionStatus: "PENDING",
			metadata: data.metadata || {},
			sourceType: data.sourceType,
			aiInstructions: data.aiInstructions,
			userId: data.userId,
			organizationId: data.organizationId,
		},
	});
}

/**
 * Create a context for link (pending extraction)
 *
 * TENANT ISOLATION: userId and organizationId are required for proper tenant filtering.
 */
export async function createLinkContext(data: {
	projectId: string;
	sourceUrl: string;
	sourceTitle?: string;
	metadata?: Record<string, any>;
	/**
	 * How the person adding this link described what it is (#2165). Undefined on
	 * links added before the classification existed; the Knowledge Base
	 * readiness rule treats those as unclassified rather than guessing one.
	 */
	knowledgeBaseSourceCategory?: KnowledgeBaseSourceCategory;
	knowledgeBaseSourceCategoryOther?: string;
	/** User-declared type label + AI guidance (Fizzy #1888). */
	sourceType?: string;
	aiInstructions?: string;
	// Tenant isolation fields
	userId: string;
	organizationId?: string;
}) {
	return await db.projectContext.create({
		data: {
			projectId: data.projectId,
			type: "LINK",
			content: "", // Will be filled after extraction
			sourceUrl: data.sourceUrl,
			sourceTitle: data.sourceTitle,
			extractionStatus: "PENDING",
			metadata: data.metadata || {},
			knowledgeBaseSourceCategory: data.knowledgeBaseSourceCategory,
			knowledgeBaseSourceCategoryOther:
				data.knowledgeBaseSourceCategoryOther,
			sourceType: data.sourceType,
			aiInstructions: data.aiInstructions,
			userId: data.userId,
			organizationId: data.organizationId,
		},
	});
}

/**
 * Update context extraction status
 */
export async function updateContextExtractionStatus(
	contextId: string,
	status: ExtractionStatus,
	data?: {
		content?: string;
		// `null` CLEARS the field. A successful step has to be able to erase the
		// message an earlier failed attempt left behind: `extractionError` is
		// read as evidence (a COMPLETED row carrying one is stored-but-
		// unsearchable), so a stale message is not cosmetic — it keeps
		// describing a failure that has since been fixed.
		extractionError?: string | null;
		sourceTitle?: string;
		metadata?: Record<string, any>;
	},
) {
	return await db.projectContext.update({
		where: { id: contextId },
		data: {
			extractionStatus: status,
			...(status === "COMPLETED" ? { extractedAt: new Date() } : {}),
			...(data?.content !== undefined ? { content: data.content } : {}),
			...(data?.extractionError !== undefined
				? { extractionError: data.extractionError }
				: {}),
			...(data?.sourceTitle !== undefined
				? { sourceTitle: data.sourceTitle }
				: {}),
			...(data?.metadata !== undefined
				? { metadata: data.metadata }
				: {}),
		},
	});
}

/**
 * Decide what an INDEXING failure is allowed to write.
 *
 * `extractionStatus` is written by two steps with two different meanings:
 * extraction fills `content`, and embedding then indexes it for search. When
 * only the indexing failed, stamping `FAILED` says the content is broken — and
 * the content is sitting right there, complete and readable. A staging sweep on
 * 18 Aug 2026 found all 49 meeting transcripts in one project flagged red for
 * exactly that reason, because one embedding deployment was misconfigured.
 *
 * So an indexing failure records its reason and leaves a COMPLETED row's status
 * alone. A row that never finished extracting still goes FAILED: leaving that
 * one untouched would strand it at "Pending" forever, which is the bug the
 * FAILED stamp was added to prevent in the first place.
 *
 * Split out from the write so the decision is testable without a database.
 */
export function buildIndexingFailureUpdate(
	currentStatus: ExtractionStatus | null | undefined,
	message: string,
): { extractionStatus?: ExtractionStatus; extractionError: string } {
	if (currentStatus === "COMPLETED") {
		return { extractionError: message };
	}
	return { extractionStatus: "FAILED", extractionError: message };
}

/**
 * Record that search indexing failed for a context, without lying about
 * whether its content was extracted. See `buildIndexingFailureUpdate`.
 */
export async function recordContextIndexingFailure(
	contextId: string,
	message: string,
) {
	const existing = await db.projectContext.findUnique({
		where: { id: contextId },
		select: { extractionStatus: true },
	});

	return await db.projectContext.update({
		where: { id: contextId },
		data: buildIndexingFailureUpdate(existing?.extractionStatus, message),
	});
}

/**
 * Get contexts pending extraction
 */
export async function getPendingExtractionContexts(projectId?: string) {
	return await db.projectContext.findMany({
		where: {
			...(projectId ? { projectId } : {}),
			extractionStatus: { in: ["PENDING", "EXTRACTING"] },
		},
		orderBy: { createdAt: "asc" },
	});
}

/**
 * Get context by ID
 *
 * TENANT ISOLATION: When `projectId` and `tenant` are supplied, the query
 * enforces the multi-tenant XOR filter (`userId` AND `organizationId`) plus a
 * `projectId` equality check as a defense-in-depth IDOR guard (see
 * `docs/specs/2026-04-15-download-project-context-files/spec.md` §6.3, §10).
 *
 * The legacy single-argument form is preserved for backwards compatibility
 * with existing callers that perform their own scoping.
 */
export async function getContextById(
	contextId: string,
	projectId?: string,
	tenant?: { userId: string; organizationId?: string | null },
) {
	if (projectId && tenant) {
		// Access control: for org-scoped projects, any active member sees every
		// context (membership is enforced by `verifyOrganizationMembership` in
		// the calling procedure — `userId` here would be the context's
		// `createdBy`, which would incorrectly hide rows created by workflows
		// or teammates). For personal projects we keep the userId filter so
		// one user's personal contexts never leak into another's scope.
		const tenantFilter = tenant.organizationId
			? { organizationId: tenant.organizationId }
			: { organizationId: null, userId: tenant.userId };

		return await db.projectContext.findFirst({
			where: {
				id: contextId,
				projectId,
				...tenantFilter,
			},
			include: {
				project: {
					select: {
						id: true,
						name: true,
						userId: true,
						organizationId: true,
					},
				},
			},
		});
	}

	return await db.projectContext.findUnique({
		where: { id: contextId },
		include: {
			project: {
				select: {
					id: true,
					name: true,
					userId: true,
					organizationId: true,
				},
			},
		},
	});
}

/**
 * Resolve a Qdrant `contextId` to a retrievable row, looking in BOTH
 * `ProjectContext` and `ProjectContextUrlPage`.
 *
 * Why this exists: URL Context Sources (PATH_PREFIX) embed every scraped
 * page as its OWN Qdrant point, with the chunk's `payload.contextId` set
 * to the per-page `ProjectContextUrlPage.id` (not the parent
 * `ProjectContext.id`). RAG search returns those per-page IDs. The legacy
 * `getContextById` only queries `project_context`, so it returns `null`
 * for every URL-page hit and callers silently filter them out — i.e. the
 * AI Feature Assistant, "Update using context", and document generation
 * all proved BLIND to URL sources even after a successful crawl.
 *
 * This helper normalises both row shapes into a single `RetrievableContext`
 * so callers (`retrieveProjectContexts`, `retrieveRelevantContextsForSpec`)
 * don't have to special-case URL pages. Falls back to the URL-page table
 * when `getContextById` misses, then synthesizes a `LINK`-typed envelope
 * with the parent's `sourceTitle` and the page's own URL + content.
 */
export interface RetrievableContext {
	id: string;
	type: string;
	content: string;
	createdAt: Date;
	metadata: unknown;
	originalFilename: string | null;
	sourceUrl: string | null;
	sourceTitle: string | null;
	/** User-declared type label + AI guidance (Fizzy #1888); null when unset. */
	sourceType: string | null;
	aiInstructions: string | null;
}

export async function getRetrievableContextById(
	contextId: string,
): Promise<RetrievableContext | null> {
	const projectContext = await db.projectContext.findUnique({
		where: { id: contextId },
		select: {
			id: true,
			type: true,
			content: true,
			createdAt: true,
			metadata: true,
			originalFilename: true,
			sourceUrl: true,
			sourceTitle: true,
			sourceType: true,
			aiInstructions: true,
		},
	});

	if (projectContext) {
		return {
			id: projectContext.id,
			type: projectContext.type,
			content: projectContext.content,
			createdAt: projectContext.createdAt,
			metadata: projectContext.metadata,
			originalFilename: projectContext.originalFilename,
			sourceUrl: projectContext.sourceUrl,
			sourceTitle: projectContext.sourceTitle,
			sourceType: projectContext.sourceType,
			aiInstructions: projectContext.aiInstructions,
		};
	}

	// Fallback: maybe it's a per-page URL chunk. Join the parent so we can
	// carry the user's parent label through to the LLM prompt — much more
	// useful than the raw article URL alone.
	const urlPage = await db.projectContextUrlPage.findUnique({
		where: { id: contextId },
		select: {
			id: true,
			content: true,
			pageUrl: true,
			pageTitle: true,
			createdAt: true,
			parentContext: {
				select: {
					id: true,
					sourceTitle: true,
					sourceType: true,
					aiInstructions: true,
				},
			},
		},
	});

	if (!urlPage) {
		return null;
	}

	return {
		id: urlPage.id,
		// Surface as LINK so the prompt formatter and downstream type-aware
		// branches treat it the same as a top-level URL source.
		type: "LINK",
		content: urlPage.content,
		createdAt: urlPage.createdAt,
		metadata: {
			parentContextId: urlPage.parentContext?.id ?? null,
			pageUrl: urlPage.pageUrl,
			pageTitle: urlPage.pageTitle,
		},
		originalFilename: null,
		// The actual indexed page URL — the per-article URL the AI should cite.
		sourceUrl: urlPage.pageUrl,
		// The user's parent label set when adding the URL source. Falls
		// back to the per-article title if the parent has no custom label.
		sourceTitle: urlPage.parentContext?.sourceTitle ?? urlPage.pageTitle,
		// The parent source's type label + AI guidance apply to every page
		// crawled under it.
		sourceType: urlPage.parentContext?.sourceType ?? null,
		aiInstructions: urlPage.parentContext?.aiInstructions ?? null,
	};
}

/**
 * Get a URL source context (LINK row) with tenant XOR + project scoping.
 *
 * Reads a single ProjectContext row that is BOTH `type === "LINK"` AND
 * scoped to the requested project under the strict tenant XOR filter
 * (org members resolve org-scoped projects; personal contexts are limited
 * to their owner). Returns the parent row, the project's `name`, and a
 * `_count.urlPages` so the dedicated URL-source page can show
 * "Pages indexed" without a second round-trip for PATH_PREFIX crawls.
 *
 * The function returns `null` when the row does not exist, the tenancy
 * check fails, or the row is not a LINK — callers should treat any
 * `null` as a 404-equivalent and redirect back to the contexts list.
 */
export async function getUrlSourceContext(input: {
	contextId: string;
	projectId: string;
	userId: string;
	organizationId: string | null;
}) {
	const { contextId, projectId, userId, organizationId } = input;

	// Access control: any active org member resolves org-scoped projects
	// (membership is enforced by `verifyOrganizationMembership` upstream).
	// Personal projects are limited to their owner.
	const tenantFilter = organizationId
		? { organizationId }
		: { organizationId: null, userId };

	const row = await db.projectContext.findFirst({
		where: {
			id: contextId,
			projectId,
			type: "LINK",
			...tenantFilter,
		},
		include: {
			project: {
				select: {
					id: true,
					name: true,
					userId: true,
					organizationId: true,
				},
			},
			_count: {
				select: {
					// Total child rows under this LINK — equal to the
					// "discovered URL set" once the workflow's bulk-init
					// has run. PENDING placeholders are counted here so
					// the UI can show "X of Y" during crawl.
					urlPages: true,
				},
			},
		},
	});

	if (!row) {
		return row;
	}

	// Per-status breakdown for the Details sidebar's progress table.
	// One `groupBy` round-trip → `{ COMPLETED: 96, PENDING: 404, FAILED: 0 }`
	// shape so the UI can render Indexed / Processing / Failed counts side
	// by side. EXTRACTING rolls into PROCESSING for the user-facing table
	// since both mean "in flight" from the user's POV. Prisma's
	// filtered-count via `_count: { select: { urlPages: { where } } }`
	// requires a relation count config we don't have, so the explicit
	// groupBy is the right tool here.
	const statusGroups = await db.projectContextUrlPage.groupBy({
		by: ["extractionStatus"],
		where: { parentContextId: row.id },
		_count: { _all: true },
	});
	const byStatus: Record<string, number> = {};
	for (const g of statusGroups) {
		byStatus[g.extractionStatus] = g._count._all;
	}
	const completedCount = byStatus.COMPLETED ?? 0;
	const failedCount = byStatus.FAILED ?? 0;
	const pendingCount = (byStatus.PENDING ?? 0) + (byStatus.EXTRACTING ?? 0);

	return Object.assign(row, {
		completedCount,
		failedCount,
		pendingCount,
	});
}

/**
 * List contexts for batch download generation.
 *
 * Scoped to a single `projectId` and returns every context row attached to
 * that project, ordered by `createdAt` ascending. Authorization is enforced
 * by the calling procedure (`tenantProtectedProcedure`,
 * `requireProjectPermission(CONTEXT_READ)`, `verifyOrganizationMembership`,
 * and the upstream `getProjectForDownload` tenant XOR check) — by the time
 * this query runs, the caller is already proven to have read access to the
 * project, so every context attached to it is in-scope.
 *
 * Select shape mirrors spec §6.3 — only the minimum fields needed by the
 * batch download procedure. `metadata` is included so the caller can derive
 * `integrationProvider` (stored under `metadata.provider`) without a second
 * round-trip.
 *
 * `urlScope` is selected for one reason: a `LINK` row crawled with
 * `PATH_PREFIX` keeps its markdown in child `ProjectContextUrlPage` rows and
 * leaves `content` empty on the parent. Without this column the batch export
 * cannot tell that row apart from a genuinely empty one, and skips a link the
 * single-item download exports fine. Keep it in the select.
 */
export async function listContextsForDownload(projectId: string) {
	return await db.projectContext.findMany({
		where: { projectId },
		select: {
			id: true,
			type: true,
			content: true,
			s3Path: true,
			s3Bucket: true,
			originalFilename: true,
			mimeType: true,
			fileSize: true,
			sourceTitle: true,
			sourceUrl: true,
			urlScope: true,
			extractionStatus: true,
			metadata: true,
			createdAt: true,
		},
		// `createdAt` alone is not a total order: rows written in one
		// transaction share a timestamp and Postgres may return those ties in
		// any order. The batch export truncates at an item ceiling rather than
		// refusing (Fizzy #2228), so an unstable tie order would mean two
		// exports of an unchanged project dropped different rows. `id` settles
		// it.
		orderBy: [{ createdAt: "asc" }, { id: "asc" }],
	});
}

/**
 * Fetch `{ id, name }` for a project under the tenant XOR filter.
 * Returns `null` if the project does not exist or belongs to a different
 * tenant (see spec §6.3).
 */
export async function getProjectForDownload(
	projectId: string,
	tenant: { userId: string; organizationId?: string | null },
) {
	// Access control: any active org member resolves org-scoped projects
	// (membership is enforced by `verifyOrganizationMembership` upstream).
	// Personal projects are limited to their owner.
	const tenantFilter = tenant.organizationId
		? { organizationId: tenant.organizationId }
		: { organizationId: null, userId: tenant.userId };

	return await db.project.findFirst({
		where: {
			id: projectId,
			...tenantFilter,
		},
		select: {
			id: true,
			name: true,
		},
	});
}

/**
 * List contexts for a project
 */
export async function listContexts(options: {
	projectId: string;
	type?: ProjectContextType;
	/**
	 * Pagination limit. Pass a number to take that many rows, or `"none"` to
	 * disable pagination entirely (returns every matching row, `hasMore` is
	 * always `false`). Defaults to `50` for callers that rely on batching
	 * (retrieval, sweep workflows).
	 */
	limit?: number | "none";
	offset?: number;
	excludeLinkedDocuments?: boolean;
}) {
	const {
		projectId,
		type,
		limit = 50,
		offset = 0,
		excludeLinkedDocuments,
	} = options;

	const where: Prisma.ProjectContextWhereInput = {
		projectId,
		...(type ? { type } : {}),
		...(excludeLinkedDocuments ? { importedDocuments: { none: {} } } : {}),
	};

	const paginate = limit !== "none";

	const [contexts, total] = await Promise.all([
		db.projectContext.findMany({
			where,
			orderBy: { createdAt: "desc" },
			...(paginate ? { take: limit, skip: offset } : {}),
		}),
		db.projectContext.count({ where }),
	]);

	return {
		contexts,
		total,
		hasMore: paginate ? offset + limit < total : false,
	};
}

/**
 * Context types produced by repository code indexing. A project with an
 * indexed repo carries one row per file — thousands of them — so callers
 * that want an at-a-glance inventory hide them unless they opt in.
 */
/** Mirrors the `UrlSourceScope` schema enum, which the client barrel does not re-export. */
type UrlSourceScope = "SINGLE_PAGE" | "PATH_PREFIX";

const CODE_INDEX_CONTEXT_TYPES: ProjectContextType[] = [
	"CODE_FILE",
	"CODE_FILE_SUMMARY",
];

export interface ProjectContextInventoryItem {
	id: string;
	type: ProjectContextType;
	sourceTitle: string | null;
	originalFilename: string | null;
	mimeType: string | null;
	fileSize: number | null;
	sourceUrl: string | null;
	extractionStatus: ExtractionStatus;
	extractionError: string | null;
	urlScope: UrlSourceScope | null;
	metadata: Prisma.JsonValue;
	createdAt: Date;
	updatedAt: Date;
	/** True when the row points at an original object in storage. */
	hasStoredFile: boolean;
	/**
	 * True when the row carries retrievable text — either on `content` or,
	 * for a PATH_PREFIX URL source, on its crawled child pages.
	 */
	hasContent: boolean;
}

/**
 * List a project's contexts as lightweight summaries — every field a caller
 * needs to decide what to fetch, and none of the bodies. `content` is
 * deliberately absent from the select: a project with a few hundred meeting
 * transcripts would otherwise stream tens of megabytes for an inventory.
 *
 * `hasContent` is resolved with id-only follow-up queries rather than by
 * reading the bodies back, so "is there anything here?" costs no transfer.
 * It matters because an INTEGRATION row that only pins a monitored chat is
 * marked COMPLETED while its `content` stays empty — those messages become
 * `PendingBacklogProposal` rows and never land on the context. A caller
 * trusting `extractionStatus` alone would read that as an empty meeting.
 *
 * Authorization is the caller's job: the query is project-scoped only, so
 * the caller must prove project access (`hasProjectAccess`) first.
 */
export async function listProjectContextSummaries(options: {
	projectId: string;
	type?: ProjectContextType;
	includeCodeContexts?: boolean;
	limit?: number;
	offset?: number;
}): Promise<{
	contexts: ProjectContextInventoryItem[];
	total: number;
	hasMore: boolean;
	excludedCodeContexts: number;
}> {
	const {
		projectId,
		type,
		includeCodeContexts = false,
		limit = 50,
		offset = 0,
	} = options;

	// An explicit `type` already narrows the set, so the code-index default
	// only applies to unfiltered listings — asking for CODE_FILE and getting
	// nothing back because of a default would be a lie.
	const hidesCodeContexts = !type && !includeCodeContexts;

	const where: Prisma.ProjectContextWhereInput = {
		projectId,
		...(type ? { type } : {}),
		...(hidesCodeContexts
			? { type: { notIn: CODE_INDEX_CONTEXT_TYPES } }
			: {}),
	};

	const [rows, total, excludedCodeContexts] = await Promise.all([
		db.projectContext.findMany({
			where,
			select: {
				id: true,
				type: true,
				sourceTitle: true,
				originalFilename: true,
				mimeType: true,
				fileSize: true,
				sourceUrl: true,
				extractionStatus: true,
				extractionError: true,
				urlScope: true,
				metadata: true,
				createdAt: true,
				updatedAt: true,
				s3Path: true,
			},
			orderBy: { createdAt: "desc" },
			take: limit,
			skip: offset,
		}),
		db.projectContext.count({ where }),
		hidesCodeContexts
			? db.projectContext.count({
					where: {
						projectId,
						type: { in: CODE_INDEX_CONTEXT_TYPES },
					},
				})
			: Promise.resolve(0),
	]);

	const withContent = await resolveContextIdsWithContent(rows);

	return {
		contexts: rows.map(({ s3Path, ...row }) => ({
			...row,
			hasStoredFile: Boolean(s3Path),
			hasContent: withContent.has(row.id),
		})),
		total,
		hasMore: offset + rows.length < total,
		excludedCodeContexts,
	};
}

/**
 * Matches a string holding at least one non-whitespace character.
 *
 * The obvious predicate — `content <> ''` — is not enough. A scanned or
 * photo-only PDF extracts to whitespace: the pipeline marks it COMPLETED and
 * stores something like `"\n\n"`, which is non-empty but carries no text. A
 * caller told that row is readable receives two newlines, which is precisely
 * the "empty result that reads as real" this column of the response exists to
 * prevent.
 *
 * Postgres `btrim` defaults to trimming SPACES only, so it would still call
 * `"\n\n"` non-blank. The character-class regex is the version that actually
 * holds for newlines and tabs.
 */
const HAS_NON_WHITESPACE = "[^[:space:]]";

/**
 * Resolve which of the given contexts actually hold readable text, without
 * pulling the text across the wire. A PATH_PREFIX URL source keeps its
 * markdown on `ProjectContextUrlPage` children instead of the parent row, so
 * it needs a separate existence check.
 *
 * Raw SQL rather than Prisma filters: the blank-vs-empty distinction above
 * needs a regex predicate, which `findMany` cannot express. Both statements
 * are parameterised — ids flow through `Prisma.join`, never interpolation.
 */
async function resolveContextIdsWithContent(
	rows: ReadonlyArray<{ id: string; urlScope: UrlSourceScope | null }>,
): Promise<Set<string>> {
	if (rows.length === 0) {
		return new Set();
	}

	const ids = rows.map((row) => row.id);
	const crawledIds = rows
		.filter((row) => row.urlScope === "PATH_PREFIX")
		.map((row) => row.id);

	const [direct, crawled] = await Promise.all([
		db.$queryRaw<Array<{ id: string }>>`
			SELECT id
			  FROM project_context
			 WHERE id IN (${Prisma.join(ids)})
			   AND content ~ ${HAS_NON_WHITESPACE}
		`,
		crawledIds.length > 0
			? db.$queryRaw<Array<{ parentContextId: string }>>`
				SELECT DISTINCT "parentContextId"
				  FROM project_context_url_page
				 WHERE "parentContextId" IN (${Prisma.join(crawledIds)})
				   AND content ~ ${HAS_NON_WHITESPACE}
			`
			: Promise.resolve([] as Array<{ parentContextId: string }>),
	]);

	return new Set([
		...direct.map((row) => row.id),
		...crawled.map((row) => row.parentContextId),
	]);
}

/**
 * Concatenate the markdown of every indexed page under a PATH_PREFIX LINK
 * context into one self-contained document. Those crawls scatter their text
 * across `ProjectContextUrlPage` rows rather than the parent's `content`, so
 * anything that reads a URL source's body has to reassemble it here.
 *
 * Pages are ordered by `pageUrl` ascending — the same order the in-app
 * drawer and the single-context download use, so the reading order matches
 * what the user saw in Fabric.
 *
 * Tenant XOR is re-derived from the caller rather than trusted from the
 * parent row, so a stale mirrored tenant on a child can never leak across
 * organizations.
 */
export async function getCrawledUrlSourceMarkdown(
	parentContextId: string,
	tenant: { userId: string; organizationId?: string | null },
): Promise<string> {
	const tenantFilter = tenant.organizationId
		? { organizationId: tenant.organizationId }
		: { organizationId: null, userId: tenant.userId };

	const pages = await db.projectContextUrlPage.findMany({
		where: { parentContextId, ...tenantFilter },
		select: { pageUrl: true, pageTitle: true, content: true },
		orderBy: { pageUrl: "asc" },
	});

	return pages
		.filter((page) => page.content.length > 0)
		.map(
			(page) =>
				`## ${page.pageTitle || page.pageUrl}\n${page.pageUrl}\n\n${page.content}\n`,
		)
		.join("\n---\n\n");
}

/**
 * Update context
 */
export async function updateContext(
	contextId: string,
	data: {
		content?: string;
		qdrantId?: string;
		metadata?: Record<string, any>;
	},
) {
	return await db.projectContext.update({
		where: { id: contextId },
		data,
	});
}

/**
 * Delete context
 * Note: Caller should also delete from Qdrant using qdrantId
 */
export async function deleteContext(contextId: string) {
	return await db.projectContext.delete({
		where: { id: contextId },
	});
}

/**
 * Get contexts by Qdrant IDs
 */
export async function getContextsByQdrantIds(qdrantIds: string[]) {
	return await db.projectContext.findMany({
		where: {
			qdrantId: {
				in: qdrantIds,
			},
		},
	});
}

/**
 * Get all contexts for a project (for RAG retrieval)
 */
export async function getAllProjectContexts(projectId: string) {
	return await db.projectContext.findMany({
		where: { projectId },
		orderBy: { createdAt: "asc" },
	});
}

/**
 * Count contexts by type
 */
export async function countContextsByType(projectId: string) {
	const contexts = await db.projectContext.groupBy({
		by: ["type"],
		where: { projectId },
		_count: true,
	});

	return contexts.reduce(
		(acc, item) => {
			acc[item.type] = item._count;
			return acc;
		},
		{} as Record<ProjectContextType, number>,
	);
}

/**
 * Check if context exists
 */
export async function contextExists(contextId: string): Promise<boolean> {
	const context = await db.projectContext.findUnique({
		where: { id: contextId },
		select: { id: true },
	});

	return !!context;
}

/**
 * Delete all contexts for a project
 * Note: Caller should also delete from Qdrant
 */
export async function deleteAllProjectContexts(projectId: string) {
	return await db.projectContext.deleteMany({
		where: { projectId },
	});
}

/**
 * Get unembedded contexts for a project
 */
export async function getUnembeddedContexts(projectId: string) {
	return await db.projectContext.findMany({
		where: {
			projectId,
			embeddedAt: null,
		},
		orderBy: { createdAt: "asc" },
	});
}

/**
 * Mark context as embedded
 */
export async function markContextAsEmbedded(
	contextId: string,
	qdrantId: string,
) {
	return await db.projectContext.update({
		where: { id: contextId },
		data: {
			qdrantId,
			embeddedAt: new Date(),
		},
	});
}

/**
 * Discriminated codebase-availability state for the assistant's context
 * preamble. Derived from the signals the assistant actually uses — repository
 * integration status, the code-search toggle, and the code-index status — so
 * the message can distinguish "no repository attached" from "attached but
 * credentials expired / not yet indexed". Replaces the old single boolean that
 * conflated all of these into "no repository attached or analysis not completed".
 */
export type CodebaseState =
	| "available"
	| "not-connected"
	| "code-search-disabled"
	| "credentials-expired"
	| "repo-unreachable"
	| "not-indexed"
	| "indexing-failed";

export interface ContextAvailabilityResult {
	/**
	 * True only when the codebase is actually queryable (`codebaseState ===
	 * "available"`). Kept for backward compatibility with callers that only
	 * need the boolean; new code should read `codebaseState` for the precise
	 * reason a codebase is or isn't available.
	 */
	hasCodebase: boolean;
	/**
	 * Precise codebase availability reason. Optional so legacy callers that
	 * only set `hasCodebase` keep compiling; the formatter falls back to the
	 * boolean when this is absent.
	 */
	codebaseState?: CodebaseState;
	transcriptCount: number;
	fileCount: number;
	integrationCount: number;
	teamsCount: number;
	slackCount: number;
	/**
	 * Count of LINK rows attached to the project. Surfaced in the system
	 * prompt so the LLM knows the project has indexed website sources
	 * (URL Context Sources, spec §8.4).
	 */
	websiteSources: number;
}

/**
 * Derive the discriminated codebase state from the three signals the assistant
 * relies on. Pure and side-effect-free so the precedence is unit-testable
 * without a database.
 *
 * Precedence (first match wins):
 *   1. no live integration row       → not-connected
 *      (DISCONNECTED rows are detached — tokens wiped — and don't count)
 *   2. code-search toggle off        → code-search-disabled
 *   3. no ACTIVE integration         → repo-unreachable when every remaining
 *      live row is REPO_UNAVAILABLE (credentials fine, repository unreadable —
 *      re-authenticating fixes nothing), else credentials-expired
 *      (TOKEN_EXPIRED / ERROR)
 *   4. index missing / building      → not-indexed
 *   5. index FAILED                  → indexing-failed
 *   6. index READY / STALE           → available
 *
 * Multi-repo: a single ACTIVE integration is enough to pass the credential
 * gate, so a healthy repo alongside an expired one still resolves on the index.
 */
export function deriveCodebaseState(input: {
	integrationStatuses: string[];
	codeSearchEnabled: boolean;
	codeIndexStatus: string | null;
}): CodebaseState {
	const { integrationStatuses, codeSearchEnabled, codeIndexStatus } = input;

	// A DISCONNECTED row is functionally detached (its tokens are wiped, e.g.
	// after the connecting member was removed), so it does not count as a
	// connected repository — report "not connected", not "credentials expired".
	const connectedStatuses = integrationStatuses.filter(
		(status) => status !== "DISCONNECTED",
	);

	if (connectedStatuses.length === 0) {
		return "not-connected";
	}
	if (!codeSearchEnabled) {
		return "code-search-disabled";
	}
	if (!connectedStatuses.includes("ACTIVE")) {
		// REPO_UNAVAILABLE rows hold a working credential that cannot read the
		// repository — "credentials expired" would send the reader to
		// re-authenticate, which cannot fix it. Only when EVERY remaining live
		// row is unreachable does that state win; mixed with real expiry
		// (TOKEN_EXPIRED / ERROR) the expired wording is still the actionable
		// one.
		return connectedStatuses.every(
			(status) => status === "REPO_UNAVAILABLE",
		)
			? "repo-unreachable"
			: "credentials-expired";
	}
	if (
		codeIndexStatus === null ||
		codeIndexStatus === "PENDING" ||
		codeIndexStatus === "INDEXING"
	) {
		return "not-indexed";
	}
	if (codeIndexStatus === "FAILED") {
		return "indexing-failed";
	}
	if (codeIndexStatus === "READY" || codeIndexStatus === "STALE") {
		return "available";
	}
	// Unknown / future status value — treat as not-yet-usable rather than
	// claiming availability we can't guarantee.
	return "not-indexed";
}

/**
 * Map a codebase state to its context-preamble line. The credentials-expired
 * and code-search-disabled lines name the concrete fix in the project's
 * Settings → Development. The owner-aware hint is static text — the preamble is
 * project-scoped and shared across viewers, so it must not branch on who is
 * reading it.
 */
function describeCodebaseAvailability(
	availability: ContextAvailabilityResult,
): {
	available: boolean;
	text: string;
} {
	const state: CodebaseState =
		availability.codebaseState ??
		(availability.hasCodebase ? "available" : "not-connected");

	switch (state) {
		case "available":
			return {
				available: true,
				text: "Codebase analysis (attached repository)",
			};
		case "not-connected":
			return {
				available: false,
				text: "Codebase (no repository connected)",
			};
		case "code-search-disabled":
			return {
				available: false,
				text: "Codebase (repository connected, but code search is turned off — enable it in the project's Settings → Development)",
			};
		case "credentials-expired":
			return {
				available: false,
				text: "Codebase (repository connected, but its credentials expired — re-authenticate in the project's Settings → Development; a project owner may need to do this)",
			};
		case "repo-unreachable":
			return {
				available: false,
				text: "Codebase (repository connected, but the connected credentials cannot read it — install the provider app on the repository or connect it with a personal access token in the project's Settings → Development; reconnecting will not help)",
			};
		case "not-indexed":
			return {
				available: false,
				text: "Codebase (repository connected, but its code has not finished indexing yet)",
			};
		case "indexing-failed":
			return {
				available: false,
				text: "Codebase (repository connected, but code indexing failed — retry from the project's Settings → Development)",
			};
	}
}

/**
 * Format context availability as AVAILABLE/NOT AVAILABLE text lines.
 */
export function formatContextAvailabilityText(
	availability: ContextAvailabilityResult,
): string {
	const available: string[] = [];
	const unavailable: string[] = [];

	const codebase = describeCodebaseAvailability(availability);
	if (codebase.available) {
		available.push(codebase.text);
	} else {
		unavailable.push(codebase.text);
	}
	if (availability.transcriptCount > 0) {
		available.push(
			`Meeting transcripts (${availability.transcriptCount} synced)`,
		);
	} else {
		unavailable.push("Meeting transcripts (none synced)");
	}
	if (availability.fileCount > 0) {
		available.push(
			`Project files and documents (${availability.fileCount})`,
		);
	}
	if (availability.teamsCount > 0) {
		available.push("Teams chat conversations");
	} else {
		unavailable.push("Teams chat (not connected)");
	}
	if (availability.slackCount > 0) {
		available.push("Slack channel conversations");
	} else {
		unavailable.push("Slack chat (not connected)");
	}
	const otherIntegrations =
		availability.integrationCount -
		availability.teamsCount -
		availability.slackCount;
	if (otherIntegrations > 0) {
		available.push(`Other integrations (${otherIntegrations} sources)`);
	}
	// URL Context Sources — only surface when at least one is
	// indexed. Skipping the "NOT AVAILABLE" line keeps the preamble short
	// when the user hasn't added any URLs (the existing copy treats files
	// the same way).
	if (availability.websiteSources > 0) {
		available.push(`Website sources (${availability.websiteSources})`);
	}

	return [
		"Context Sources:",
		available.length > 0
			? `AVAILABLE: ${available.join(", ")}`
			: "No project context sources attached.",
		unavailable.length > 0
			? `NOT AVAILABLE: ${unavailable.join(", ")}`
			: "",
	]
		.filter(Boolean)
		.join("\n");
}

/**
 * In-memory cache for context availability (60s TTL).
 * Avoids running 4 DB queries on every chat message for the same project.
 */
const availabilityCache = new Map<
	string,
	{ data: ContextAvailabilityResult; expiresAt: number }
>();
const AVAILABILITY_CACHE_TTL = 60_000; // 60 seconds

/**
 * Get context availability summary for a project.
 * Returns counts of each context type for system prompt injection.
 * Results are cached for 60s per project to avoid redundant queries.
 *
 * Note: `websiteSources` (LINK row count) is derived from the existing
 * `contextTypeCounts` groupBy — no extra query needed.
 */
export async function getProjectContextAvailability(
	projectId: string,
): Promise<ContextAvailabilityResult> {
	const cacheKey = projectId;
	const cached = availabilityCache.get(cacheKey);
	if (cached && cached.expiresAt > Date.now()) {
		return cached.data;
	}
	const [
		contextTypeCounts,
		teamsCount,
		slackCount,
		repoIntegrations,
		codeIndexes,
		ragSettings,
	] = await Promise.all([
		db.projectContext.groupBy({
			by: ["type"],
			where: { projectId },
			_count: true,
		}),
		db.projectContext.count({
			where: {
				projectId,
				metadata: {
					path: ["provider"],
					equals: "MICROSOFT_TEAMS",
				},
			},
		}),
		db.projectContext.count({
			where: {
				projectId,
				metadata: { path: ["provider"], equals: "SLACK" },
			},
		}),
		// Modern codebase signals — the same ones the assistant's code search
		// relies on. These, not the legacy `codeAnalysisStatus` doc-gen field,
		// decide whether the codebase is actually queryable.
		listProjectRepoIntegrations(projectId),
		getProjectCodeIndexes(projectId),
		getProjectRagSettings(projectId),
	]);

	const fileTypes = ["FILE", "IMAGE", "DOCUMENT", "SPREADSHEET"];
	const transcriptCount =
		contextTypeCounts.find((c) => c.type === "MEETING_TRANSCRIPT")
			?._count ?? 0;
	const fileCount = contextTypeCounts
		.filter((c) => fileTypes.includes(c.type))
		.reduce((sum, c) => sum + c._count, 0);
	const integrationCount =
		contextTypeCounts.find((c) => c.type === "INTEGRATION")?._count ?? 0;
	const websiteSources =
		contextTypeCounts.find((c) => c.type === "LINK")?._count ?? 0;

	const codebaseState = deriveCodebaseState({
		integrationStatuses: repoIntegrations.map((i) => i.status),
		codeSearchEnabled: ragSettings.codeSearchEnabled,
		// Per-repo: surface the most-available status across all repos.
		codeIndexStatus: aggregateCodeIndexStatus(codeIndexes),
	});

	const result: ContextAvailabilityResult = {
		hasCodebase: codebaseState === "available",
		codebaseState,
		transcriptCount,
		fileCount,
		integrationCount,
		teamsCount,
		slackCount,
		websiteSources,
	};

	availabilityCache.set(cacheKey, {
		data: result,
		expiresAt: Date.now() + AVAILABILITY_CACHE_TTL,
	});

	return result;
}
