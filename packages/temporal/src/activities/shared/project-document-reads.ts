/**
 * Shared implementation of the chat's live reads of a project's documents and
 * Context-tab sources: `fabric_list_project_documents`,
 * `fabric_get_project_document`, `fabric_list_project_sources` and
 * `fabric_get_project_source`.
 *
 * Same pattern as `project-feature-reads.ts`, which explains it in full: both
 * chat engines bind these — Direct through the built-in tool factory, the
 * orchestrator through the Fabric catalog adapter — so the access rule, the
 * filters and the response shape live here once. Without them "list the
 * documents in this project" was answered by eighteen semantic searches and a
 * guessed list, and the Context tab's files could only be sampled (Fizzy
 * #2578).
 *
 * The queries are the ones the external MCP gateway's `fabric_list_documents`
 * / `fabric_get_document` / `fabric_list_project_contexts` /
 * `fabric_get_project_context` use, and a source row is presented by the same
 * helpers, behind the same session-path access rule,
 * `getProjectAccessContext`. The names differ from the gateway's on purpose:
 * a user who has connected Fabric's own MCP server exposes those names too,
 * and the orchestrator keys discovered tools by bare name.
 *
 * The project is always the chat's attached project, never a model argument.
 * A get by id additionally refuses a row from any other project, even one the
 * user can open: the model reads what is attached, not what it can guess.
 */

import {
	resolveContextProvider,
	resolveContextTitle,
	resolveContextUnavailableReason,
	sliceUnicodeCharacters,
} from "@repo/database/src/project-context-presentation";
import {
	PROJECT_DOCUMENT_TYPES,
	PROJECT_SOURCE_TYPES,
} from "../../workflows/orchestrator/project-document-tool-schemas";

export const PROJECT_DOCUMENT_TOOL_IDS = [
	"fabric_list_project_documents",
	"fabric_get_project_document",
	"fabric_list_project_sources",
	"fabric_get_project_source",
] as const;

const LIST_DEFAULT_LIMIT = 25;
const LIST_MAX_LIMIT = 100;
const BODY_DEFAULT_LENGTH = 15_000;
const BODY_MAX_LENGTH = 40_000;
// PostgreSQL substring positions are int4; the crawled-page reader slices in SQL.
const BODY_MAX_OFFSET = 2_147_483_646;

type DocumentType = (typeof PROJECT_DOCUMENT_TYPES)[number];
type SourceType = (typeof PROJECT_SOURCE_TYPES)[number];

interface ProjectReadContext {
	projectId?: string;
	userId: string;
}

type ReadError = { error: string };

const NO_PROJECT: ReadError = {
	error: "No project is attached to this chat. Attach a project to read its documents and sources.",
};
const NO_ACCESS: ReadError = {
	error: "Project not found or access denied.",
};

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? Math.trunc(value)
		: undefined;
}

function readPaging(args: Record<string, unknown>): {
	limit: number;
	offset: number;
} {
	const limit = Math.min(
		Math.max(readInteger(args.limit) ?? LIST_DEFAULT_LIMIT, 1),
		LIST_MAX_LIMIT,
	);
	const offset = Math.max(readInteger(args.offset) ?? 0, 0);
	return { limit, offset };
}

function readBodyWindow(args: Record<string, unknown>): {
	offset: number;
	maxLength: number;
} {
	return {
		offset: Math.min(
			Math.max(readInteger(args.offset) ?? 0, 0),
			BODY_MAX_OFFSET,
		),
		maxLength: Math.min(
			Math.max(readInteger(args.maxLength) ?? BODY_DEFAULT_LENGTH, 1),
			BODY_MAX_LENGTH,
		),
	};
}

function readEnum<T extends string>(
	value: unknown,
	allowed: readonly T[],
	name: string,
): { value?: T } | ReadError {
	const raw = readString(value);
	if (!raw) {
		return {};
	}
	const upper = raw.toUpperCase();
	if (!allowed.includes(upper as T)) {
		return { error: `${name} must be one of ${allowed.join(", ")}.` };
	}
	return { value: upper as T };
}

/** The project's hosting organization, or null when the user cannot read it. */
async function resolveProjectAccess(
	projectId: string,
	userId: string,
): Promise<{ organizationId: string | null } | null> {
	const { getProjectAccessContext } = await import("@repo/database");
	return getProjectAccessContext(projectId, userId);
}

interface ListTotals {
	noun: [singular: string, plural: string];
	where: string;
	total: number;
	shown: number;
	offset: number;
	filtered: boolean;
	hasMore: boolean;
	/** Sources only: code-index entries the default leaves out. */
	excludedCodeContexts?: number;
}

/**
 * One sentence the model can repeat. Without it the model reported the length
 * of the page it was shown, or a count from semantic search, as the total.
 */
