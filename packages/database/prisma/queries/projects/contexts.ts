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
import { recordAuditTx } from "../audit-log";
import {
	aggregateCodeIndexStatus,
	getProjectCodeIndexes,
} from "../project-code-index";
import { listProjectRepoIntegrations } from "../project-repository-integrations";
import {
	contextContentHashOrNull,
	hashContextContent,
} from "./context-content-hash";
import { normalizeContextSourcePathPrefix } from "./context-source-path";
import { getProjectRagSettings } from "./rag-settings";
import {
	buildSyncedContextDeleteAuditEvent,
	SYNCED_CONTEXT_DELETE_AUDIT_ACTION,
	type SyncedContextDeletionAuditContext,
} from "./synced-context-delete-audit";

/**
 * Create a new context
 *
 * Stamps `contentHash` from `content` (null when empty), so a pasted or
 * integration row is visible to duplicate detection the moment it exists
 * (Fizzy #2619).
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
			contentHash: contextContentHashOrNull(data.content),
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
 *
 * When `data.content` is given, `contentHash` is written with it (the hash of
 * the new content, or null when it is empty). This is where every
 * extraction pipeline — file, link, Google Doc — lands its text, so it is
 * where uploaded content becomes visible to duplicate detection
 * (Fizzy #2619). Omitting `content` leaves both columns untouched.
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
			...(data?.content !== undefined
				? {
						content: data.content,
						contentHash: contextContentHashOrNull(data.content),
					}
				: {}),
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
 * Escape SQL `LIKE` metacharacters so a string matches only itself.
 *
 * Prisma passes a `startsWith` value into `LIKE $n` verbatim — checked
 * against this repo's Prisma 6.18 query compiler, where
 * `startsWith: "a_b%/"` becomes `"sourcePath"::text LIKE $2` with
 * `$2 = 'a_b%/%'` — so an unescaped `_` or `%` in a folder name would act
 * as a wildcard. Backslash is Postgres's default `LIKE` escape character,
 * so it goes first.
 */
