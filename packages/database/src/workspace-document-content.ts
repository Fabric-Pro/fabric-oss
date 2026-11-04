import { z } from "zod";

export const WORKSPACE_DOCUMENT_CONTENT_MAX_CHARACTERS = 20_000;
export const WORKSPACE_DOCUMENT_CONTENT_DEFAULT_CHARACTERS = 12_000;
const id = z.string().trim().min(1).max(200);
export const workspaceDocumentActorSchema = z
	.object({ userId: id, organizationId: id })
	.strict();
export const workspaceDocumentContentInputSchema = z
	.object({
		workspaceId: id,
		documentId: id,
		offset: z.number().int().min(0).max(2_147_483_646).default(0),
		limit: z
			.number()
			.int()
			.min(1)
			.max(WORKSPACE_DOCUMENT_CONTENT_MAX_CHARACTERS)
			.default(WORKSPACE_DOCUMENT_CONTENT_DEFAULT_CHARACTERS),
		expectedRevision: z
			.string()
			.regex(/^[a-f0-9]{64}$/)
			.optional(),
	})
	.strict();

export const workspaceDocumentCatalogInputSchema = z
	.object({
		workspaceId: id,
		offset: z.number().int().min(0).max(2147483646).default(0),
		limit: z.number().int().min(1).max(100).default(20),
	})
	.strict();

export const workspaceDocumentContentPageSchema = z.object({
	id: z.string(),
	workspaceId: z.string(),
	organizationId: z.string(),
	sourceKind: z.literal("workspace_document"),
	filename: z.string(),
	mimeType: z.string(),
	status: z.literal("READY"),
	text: z.string(),
	revision: z.string().regex(/^[a-f0-9]{64}$/),
	contentHash: z.string().regex(/^[a-f0-9]{64}$/),
	offset: z.number().int().min(0),
	limit: z.number().int().positive(),
	totalCharacters: z.number().int().min(0),
	totalBytes: z.number().int().min(0),
	nextOffset: z.number().int().min(0).nullable(),
	truncated: z.boolean(),
	offsetUnit: z.literal("unicode_code_points"),
	readMode: z.literal("direct"),
	historicalVersionsAvailable: z.literal(false),
});

export type WorkspaceDocumentContentInput = z.input<
	typeof workspaceDocumentContentInputSchema
>;
export type WorkspaceDocumentContentPage = z.infer<
	typeof workspaceDocumentContentPageSchema
>;
export interface WorkspaceDocumentContentActor {
	userId: string;
	organizationId: string;
}
export type WorkspaceDocumentContentErrorCode =
	| "INVALID_INPUT"
	| "REVISION_REQUIRED"
	| "NOT_FOUND"
	| "FORBIDDEN"
	| "NOT_READY"
	| "STALE_REVISION"
	| "OUT_OF_RANGE";
const errors: Record<
	WorkspaceDocumentContentErrorCode,
	{ status: 400 | 403 | 404 | 409; message: string }
> = {
	INVALID_INPUT: {
		status: 400,
		message:
			"Provide valid workspace/document IDs, a bounded page and a lowercase SHA-256 revision.",
	},
	REVISION_REQUIRED: {
		status: 400,
		message:
			"Continuation pages require expectedRevision from the first page. Read offset 0 first.",
	},
	NOT_FOUND: {
		status: 404,
		message: "Workspace document not found or access denied.",
	},
	FORBIDDEN: {
		status: 403,
		message:
			"Your current organization role does not permit workspace reads.",
	},
	NOT_READY: {
		status: 409,
		message:
			"Document extraction is not ready. Check its processing status in the Workspace.",
	},
	STALE_REVISION: {
		status: 409,
		message:
			"Document content changed. Restart at offset 0 before continuing.",
	},
	OUT_OF_RANGE: {
		status: 400,
		message: "The requested offset exceeds the document length.",
	},
};
export class WorkspaceDocumentContentError extends Error {
	readonly status: 400 | 403 | 404 | 409;
	constructor(readonly code: WorkspaceDocumentContentErrorCode) {
		super(errors[code].message);
		this.name = "WorkspaceDocumentContentError";
		this.status = errors[code].status;
	}
}
export interface WorkspaceDocumentPageRow {
	id: string;
	workspaceId: string;
	filename: string;
	mimeType: string;
	status: string;
	text: string | null;
	revision: string | null;
	totalCharacters: number | null;
	totalBytes: number | null;
}
interface Dependencies {
	authorize: (
		input: WorkspaceDocumentContentActor & { workspaceId: string },
	) => Promise<void>;
	readPage: (
		input: WorkspaceDocumentContentActor &
			z.output<typeof workspaceDocumentContentInputSchema>,
	) => Promise<WorkspaceDocumentPageRow | null>;
}

/** One direct-read contract; every page repeats live authorization and pins exact UTF-8 content. */
export function createWorkspaceDocumentContentReader(
	dependencies: Dependencies,
) {
	return async (
		actor: WorkspaceDocumentContentActor,
		raw: unknown,
	): Promise<WorkspaceDocumentContentPage> => {
		if (
			!id.safeParse(actor.userId).success ||
			!id.safeParse(actor.organizationId).success
		)
			throw new WorkspaceDocumentContentError("INVALID_INPUT");
		const parsed = workspaceDocumentContentInputSchema.safeParse(raw);
		if (!parsed.success)
			throw new WorkspaceDocumentContentError("INVALID_INPUT");
		const input = parsed.data;
		if (input.offset > 0 && !input.expectedRevision)
			throw new WorkspaceDocumentContentError("REVISION_REQUIRED");
		const request = { ...actor, ...input };
		await dependencies.authorize(request);
		const row = await dependencies.readPage(request);
		// A grant revoked while the asynchronous read was running must not release its body.
		await dependencies.authorize(request);
		if (
			!row ||
			row.id !== input.documentId ||
			row.workspaceId !== input.workspaceId
		)
			throw new WorkspaceDocumentContentError("NOT_FOUND");
		if (
			row.status !== "READY" ||
			row.text === null ||
			!row.revision ||
			row.totalCharacters === null ||
			row.totalBytes === null
		)
			throw new WorkspaceDocumentContentError("NOT_READY");
		if (input.expectedRevision && input.expectedRevision !== row.revision)
			throw new WorkspaceDocumentContentError("STALE_REVISION");
		if (input.offset > row.totalCharacters)
			throw new WorkspaceDocumentContentError("OUT_OF_RANGE");
		const count = Array.from(row.text).length;
		const next = input.offset + count;
		if (
			count > input.limit ||
			next > row.totalCharacters ||
			(next < row.totalCharacters && count === 0)
		)
			throw new Error("Invalid bounded workspace document page.");
		return workspaceDocumentContentPageSchema.parse({
			id: row.id,
			workspaceId: row.workspaceId,
			organizationId: actor.organizationId,
			sourceKind: "workspace_document",
			filename: row.filename,
			mimeType: row.mimeType,
			status: "READY",
			text: row.text,
			revision: row.revision,
			contentHash: row.revision,
			offset: input.offset,
			limit: input.limit,
			totalCharacters: row.totalCharacters,
			totalBytes: row.totalBytes,
			nextOffset: next < row.totalCharacters ? next : null,
			truncated: next < row.totalCharacters,
			offsetUnit: "unicode_code_points",
			readMode: "direct",
			historicalVersionsAvailable: false,
		});
	};
}