function describeListTotals(totals: ListTotals): string {
	const count = (n: number) =>
		`${n} ${n === 1 ? totals.noun[0] : totals.noun[1]}`;
	const scope = totals.filtered ? " matching these filters" : "";
	const page = totals.hasMore
		? ` This page lists ${totals.shown} starting at offset ${totals.offset}; total covers every page.`
		: "";
	const code =
		totals.excludedCodeContexts && totals.excludedCodeContexts > 0
			? ` ${totals.excludedCodeContexts} repository code-index ${totals.excludedCodeContexts === 1 ? "entry is" : "entries are"} not counted (use code_search for code).`
			: "";
	return `${count(totals.total)} ${totals.where}${scope}.${page}${code}`;
}

export async function listProjectDocuments(
	args: Record<string, unknown>,
	context: ProjectReadContext,
): Promise<Record<string, unknown> | ReadError> {
	const { projectId, userId } = context;
	if (!projectId) {
		return NO_PROJECT;
	}
	if (!(await resolveProjectAccess(projectId, userId))) {
		return NO_ACCESS;
	}
	const type = readEnum<DocumentType>(
		args.type,
		PROJECT_DOCUMENT_TYPES,
		"type",
	);
	if ("error" in type) {
		return type;
	}
	const search = readString(args.search);
	const { limit, offset } = readPaging(args);

	const { listDocuments } = await import("@repo/database");
	const { documents, total } = await listDocuments({
		projectId,
		type: type.value,
		search,
		limit,
		offset,
	});
	const hasMore = offset + documents.length < total;
	return {
		summary: describeListTotals({
			noun: ["document", "documents"],
			where: "in this project's Documents tab",
			total,
			shown: documents.length,
			offset,
			filtered: Boolean(type.value || search),
			hasMore,
		}),
		documents: documents.map((doc) => ({
			id: doc.id,
			title: doc.title,
			type: doc.type,
			status: doc.status,
			version: doc.version,
			createdAt: doc.createdAt,
			updatedAt: doc.updatedAt,
		})),
		total,
		hasMore,
	};
}

const GENERATION_IN_FLIGHT = new Set(["QUEUED", "GENERATING", "IN_PROGRESS"]);

function documentUnavailableReason(doc: {
	status: string;
	generationError: string | null;
}): string {
	if (GENERATION_IN_FLIGHT.has(doc.status)) {
		return "The document is still being generated — its text is not written yet.";
	}
	if (doc.status === "FAILED") {
		return doc.generationError
			? `Generation failed: ${doc.generationError}`
			: "Generation failed for this document.";
	}
	return "The document has no text yet.";
}

export async function getProjectDocument(
	args: Record<string, unknown>,
	context: ProjectReadContext,
): Promise<Record<string, unknown> | ReadError> {
	const { projectId, userId } = context;
	if (!projectId) {
		return NO_PROJECT;
	}
	const ref = readString(args.document);
	if (!ref) {
		return {
			error: "document is required — pass an id from fabric_list_project_documents or the document's exact title.",
		};
	}
	if (!(await resolveProjectAccess(projectId, userId))) {
		return NO_ACCESS;
	}

	const { db, getDocumentById } = await import("@repo/database");
	let doc = await getDocumentById(ref);
	if (doc && doc.projectId !== projectId) {
		doc = null;
	}
	if (!doc) {
		const byTitle = await db.projectDocument.findMany({
			where: { projectId, title: { equals: ref, mode: "insensitive" } },
			select: { id: true, title: true, type: true },
			take: 5,
		});
		if (byTitle.length > 1) {
			return {
				error: `${byTitle.length} documents are titled "${ref}" in this project. Pass one id: ${byTitle.map((d) => `${d.id} (${d.type})`).join(", ")}.`,
			};
		}
		doc = byTitle[0] ? await getDocumentById(byTitle[0].id) : null;
	}
	if (!doc) {
		return {
			error: `No document "${ref}" in this project. Use fabric_list_project_documents to find it.`,
		};
	}

	const window = readBodyWindow(args);
	const body = doc.content ?? "";
	const { content, contentLength } = sliceUnicodeCharacters(
		body,
		window.offset,
		window.maxLength,
	);
	const returnedLength = Array.from(content).length;
	const truncated = window.offset + returnedLength < contentLength;
	const contentAvailable = body.trim().length > 0;
	return {
		id: doc.id,
		title: doc.title,
		type: doc.type,
		status: doc.status,
		version: doc.version,
		createdAt: doc.createdAt,
		updatedAt: doc.updatedAt,
		contentAvailable,
		...(contentAvailable
			? {}
			: { unavailableReason: documentUnavailableReason(doc) }),
		content,
		contentLength,
		offset: window.offset,
		returnedLength,
		truncated,
		...(truncated ? { nextOffset: window.offset + returnedLength } : {}),
	};
}