function escapeLikeLiteral(value: string): string {
	return value.replace(/[\\%_]/g, "\\$&");
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
	/**
	 * Only synced knowledge files under this folder of the working tree
	 * (Fizzy #2620), e.g. `docs/guides` — a directory prefix, not a string
	 * prefix: `docs` never selects `docs-archive/a.md`. `""`, `.` or `./`
	 * selects every synced file. Absent means no path filter at all, so rows
	 * without a `sourcePath` are listed too.
	 *
	 * Normalized with `normalizeContextSourcePathPrefix`, which throws
	 * `ContextSourcePathError` (before any query runs) for a spelling no
	 * stored key could start with.
	 */
	sourcePathPrefix?: string;
}) {
	const {
		projectId,
		type,
		limit = 50,
		offset = 0,
		excludeLinkedDocuments,
		sourcePathPrefix,
	} = options;

	const normalizedPrefix =
		sourcePathPrefix === undefined
			? undefined
			: normalizeContextSourcePathPrefix(sourcePathPrefix);

	const where: Prisma.ProjectContextWhereInput = {
		projectId,
		...(type ? { type } : {}),
		...(excludeLinkedDocuments ? { importedDocuments: { none: {} } } : {}),
		...(normalizedPrefix === undefined
			? {}
			: {
					sourcePath:
						normalizedPrefix === ""
							? { not: null }
							: {
									startsWith:
										escapeLikeLiteral(normalizedPrefix),
								},
				}),
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
	/** User-declared type label and AI guidance (Fizzy #1888). */
	sourceType: string | null;
	aiInstructions: string | null;
	/** Who last edited those two fields, and when — null until someone does. */
	metadataUpdatedAt: Date | null;
	metadataUpdatedByUserId: string | null;
	/**
	 * A synced knowledge file's key and version (Fizzy #2616) — null on every
	 * row that did not come through the synced-file path. `contentHash` is
	 * what a replace passes back as `expectedContentHash`.
	 */
	sourcePath: string | null;
	contentHash: string | null;
	contentUpdatedAt: Date | null;
	contentUpdatedByUserId: string | null;
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
				sourceType: true,
				aiInstructions: true,
				metadataUpdatedAt: true,
				metadataUpdatedByUserId: true,
				sourcePath: true,
				contentHash: true,
				contentUpdatedAt: true,
				contentUpdatedByUserId: true,
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
 * Read one offset page of a PATH_PREFIX crawl without transferring every child
 * body to the application process. The SQL aggregation deliberately mirrors
 * {@link getCrawledUrlSourceMarkdown} byte-for-byte; keep that full reader for
 * callers that genuinely need the complete document.
 */
export async function getCrawledUrlSourceMarkdownPage(
	parentContextId: string,
	tenant: { userId: string; organizationId?: string | null },
	page: { offset: number; maxLength: number },
): Promise<{
	content: string;
	contentLength: number;
	hasReadableText: boolean;
}> {
	const tenantClause = tenant.organizationId
		? Prisma.sql`AND "organizationId" = ${tenant.organizationId}`
		: Prisma.sql`AND "organizationId" IS NULL AND "userId" = ${tenant.userId}`;
	const [result] = await db.$queryRaw<
		Array<{
			content: string | null;
			contentLength: number | bigint;
			hasReadableText: boolean;
		}>
	>`
		WITH source AS (
			SELECT COALESCE(
				string_agg(
					concat(
							'## ',
							COALESCE(NULLIF("pageTitle", ''), "pageUrl"),
							chr(10),
							"pageUrl",
							chr(10),
							chr(10),
							content,
							chr(10)
						),
						concat(chr(10), '---', chr(10), chr(10)) ORDER BY "pageUrl"
				),
				''
			) AS body
			  FROM project_context_url_page
			 WHERE "parentContextId" = ${parentContextId}
			   ${tenantClause}
			   AND content <> ''
		)
		SELECT substring(
			body,
			${page.offset + 1}::integer,
			${page.maxLength}::integer
		) AS content,
		       length(body)::integer AS "contentLength",
		       body ~ ${HAS_NON_WHITESPACE} AS "hasReadableText"
		  FROM source
	`;
	return {
		content: result?.content ?? "",
		contentLength: Number(result?.contentLength ?? 0),
		hasReadableText: result?.hasReadableText ?? false,
	};
}

/**
 * Update context
 *
 * A `content` write carries its `contentHash` (Fizzy #2619); leaving the old
 * hash in place would keep the row matched against content it no longer holds.
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
		data: {
			...data,
			...(data.content !== undefined
				? { contentHash: contextContentHashOrNull(data.content) }
				: {}),
		},
	});
}

/**
 * The two user-editable metadata fields of a context source (Fizzy #1888):
 * the type label and the free-text AI instructions. Nothing else on a context
 * row is editable after creation, by any surface.
 */
export interface ContextMetadataValues {
	sourceType: string | null;
	aiInstructions: string | null;
}

export type ContextMetadataField = keyof ContextMetadataValues;

const CONTEXT_METADATA_FIELDS: readonly ContextMetadataField[] = [
	"sourceType",
	"aiInstructions",
];

/**
 * The single stored representation of a metadata value: trimmed, and blank
 * stored as NULL. Applied to what is written AND to both sides of the
 * compare-and-swap, so `""`, `"  "` and `null` are one value everywhere —
 * a caller that read `null` never conflicts with a row that happens to hold
 * a legacy `""`.
 */
export function normalizeContextMetadataValue(
	value: string | null | undefined,
): string | null {
	if (value === null || value === undefined) {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

/**
 * What a metadata write reads back: the two fields, who last set them and
 * when, and the title fields a caller needs to name the row (in an audit
 * row or a realtime event) without ever reading `content`.
 */
const CONTEXT_METADATA_SELECT = {
	id: true,
	projectId: true,
	type: true,
	sourceTitle: true,
	originalFilename: true,
	metadata: true,
	sourceType: true,
	aiInstructions: true,
	metadataUpdatedAt: true,
	metadataUpdatedByUserId: true,
	updatedAt: true,
} satisfies Prisma.ProjectContextSelect;

export type ContextMetadataRow = Prisma.ProjectContextGetPayload<{
	select: typeof CONTEXT_METADATA_SELECT;
}>;

export type UpdateContextMetadataResult =
	/** No such context in this project and tenant. Nothing was written. */
	| { status: "not-found" }
	/**
	 * The row no longer holds the values the caller said it read — someone
	 * else saved in between. Nothing was written; `current` is what is there
	 * now, so the caller can re-read and decide.
	 */
	| { status: "stale"; current: ContextMetadataRow }
	/**
	 * The patch would store exactly what is already stored (after
	 * normalisation), or supplied no field at all. Nothing was written and
	 * nothing is stamped: "last edited" means an edit happened. Returned even
	 * when `expected` is out of date, because the requested end state already
	 * holds — so a retried call succeeds instead of reporting a conflict.
	 */
	| { status: "unchanged"; context: ContextMetadataRow }
	| {
			status: "updated";
			context: ContextMetadataRow;
			/** The normalised values the write replaced. */
			before: ContextMetadataValues;
			/** The normalised values now stored. */
			after: ContextMetadataValues;
			/** Fields whose stored value actually changed. Never empty. */
			changed: ContextMetadataField[];
	  };

/**
 * Edit a context source's type label and AI instructions — the ONE write
 * behind both the Context tab's source-details dialog
 * (`projects.contexts.updateMetadata`) and the `fabric_update_project_context`
 * MCP tool, so the two cannot drift on what `null` means or what gets stamped.
 *
 * Semantics:
 *  - `undefined` leaves a field untouched; `null` (or blank) clears it.
 *  - `expected`, when given, is a compare-and-swap: the values the caller
 *    read. If the row no longer holds them (compared after normalisation) the
 *    result is `stale` and nothing is written — unless the row already holds
 *    the requested end state, which is `unchanged` (an idempotent retry).
 *    Omitting it skips the comparison — the oRPC path's compatibility mode
 *    for older clients; the MCP tool always passes it.
 *  - Every successful write stamps `metadataUpdatedAt` and
 *    `metadataUpdatedByUserId` (the caller's `tenant.userId`).
 *  - No re-embed and no re-summarise: both fields are read live at retrieval
 *    time, so an edit takes effect on the next AI invocation.
 *
 * TENANT ISOLATION: the row is found under the same exclusive tenant filter
 * as `getContextById`'s scoped form, plus `projectId` as the IDOR guard, and
 * the write repeats that filter. Authorization (the caller's CONTEXT_UPDATE on
 * the project) is the CALLER's job and must happen before this is reached.
 *
 * Concurrency: the write is a conditional `updateMany` keyed on the exact
 * values read inside this transaction, and a zero count means a concurrent
 * save landed first — reported as `stale`, never overwritten. So `before` is
 * exactly what the write replaced even on the compatibility path, which is
 * what makes the audit row's before/after trustworthy.
 */
export async function updateContextMetadata(
	contextId: string,
	projectId: string,
	tenant: { userId: string; organizationId?: string | null },
	patch: { sourceType?: string | null; aiInstructions?: string | null },
	options: { expected?: ContextMetadataValues } = {},
): Promise<UpdateContextMetadataResult> {
	const tenantFilter = tenant.organizationId
		? { organizationId: tenant.organizationId }
		: { organizationId: null, userId: tenant.userId };
	const scope = { id: contextId, projectId, ...tenantFilter };

	return await db.$transaction(
		async (tx): Promise<UpdateContextMetadataResult> => {
			const existing = await tx.projectContext.findFirst({
				where: scope,
				select: CONTEXT_METADATA_SELECT,
			});
			if (!existing) {
				return { status: "not-found" };
			}

			const before: ContextMetadataValues = {
				sourceType: normalizeContextMetadataValue(existing.sourceType),
				aiInstructions: normalizeContextMetadataValue(
					existing.aiInstructions,
				),
			};

			const data: Partial<ContextMetadataValues> = {};
			for (const field of CONTEXT_METADATA_FIELDS) {
				if (patch[field] !== undefined) {
					data[field] = normalizeContextMetadataValue(patch[field]);
				}
			}
			const after: ContextMetadataValues = { ...before, ...data };
			const changed = CONTEXT_METADATA_FIELDS.filter(
				(field) => after[field] !== before[field],
			);
			// Checked BEFORE the compare-and-swap: when the row already holds
			// the requested end state there is nothing to protect. This is what
			// makes a retry idempotent — a caller whose first attempt landed but
			// whose response was lost re-sends its old `expected`, and must be
			// told "done", not "someone else changed this".
			if (changed.length === 0) {
				return { status: "unchanged", context: existing };
			}

			const { expected } = options;
			if (
				expected &&
				CONTEXT_METADATA_FIELDS.some(
					(field) =>
						normalizeContextMetadataValue(expected[field]) !==
						before[field],
				)
			) {
				return { status: "stale", current: existing };
			}

			const { count } = await tx.projectContext.updateMany({
				// Keyed on the RAW values read above, not the normalised ones:
				// equality has to hold against what is physically stored.
				where: {
					...scope,
					sourceType: existing.sourceType,
					aiInstructions: existing.aiInstructions,
				},
				data: {
					...data,
					metadataUpdatedAt: new Date(),
					metadataUpdatedByUserId: tenant.userId,
				},
			});
			if (count === 0) {
				const current = await tx.projectContext.findFirst({
					where: scope,
					select: CONTEXT_METADATA_SELECT,
				});
				return current
					? { status: "stale", current }
					: { status: "not-found" };
			}

			const context = await tx.projectContext.findFirstOrThrow({
				where: scope,
				select: CONTEXT_METADATA_SELECT,
			});
			return { status: "updated", context, before, after, changed };
		},
	);
}

/**
 * What a synced-file write reads back (Fizzy #2616): the key, the hash, who
 * last changed the content and when, and the title fields a caller needs to
 * name the row. Never `content` — a caller that wants the body reads it with
 * the existing get procedure or tool.
 */
const SYNCED_CONTEXT_SELECT = {
	id: true,
	projectId: true,
	type: true,
	sourceTitle: true,
	originalFilename: true,
	metadata: true,
	sourcePath: true,
	contentHash: true,
	contentUpdatedAt: true,
	contentUpdatedByUserId: true,
	updatedAt: true,
} satisfies Prisma.ProjectContextSelect;

export type SyncedContextRow = Prisma.ProjectContextGetPayload<{
	select: typeof SYNCED_CONTEXT_SELECT;
}>;

/**
 * The stored version a conflicting push lost to. The last writer is named by
 * id only at this layer; the API layer resolves a display name.
 */
export interface SyncedContextContentStamp {
	contextId: string;
	contentHash: string | null;
	contentUpdatedAt: Date | null;
	contentUpdatedByUserId: string | null;
}

/**
 * Why a move (`movedFromSourcePath`, Fizzy #2636) was not applied as a
 * rename. Every one leaves the row at the old path exactly as it was:
 *  - `source-changed` — the old path holds a version other than the one the
 *    caller named; the answer is a conflict whose `current` is that row;
 *  - `source-missing` — no row at the old path (deleted, or already moved);
 *    the new path got the ordinary answer;
 *  - `target-exists` — the new path already has its own row, and the old
 *    row is still there; the new path got the ordinary answer, naming no
 *    version, since the caller's hash was for the old path;
 *  - `content-differs` — the old path holds the named version but the
 *    content sent is different, and a move never replaces content; the new
 *    path got the ordinary answer.
 */
export type SyncedContextMoveNotAppliedReason =
	| "source-changed"
	| "source-missing"
	| "target-exists"
	| "content-differs";

export interface SyncedContextMoveNotApplied {
	/** The old path the caller asked to move from, normalized. */
	movedFromSourcePath: string;
	reason: SyncedContextMoveNotAppliedReason;
}

/** Present on every non-`moved` answer to a call that asked for a move. */
interface MoveAnnotation {
	moveNotApplied?: SyncedContextMoveNotApplied;
}

export type UpsertContextBySourcePathResult =
	/** A new row at this path. The caller starts its embedding. */
	| ({ status: "created"; context: SyncedContextRow } & MoveAnnotation)
	/** The row at this path now holds the new content; re-embed it. */
	| {
			status: "updated";
			context: SyncedContextRow;
			/** The hash of the content this write replaced. */
			previousHash: string;
	  }
	/**
	 * The row at this path already holds exactly this content. Nothing was
	 * written or stamped. Checked before `expectedContentHash`, so a retry
	 * whose first attempt landed succeeds instead of reporting a conflict.
	 */
	| ({ status: "unchanged"; context: SyncedContextRow } & MoveAnnotation)
	/**
	 * No row at this path, but this exact content is already in the project
	 * under another hashed row. Nothing was created; `existing` is that row.
	 */
	| ({ status: "duplicate"; existing: SyncedContextRow } & MoveAnnotation)
	/**
	 * Nothing was written, because the caller's view of this path is stale:
	 *  - `current` is the stored row when it holds different content and the
	 *    caller did not name its hash as `expectedContentHash`;
	 *  - `current` is `null` when the caller named a hash but no row is at
	 *    this path any more — it was deleted since the caller last saw it,
	 *    and recreating it silently would undo that deletion. Sending again
	 *    without `expectedContentHash` recreates it.
	 * With `moveNotApplied.reason === "source-changed"`, `current` is the row
	 * at the OLD path instead (Fizzy #2636).
	 */
	| ({
			status: "conflict";
			current: SyncedContextContentStamp | null;
	  } & MoveAnnotation)
	/**
	 * The row at `movedFromSourcePath` now lives at this path: same row, same
	 * content, new key (Fizzy #2636). The caller re-embeds it, because the
	 * index carries the path and the title.
	 */
	| {
			status: "moved";
			context: SyncedContextRow;
			movedFromSourcePath: string;
	  };

export interface UpsertContextBySourcePathInput {
	projectId: string;
	/** Already normalized with `normalizeContextSourcePath`. */
	sourcePath: string;
	content: string;
	/** Stored as `metadata.title`, which the Context tab shows first. */
	title: string;
	/**
	 * The hash of the stored version the caller means to replace. Absent
	 * means "create if absent, otherwise only accept identical content" — it
	 * NEVER means "overwrite". With `movedFromSourcePath`, the hash of the
	 * version at the OLD path the caller last saw.
	 */
	expectedContentHash?: string | null;
	/**
	 * The path this file used to have, already normalized and different from
	 * `sourcePath` (Fizzy #2636). The row there is renamed to `sourcePath`
	 * when it still holds `expectedContentHash` and `content` is that same
	 * version; see `upsertContextBySourcePath` for every other case.
	 */
	movedFromSourcePath?: string | null;
	userId: string;
	organizationId?: string | null;
}

function toContentStamp(row: SyncedContextRow): SyncedContextContentStamp {
	return {
		contextId: row.id,
		contentHash: row.contentHash,
		contentUpdatedAt: row.contentUpdatedAt,
		contentUpdatedByUserId: row.contentUpdatedByUserId,
	};
}

function isUniqueViolation(error: unknown): boolean {
	return (error as { code?: unknown } | null)?.code === "P2002";
}

/**
 * Create, update, or leave alone the context row a synced knowledge file maps
 * to — the ONE write behind `projects.contexts.upsertSyncedFile` and the
 * `fabric_upsert_project_context` MCP tool (Fizzy #2616).
 *
 * The row is keyed by `projectId` + `sourcePath`, under the same exclusive
 * tenant filter as `getContextById`'s scoped form: organization rows by
 * organization alone (every member of the project sees and updates the same
 * row), personal rows by `organizationId: null` AND the user. The two arms are
 * never OR-ed, and a row in another project at the same path is never read.
 *
 * Decision order, all inside one transaction:
 *  1. Row at this path holds the same hash → `unchanged`. Before anything
 *     looks at `expectedContentHash`, so an idempotent retry succeeds.
 *  2. Row holds different content and `expectedContentHash` is absent or is
 *     not the stored hash → `conflict`, nothing written. A caller may only
 *     replace content it has seen, so two people pushing different versions
 *     of one path get a conflict, never a silent clobber.
 *  3. Row holds different content and the caller named the stored hash → a
 *     conditional `updateMany` keyed on that hash. Zero rows means a
 *     concurrent replace landed first: re-read and report `conflict` (or
 *     `unchanged`, if it happened to store this very content).
 *  4. No row at this path and the caller named an `expectedContentHash` →
 *     `conflict` with `current: null`: the version the caller means to
 *     replace was deleted since it last saw it, and a create would undo that
 *     deletion. Nothing is written.
 *  5. No row at this path and no hash named → identical content under
 *     another hashed row in the project is a `duplicate`; otherwise
 *     `create`.
 *
 * A concurrent first push of the same path loses on the
 * `(projectId, sourcePath)` unique index; the whole decision is then re-run
 * once, and answers from the winner's row.
 *
 * ## A move (`movedFromSourcePath`, Fizzy #2636)
 *
 * Checked before the steps above, under the same tenant filter for BOTH
 * paths, so a row in another project or tenant at the old path is never
 * renamed or named:
 *  a. The new path already has a row → the move is ignored and that row gets
 *     steps 1–3 with NO expected hash (the caller's hash named the old path's
 *     version, not this one): `unchanged` or `conflict`. The old row is left
 *     alone (`target-exists`), or reported gone (`source-missing`).
 *  b. No row at the old path → step 5 at the new path (`source-missing`):
 *     nothing was named for replacement there, so it is not a conflict.
 *  c. The old path holds another version than `expectedContentHash` →
 *     `conflict` whose `current` is the OLD row (`source-changed`).
 *  d. The old path holds the named version but `content` differs → step 5 at
 *     the new path (`content-differs`); the old row is left. A move never
 *     replaces content in the same call.
 *  e. Otherwise the row is renamed in place by a conditional `updateMany`
 *     keyed on its id, the project, the tenant, the old path and the stored
 *     hash, stamping the content pair as a replace does, clearing
 *     `embeddedAt` (the index carries the path), and taking the new file
 *     name as its title when its title was the old file name. Zero rows means
 *     it changed or went since the read: re-read → c or b. A concurrent push
 *     creating the new path loses the rename to the unique index; the re-run
 *     then answers a.
 *
 * Content writes stamp `contentUpdatedAt` / `contentUpdatedByUserId`, never
 * the metadata edit's pair, and clear `embeddedAt` on replace so the row reads
 * as not yet indexed until the caller's re-embed lands. Authorization is the
 * CALLER's job and must happen before this is reached.
 */
export async function upsertContextBySourcePath(
	input: UpsertContextBySourcePathInput,
): Promise<UpsertContextBySourcePathResult> {
	try {
		return await runUpsertContextBySourcePath(input);
	} catch (error) {
		if (!isUniqueViolation(error)) {
			throw error;
		}
		// Both requests found no row and both inserted; the other one won.
		// Its row is committed now, so the re-run finds it at step 1-3.
		return await runUpsertContextBySourcePath(input);
	}
}

async function runUpsertContextBySourcePath(
	input: UpsertContextBySourcePathInput,
): Promise<UpsertContextBySourcePathResult> {
	const { projectId, sourcePath, content, title, userId } = input;
	const tenantFilter = input.organizationId
		? { organizationId: input.organizationId }
		: { organizationId: null, userId };
	const pathScope = { projectId, sourcePath, ...tenantFilter };
	const newHash = hashContextContent(content);

	return await db.$transaction(
		async (tx): Promise<UpsertContextBySourcePathResult> => {
			const createOrReportDuplicate =
				async (): Promise<UpsertContextBySourcePathResult> => {
					// Dedup sees only rows that carry a hash. Every content write
					// stamps one (Fizzy #2619), including manual uploads once
					// their extraction lands; rows written before that carry
					// none until `backfill:context-content-hash` has run.
					const duplicate = await tx.projectContext.findFirst({
						where: {
							projectId,
							contentHash: newHash,
							...tenantFilter,
						},
						select: SYNCED_CONTEXT_SELECT,
					});
					if (duplicate) {
						return { status: "duplicate", existing: duplicate };
					}
					const context = await tx.projectContext.create({
						data: {
							projectId,
							type: "TEXT",
							content,
							sourcePath,
							contentHash: newHash,
							contentUpdatedAt: new Date(),
							contentUpdatedByUserId: userId,
							metadata: { title, sourcePath },
							userId,
							organizationId: input.organizationId ?? null,
						},
						select: SYNCED_CONTEXT_SELECT,
					});
					return { status: "created", context };
				};

			/** Steps 1–3, for the row at this path, against `expected`. */
			const answerExistingRow = async (
				existing: SyncedContextRow,
				expected: string | null | undefined,
			): Promise<UpsertContextBySourcePathResult> => {
				if (existing.contentHash === newHash) {
					return { status: "unchanged", context: existing };
				}

				const storedHash = existing.contentHash;
				if (
					storedHash === null ||
					!expected ||
					expected !== storedHash
				) {
					return {
						status: "conflict",
						current: toContentStamp(existing),
					};
				}

				const { count } = await tx.projectContext.updateMany({
					where: {
						id: existing.id,
						projectId,
						...tenantFilter,
						contentHash: storedHash,
					},
					data: {
						content,
						contentHash: newHash,
						contentUpdatedAt: new Date(),
						contentUpdatedByUserId: userId,
						metadata: {
							...metadataObject(existing.metadata),
							title,
							sourcePath,
						},
						embeddedAt: null,
					},
				});
				if (count === 0) {
					const current = await tx.projectContext.findFirst({
						where: pathScope,
						select: SYNCED_CONTEXT_SELECT,
					});
					if (!current) {
						// Deleted between the read and the write. The caller
						// named the version it replaces, so this is step 4,
						// not a create.
						return { status: "conflict", current: null };
					}
					if (current.contentHash === newHash) {
						return { status: "unchanged", context: current };
					}
					return {
						status: "conflict",
						current: toContentStamp(current),
					};
				}

				const context = await tx.projectContext.findFirstOrThrow({
					where: { id: existing.id, projectId, ...tenantFilter },
					select: SYNCED_CONTEXT_SELECT,
				});
				return { status: "updated", context, previousHash: storedHash };
			};

			const existing = await tx.projectContext.findFirst({
				where: pathScope,
				select: SYNCED_CONTEXT_SELECT,
			});

			const movedFrom = input.movedFromSourcePath ?? null;
			if (movedFrom !== null) {
				const sourceScope = {
					projectId,
					sourcePath: movedFrom,
					...tenantFilter,
				};
				const readSource = () =>
					tx.projectContext.findFirst({
						where: sourceScope,
						select: SYNCED_CONTEXT_SELECT,
					});
				const notApplied = async (
					reason: SyncedContextMoveNotAppliedReason,
					answer: Promise<UpsertContextBySourcePathResult>,
				): Promise<UpsertContextBySourcePathResult> => {
					const result = await answer;
					return result.status === "moved" ||
						result.status === "updated"
						? result
						: {
								...result,
								moveNotApplied: {
									movedFromSourcePath: movedFrom,
									reason,
								},
							};
				};

				const source = await readSource();
				// (a) The new path is already somebody's row: the hash named
				// the old path, so the new one is answered naming none.
				if (existing) {
					return await notApplied(
						source ? "target-exists" : "source-missing",
						answerExistingRow(existing, undefined),
					);
				}
				// (b) Nothing to move: the new path is an ordinary new file.
				if (!source) {
					return await notApplied(
						"source-missing",
						createOrReportDuplicate(),
					);
				}
				// (c) The old path changed since the caller saw it.
				if (
					source.contentHash === null ||
					source.contentHash !== input.expectedContentHash
				) {
					return {
						status: "conflict",
						current: toContentStamp(source),
						moveNotApplied: {
							movedFromSourcePath: movedFrom,
							reason: "source-changed",
						},
					};
				}
				// (d) A move never replaces content in the same call.
				if (source.contentHash !== newHash) {
					return await notApplied(
						"content-differs",
						createOrReportDuplicate(),
					);
				}

				// (e) The rename. A P2002 here (the new path was created
				// concurrently) aborts the transaction; the caller's single
				// re-run then finds that row and answers (a).
				const storedMetadata = metadataObject(source.metadata);
				const storedTitle = storedMetadata.title;
				const { count } = await tx.projectContext.updateMany({
					where: {
						id: source.id,
						...sourceScope,
						contentHash: source.contentHash,
					},
					data: {
						sourcePath,
						contentUpdatedAt: new Date(),
						contentUpdatedByUserId: userId,
						metadata: {
							...storedMetadata,
							title:
								typeof storedTitle === "string" &&
								storedTitle !== pathBasename(movedFrom)
									? storedTitle
									: pathBasename(sourcePath),
							sourcePath,
						},
						// The index carries the path and the title: the row
						// reads as not yet indexed until the re-embed lands.
						embeddedAt: null,
					},
				});
				if (count === 0) {
					const current = await readSource();
					if (!current) {
						return await notApplied(
							"source-missing",
							createOrReportDuplicate(),
						);
					}
					return {
						status: "conflict",
						current: toContentStamp(current),
						moveNotApplied: {
							movedFromSourcePath: movedFrom,
							reason: "source-changed",
						},
					};
				}
				const context = await tx.projectContext.findFirstOrThrow({
					where: { id: source.id, projectId, ...tenantFilter },
					select: SYNCED_CONTEXT_SELECT,
				});
				return {
					status: "moved",
					context,
					movedFromSourcePath: movedFrom,
				};
			}

			if (!existing) {
				if (input.expectedContentHash) {
					return { status: "conflict", current: null };
				}
				return await createOrReportDuplicate();
			}
			return await answerExistingRow(existing, input.expectedContentHash);
		},
	);
}

/** A synced row as the delete reads it: the index cleanup needs `qdrantId`. */
const SYNCED_CONTEXT_DELETE_SELECT = {
	...SYNCED_CONTEXT_SELECT,
	qdrantId: true,
} satisfies Prisma.ProjectContextSelect;

export type SyncedContextDeleteRow = Prisma.ProjectContextGetPayload<{
	select: typeof SYNCED_CONTEXT_DELETE_SELECT;
}>;

/**
 * The version a compare-and-set delete names: a path in a project, under one
 * tenant arm, holding one hash.
 */
export interface SyncedContextDeletionTarget {
	projectId: string;
	/** Already normalized with `normalizeContextSourcePath`. */
	sourcePath: string;
	/** The `contentHash` of the version the caller means to delete. */
	expectedContentHash: string;
	userId: string;
	organizationId?: string | null;
}

function syncedContextDeletionScope(
	input: Omit<SyncedContextDeletionTarget, "expectedContentHash">,
) {
	const tenantFilter = input.organizationId
		? { organizationId: input.organizationId }
		: { organizationId: null, userId: input.userId };
	return {
		tenantFilter,
		pathScope: {
			projectId: input.projectId,
			sourcePath: input.sourcePath,
			...tenantFilter,
		},
	};
}

/**
 * The id of the synced row at a path, or `null` — the read that names a
 * compare-and-set delete before it starts (the deletion workflow's id is
 * derived from it). Advisory only: the claim re-reads and compares.
 *
 * The same exclusive tenant filter as the claim; a pathless (manual) row is
 * never matched, because the path is part of the filter.
 */
export async function findSyncedContextIdAtPath(
	input: Omit<SyncedContextDeletionTarget, "expectedContentHash">,
): Promise<string | null> {
	const { pathScope } = syncedContextDeletionScope(input);
	const row = await db.projectContext.findFirst({
		where: pathScope,
		select: { id: true, sourcePath: true },
	});
	return row && row.sourcePath === input.sourcePath ? row.id : null;
}

export type ClaimSyncedContextRowForDeletionResult =
	/**
	 * The row holds the named version and is now marked unindexed
	 * (`embeddedAt: null`), so whatever happens to its points next, the row
	 * never claims an index it may no longer have.
	 */
	| { status: "claimed"; context: SyncedContextDeleteRow }
	/**
	 * No synced row at this path: deleted already (a retry whose first
	 * attempt landed hears this), or never pushed. Nothing was changed.
	 */
	| { status: "absent" }
	/**
	 * The path holds a version other than the one named, or one with no
	 * hash, which nobody can name. Nothing was changed; `current` says whose.
	 */
	| { status: "conflict"; current: SyncedContextContentStamp };

/**
 * Step 1 of the compare-and-set delete behind `fabric context push --prune`
 * (Fizzy #2636): check that the path still holds the named version, and
 * claim it by clearing `embeddedAt` in the same guarded write.
 *
 * The row is found by `projectId` + `sourcePath` under the same exclusive
 * tenant filter as `upsertContextBySourcePath`. Only a synced row has a path,
 * so a row added in the Context tab is never reachable here, whatever it
 * holds. The claim is an `updateMany` keyed on the id, the project, the
 * tenant, the path and the named hash — the replace's guard shape — so a push
 * that lands between the read and the claim makes it match nothing, and the
 * answer comes from a re-read.
 *
 * Why the claim writes `embeddedAt: null`: the next step removes the row's
 * points from the vector index, and the one after deletes the row. If the
 * process stops between those two, the row must not go on saying it is
 * indexed when it is not; unindexed, it is what `projects.contexts.embed`
 * picks up, and a retry of the delete finishes the job. Repeating the claim
 * is harmless: the row still matches, and `embeddedAt` is already null.
 *
 * Authorization is the CALLER's job and must happen before this is reached.
 */
export async function claimSyncedContextRowForDeletion(
	input: SyncedContextDeletionTarget,
): Promise<ClaimSyncedContextRowForDeletionResult> {
	const { pathScope } = syncedContextDeletionScope(input);
	const { sourcePath, expectedContentHash } = input;

	const row = await db.projectContext.findFirst({
		where: pathScope,
		select: SYNCED_CONTEXT_DELETE_SELECT,
	});
	// The path is part of the filter, so a pathless (manual) row cannot be
	// read here; the check keeps that true if the filter ever changes.
	if (!row || row.sourcePath !== sourcePath) {
		return { status: "absent" };
	}
	if (row.contentHash === null || row.contentHash !== expectedContentHash) {
		return { status: "conflict", current: toContentStamp(row) };
	}

	const { count } = await db.projectContext.updateMany({
		where: { id: row.id, ...pathScope, contentHash: expectedContentHash },
		data: { embeddedAt: null },
	});
	if (count > 0) {
		return { status: "claimed", context: row };
	}

	// Changed, moved or deleted between the read and the claim.
	const current = await db.projectContext.findFirst({
		where: pathScope,
		select: SYNCED_CONTEXT_SELECT,
	});
	return current
		? { status: "conflict", current: toContentStamp(current) }
		: { status: "absent" };
}

export type DeleteClaimedSyncedContextRowResult =
	/**
	 * The claimed row held the named version and is deleted, with its audit
	 * row: by this call, or by an earlier attempt of the same operation that
	 * committed before its answer was lost (its receipt is found).
	 */
	| { status: "deleted" }
	/**
	 * No row is left under the claimed id, and no receipt of this operation:
	 * somebody else deleted the row after the claim (the Context tab's delete,
	 * or another request). This call deleted and recorded nothing.
	 */
	| { status: "gone" }
	/**
	 * The claimed row still exists but no longer at this path (moved after
	 * the claim), and nothing else is at the path. Nothing was deleted;
	 * `reindex` is the row whose points the caller removed, to rebuild.
	 */
	| { status: "absent"; reindex: SyncedContextRow }
	/**
	 * The claimed row changed (or moved and something else took the path)
	 * after the claim. Nothing was deleted; `current` is the version at the
	 * path, `reindex` the claimed row whose points the caller removed.
	 */
	| {
			status: "conflict";
			current: SyncedContextContentStamp;
			reindex: SyncedContextRow;
	  };

export interface DeleteClaimedSyncedContextRowInput
	extends SyncedContextDeletionTarget {
	/** The claimed row. */
	contextId: string;
	/**
	 * This delete's operation id — the deletion workflow's id, the same on
	 * every attempt and every request that joins it. Stored as the audit
	 * row's `metadata.operationId`: the receipt a repeat looks for.
	 */
	operationId: string;
	/** The claimed row's name, recorded as the audit row's resource name. */
	title: string;
	/** The request the delete came from, for the audit row. */
	audit: SyncedContextDeletionAuditContext;
}

/**
 * Step 3 of the compare-and-set delete, after the caller removed the claimed
 * row's points from the vector index: delete the row, with the claim's guard
 * — the id, the project, the tenant, the path and the named hash — so a
 * version pushed after the claim is never deleted unseen.
 *
 * The audit row is the delete's durable receipt. One transaction holds the
 * guarded `deleteMany` and, when it deleted the row, the insert of the
 * `project.context_source.synced_file_deleted` row keyed by `operationId`
 * (`recordAuditTx`): the row is never gone without its audit row, whatever
 * happens to the process that asked, and a failed insert rolls the delete
 * back, so the activity's retry deletes and records again.
 *
 * Safe to repeat. When the delete matches nothing and no row is left under
 * the id, the receipt tells the two causes apart: this operation's audit row,
 * under the same tenant and project, means an earlier attempt committed
 * (`deleted`, and no second row); none means somebody else deleted it
 * (`gone`). If the row is still there, it changed or moved after the claim,
 * and it is handed back so its points (which the caller removed) can be
 * rebuilt; nothing is recorded.
 *
 * The receipt lookup filters on the action, the project, the tenant, the row
 * and `metadata.operationId`; the existing `(action, createdAt)` and
 * `(projectId, createdAt)` indexes bound it to this action's rows, and it
 * runs only on the rare path where the row is already gone.
 *
 * Authorization is the CALLER's job and must happen before this is reached.
 */
export async function deleteClaimedSyncedContextRow(
	input: DeleteClaimedSyncedContextRowInput,
): Promise<DeleteClaimedSyncedContextRowResult> {
	const { pathScope, tenantFilter } = syncedContextDeletionScope(input);

	return await db.$transaction(
		async (tx): Promise<DeleteClaimedSyncedContextRowResult> => {
			const { count } = await tx.projectContext.deleteMany({
				where: {
					id: input.contextId,
					...pathScope,
					contentHash: input.expectedContentHash,
				},
			});
			if (count > 0) {
				// The snapshots are read here, at write time (the workflow's
				// history carries only the user's id). A user deleted since the
				// request is recorded by no id rather than failing the insert.
				const user = await tx.user.findUnique({
					where: { id: input.userId },
					select: { email: true, name: true },
				});
				await recordAuditTx(
					tx,
					buildSyncedContextDeleteAuditEvent({
						organizationId: input.organizationId,
						projectId: input.projectId,
						contextId: input.contextId,
						title: input.title,
						sourcePath: input.sourcePath,
						contentHash: input.expectedContentHash,
						operationId: input.operationId,
						actor: {
							userId: user ? input.userId : null,
							emailSnapshot: user?.email ?? null,
							nameSnapshot: user?.name ?? null,
						},
						audit: input.audit,
					}),
				);
				return { status: "deleted" };
			}

			const survivor = await tx.projectContext.findFirst({
				where: {
					id: input.contextId,
					projectId: input.projectId,
					...tenantFilter,
				},
				select: SYNCED_CONTEXT_SELECT,
			});
			if (!survivor) {
				const receipt = await tx.auditLog.findFirst({
					where: {
						action: SYNCED_CONTEXT_DELETE_AUDIT_ACTION,
						projectId: input.projectId,
						...tenantFilter,
						resourceType: "project_context",
						resourceId: input.contextId,
						metadata: {
							path: ["operationId"],
							equals: input.operationId,
						},
					},
					select: { id: true },
				});
				return receipt ? { status: "deleted" } : { status: "gone" };
			}
			const current = await tx.projectContext.findFirst({
				where: pathScope,
				select: SYNCED_CONTEXT_SELECT,
			});
			return current
				? {
						status: "conflict",
						current: toContentStamp(current),
						reindex: survivor,
					}
				: { status: "absent", reindex: survivor };
		},
	);
}

/** A row's `metadata` as an object to spread, or an empty one. */
function metadataObject(metadata: Prisma.JsonValue): Prisma.JsonObject {
	return metadata && typeof metadata === "object" && !Array.isArray(metadata)
		? (metadata as Prisma.JsonObject)
		: {};
}

/** The last segment of a normalized source path. */
function pathBasename(sourcePath: string): string {
	return sourcePath.slice(sourcePath.lastIndexOf("/") + 1);
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