const SOURCE_KIND: Record<string, string> = {
	FILE: "file",
	DOCUMENT: "file",
	SPREADSHEET: "file",
	IMAGE: "file",
	LINK: "link",
	TEXT: "note",
	MEETING_TRANSCRIPT: "transcript",
	SLACK_HUDDLE_NOTES: "huddle notes",
	INTEGRATION: "integration",
	CODE_FILE: "code",
	CODE_FILE_SUMMARY: "code",
	API_SPEC: "api spec",
};

/** file / link / note / transcript / integration …, or "project record". */
function sourceKind(type: string): string {
	return SOURCE_KIND[type] ?? "project record";
}

/**
 * The gateway's reason, but an uploaded file's original is pointed at the
 * Context tab: the chat returns no presigned `originalFile` link.
 */
function sourceUnavailableReason(ctx: {
	type: string;
	metadata?: unknown;
	extractionStatus?: string | null;
	extractionError?: string | null;
}): string {
	return resolveContextUnavailableReason(
		ctx,
		"the original can be opened from the project's Context tab.",
	);
}

export async function listProjectSources(
	args: Record<string, unknown>,
	context: ProjectReadContext,
): Promise<Record<string, unknown> | ReadError> {
	const { projectId, userId } = context;
	if (!projectId) {
		return NO_PROJECT;
	}
	if (!(await resolveProjectAccess(projectId, userId))) {
		return NO_ACCESS;
	}
	const type = readEnum<SourceType>(args.type, PROJECT_SOURCE_TYPES, "type");
	if ("error" in type) {
		return type;
	}
	const search = readString(args.search);
	const { limit, offset } = readPaging(args);

	const { listProjectContextSummaries } = await import("@repo/database");
	const result = await listProjectContextSummaries({
		projectId,
		type: type.value,
		search,
		includeCodeContexts: args.includeCodeContexts === true,
		limit,
		offset,
	});
	const hasMore = offset + result.contexts.length < result.total;
	const sources = result.contexts.map((ctx) => ({
		id: ctx.id,
		title: resolveContextTitle(ctx),
		kind: sourceKind(ctx.type),
		type: ctx.type,
		source: resolveContextProvider(ctx),
		filename: ctx.originalFilename,
		sourceUrl: ctx.sourceUrl,
		extractionStatus: ctx.extractionStatus,
		contentAvailable: ctx.hasContent,
		...(ctx.hasContent
			? {}
			: { unavailableReason: sourceUnavailableReason(ctx) }),
		createdAt: ctx.createdAt,
		updatedAt: ctx.updatedAt,
	}));
	return {
		summary: describeListTotals({
			noun: ["source", "sources"],
			where: "on this project's Context tab",
			total: result.total,
			shown: result.contexts.length,
			offset,
			filtered: Boolean(type.value || search),
			hasMore,
			excludedCodeContexts: result.excludedCodeContexts,
		}),
		sources,
		total: result.total,
		hasMore,
		excludedCodeContexts: result.excludedCodeContexts,
	};
}

export async function getProjectSource(
	args: Record<string, unknown>,
	context: ProjectReadContext,
): Promise<Record<string, unknown> | ReadError> {
	const { projectId, userId } = context;
	if (!projectId) {
		return NO_PROJECT;
	}
	const ref = readString(args.source);
	if (!ref) {
		return {
			error: "source is required — pass an id from fabric_list_project_sources.",
		};
	}
	const access = await resolveProjectAccess(projectId, userId);
	if (!access) {
		return NO_ACCESS;
	}

	const { getContextById, readProjectContextBodyPage } = await import(
		"@repo/database"
	);
	const ctx = await getContextById(ref);
	if (!ctx || ctx.projectId !== projectId) {
		return {
			error: `No source "${ref}" in this project. Use fabric_list_project_sources to find it.`,
		};
	}

	// The project's hosting organization, not the chat's: an invited guest
	// works from their own organization while the child rows carry the host's.
	const page = await readProjectContextBodyPage(
		ctx,
		{ userId, organizationId: access.organizationId || null },
		readBodyWindow(args),
	);
	return {
		id: ctx.id,
		title: resolveContextTitle(ctx),
		kind: sourceKind(ctx.type),
		type: ctx.type,
		source: resolveContextProvider(ctx),
		filename: ctx.originalFilename,
		sourceUrl: ctx.sourceUrl,
		extractionStatus: ctx.extractionStatus,
		createdAt: ctx.createdAt,
		updatedAt: ctx.updatedAt,
		contentAvailable: page.hasReadableText,
		...(page.hasReadableText
			? {}
			: { unavailableReason: sourceUnavailableReason(ctx) }),
		content: page.content,
		contentLength: page.contentLength,
		offset: page.offset,
		returnedLength: page.returnedLength,
		truncated: page.truncated,
		...(page.nextOffset !== undefined
			? { nextOffset: page.nextOffset }
			: {}),
	};
}
