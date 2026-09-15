/**
 * v1 Documents routes — project-scoped PRDs / specs / architecture notes /
 * other markdown documents attached to a Project.
 *
 *   GET   /projects/:projectId/documents    list (optional type filter)
 *   POST  /projects/:projectId/documents    create
 *   GET   /documents/:id                    get full content + metadata
 *   PATCH /documents/:id                    update title/content/status
 *
 * Access model: tenant-scoped via the parent Project. Reads require
 * hasProjectAccess; writes additionally require canEditProject.
 */
import {
	canEditProject,
	createDocument,
	getDocumentById,
	hasProjectAccess,
	IntegrationContractStatusManagedError,
	listDocuments,
	updateDocument,
} from "@repo/database";
import type { Hono } from "hono";
import { requireScope } from "../external-api/middleware/api-key-auth";
import type { ExternalApiVariables } from "../external-api/types";
import {
	badRequest,
	forbidden,
	notFound,
	ok,
	resolveV1Context,
} from "./helpers";

// Hand-maintained mirror of the `ProjectDocumentType` Prisma enum. It is NOT
// derived from it on purpose — this is the public v1 REST contract, so widening
// it is a deliberate act. Adding an enum value without adding it here fails
// type-check, which is the intended tripwire.
type DocumentType =
	| "GENERAL"
	| "BUSINESS_CASE"
	| "DESIGN_SYSTEM"
	| "PRD"
	| "PROPOSAL"
	| "ARCHITECTURE"
	| "TECHNICAL_SPEC"
	| "USER_STORY"
	| "API_SPEC"
	| "QA_STRATEGY"
	| "TEST_PLAN"
	| "TEST_REPORT"
	| "TRACEABILITY_MATRIX"
	| "SRS"
	| "INTEGRATION_CONTRACT";

type DocumentStatus =
	| "DRAFT"
	| "QUEUED"
	| "GENERATING"
	| "IN_PROGRESS"
	| "REVIEW"
	| "COMPLETE"
	| "FAILED";

const DOCUMENT_TYPES: ReadonlySet<DocumentType> = new Set([
	"GENERAL",
	"BUSINESS_CASE",
	"DESIGN_SYSTEM",
	"PRD",
	"PROPOSAL",
	"ARCHITECTURE",
	"TECHNICAL_SPEC",
	"USER_STORY",
	"API_SPEC",
	"QA_STRATEGY",
	"TEST_PLAN",
	"TEST_REPORT",
	"TRACEABILITY_MATRIX",
	"SRS",
	"INTEGRATION_CONTRACT",
]);

const DOCUMENT_STATUSES: ReadonlySet<DocumentStatus> = new Set([
	"DRAFT",
	"QUEUED",
	"GENERATING",
	"IN_PROGRESS",
	"REVIEW",
	"COMPLETE",
	"FAILED",
]);

function isDocumentType(v: unknown): v is DocumentType {
	return typeof v === "string" && DOCUMENT_TYPES.has(v as DocumentType);
}

function isDocumentStatus(v: unknown): v is DocumentStatus {
	return typeof v === "string" && DOCUMENT_STATUSES.has(v as DocumentStatus);
}

function mapSummary(d: {
	id: string;
	projectId: string;
	type: DocumentType;
	title: string;
	status: DocumentStatus;
	version: number;
	wordCount: number | null;
	createdAt: Date;
	updatedAt: Date;
}) {
	return {
		id: d.id,
		projectId: d.projectId,
		type: d.type,
		title: d.title,
		status: d.status,
		version: d.version,
		wordCount: d.wordCount ?? null,
		createdAt: d.createdAt.toISOString(),
		updatedAt: d.updatedAt.toISOString(),
	};
}

function mapDetail(d: {
	id: string;
	projectId: string;
	type: DocumentType;
	title: string;
	content: string;
	status: DocumentStatus;
	version: number;
	wordCount: number | null;
	createdAt: Date;
	updatedAt: Date;
}) {
	return {
		...mapSummary(d),
		content: d.content,
	};
}

export function registerDocumentRoutes(
	app: Hono<{ Variables: ExternalApiVariables }>,
) {
	/**
	 * GET /projects/:projectId/documents
	 * Lists documents attached to a project.
	 */
	app.get(
		"/projects/:projectId/documents",
		requireScope("documents:read"),
		async (c) => {
			const apiCtx = c.get("externalApiContext");
			const ctx = await resolveV1Context(
				apiCtx,
				c.req.query("org"),
				c.req.query("personal") === "1",
			);
			if ("error" in ctx) {
				return c.json({ error: { message: ctx.error } }, ctx.status);
			}

			const projectId = c.req.param("projectId")!;
			const hasAccess = await hasProjectAccess(
				projectId,
				ctx.userId,
				ctx.organizationId ?? undefined,
			);
			if (!hasAccess) {
				return c.json(notFound("Project"), 404);
			}

			const typeFilter = c.req.query("type");
			if (typeFilter && !isDocumentType(typeFilter)) {
				return c.json(badRequest(`Invalid type: ${typeFilter}`), 400);
			}
			const statusFilter = c.req.query("status");
			if (statusFilter && !isDocumentStatus(statusFilter)) {
				return c.json(
					badRequest(`Invalid status: ${statusFilter}`),
					400,
				);
			}

			const limit = Math.min(Number(c.req.query("limit") ?? 20), 100);
			const offset = Number(c.req.query("offset") ?? 0);
			if (Number.isNaN(limit) || Number.isNaN(offset)) {
				return c.json(
					badRequest("limit and offset must be numbers"),
					400,
				);
			}

			const result = await listDocuments({
				projectId,
				type: typeFilter as DocumentType | undefined,
				status: statusFilter as DocumentStatus | undefined,
				limit,
				offset,
			});

			return c.json(
				ok(result.documents.map(mapSummary), {
					total: result.total,
					hasMore: result.hasMore,
				}),
			);
		},
	);

	/**
	 * POST /projects/:projectId/documents
	 * Creates a new document on the project.
	 */
	app.post(
		"/projects/:projectId/documents",
		requireScope("documents:write"),
		async (c) => {
			const apiCtx = c.get("externalApiContext");
			const ctx = await resolveV1Context(
				apiCtx,
				c.req.query("org"),
				c.req.query("personal") === "1",
			);
			if ("error" in ctx) {
				return c.json({ error: { message: ctx.error } }, ctx.status);
			}

			const projectId = c.req.param("projectId")!;
			const hasAccess = await hasProjectAccess(
				projectId,
				ctx.userId,
				ctx.organizationId ?? undefined,
			);
			if (!hasAccess) {
				return c.json(notFound("Project"), 404);
			}
			const canEdit = await canEditProject(projectId, ctx.userId);
			if (!canEdit) {
				return c.json(
					forbidden("No edit permission for this project"),
					403,
				);
			}

			let body: {
				type?: string;
				title?: string;
				content?: string;
				status?: string;
			};
			try {
				body = await c.req.json();
			} catch {
				return c.json(badRequest("Invalid JSON body"), 400);
			}

			if (!isDocumentType(body.type)) {
				return c.json(
					badRequest(
						"type is required and must be a valid ProjectDocumentType",
					),
					400,
				);
			}
			const title = body.title?.trim();
			if (!title) {
				return c.json(badRequest("title is required"), 400);
			}
			if (title.length > 200) {
				return c.json(
					badRequest("title must be 200 characters or fewer"),
					400,
				);
			}
			if (body.content === undefined || body.content === null) {
				return c.json(badRequest("content is required"), 400);
			}
			if (typeof body.content !== "string") {
				return c.json(badRequest("content must be a string"), 400);
			}
			if (body.content.length > 1_000_000) {
				return c.json(
					badRequest("content must be under 1,000,000 characters"),
					400,
				);
			}
			if (body.status !== undefined && !isDocumentStatus(body.status)) {
				return c.json(
					badRequest(`Invalid status: ${body.status}`),
					400,
				);
			}

			const doc = await createDocument({
				projectId,
				type: body.type,
				title,
				content: body.content,
				status: (body.status as DocumentStatus | undefined) ?? "DRAFT",
				lastEditedBy: ctx.userId,
				userId: ctx.userId,
			});

			return c.json(ok(mapDetail(doc)), 201);
		},
	);

	/**
	 * GET /documents/:id
	 * Returns the document with full content. Access is gated on the
	 * parent project — tenant XOR isolation is enforced by hasProjectAccess.
	 */
	app.get("/documents/:id", requireScope("documents:read"), async (c) => {
		const apiCtx = c.get("externalApiContext");
		const ctx = await resolveV1Context(
			apiCtx,
			c.req.query("org"),
			c.req.query("personal") === "1",
		);
		if ("error" in ctx) {
			return c.json({ error: { message: ctx.error } }, ctx.status);
		}

		const doc = await getDocumentById(c.req.param("id")!);
		if (!doc) {
			return c.json(notFound("Document"), 404);
		}

		const hasAccess = await hasProjectAccess(
			doc.projectId,
			ctx.userId,
			ctx.organizationId ?? undefined,
		);
		if (!hasAccess) {
			return c.json(notFound("Document"), 404);
		}

		return c.json(ok(mapDetail(doc)));
	});

	/**
	 * PATCH /documents/:id
	 * Updates title, content, and/or status. Each content change
	 * automatically snapshots the prior version (handled by
	 * updateDocument).
	 */
	app.patch("/documents/:id", requireScope("documents:write"), async (c) => {
		const apiCtx = c.get("externalApiContext");
		const ctx = await resolveV1Context(
			apiCtx,
			c.req.query("org"),
			c.req.query("personal") === "1",
		);
		if ("error" in ctx) {
			return c.json({ error: { message: ctx.error } }, ctx.status);
		}

		const existing = await getDocumentById(c.req.param("id")!);
		if (!existing) {
			return c.json(notFound("Document"), 404);
		}

		const hasAccess = await hasProjectAccess(
			existing.projectId,
			ctx.userId,
			ctx.organizationId ?? undefined,
		);
		if (!hasAccess) {
			return c.json(notFound("Document"), 404);
		}
		const canEdit = await canEditProject(existing.projectId, ctx.userId);
		if (!canEdit) {
			return c.json(
				forbidden("No edit permission for this project"),
				403,
			);
		}

		let body: {
			title?: string;
			content?: string;
			status?: string;
			changeDescription?: string;
		};
		try {
			body = await c.req.json();
		} catch {
			return c.json(badRequest("Invalid JSON body"), 400);
		}

		const updates: {
			title?: string;
			content?: string;
			status?: DocumentStatus;
			changeDescription?: string;
		} = {};

		if (body.title !== undefined) {
			const trimmed = body.title.trim();
			if (!trimmed) {
				return c.json(badRequest("title cannot be empty"), 400);
			}
			if (trimmed.length > 200) {
				return c.json(
					badRequest("title must be 200 characters or fewer"),
					400,
				);
			}
			updates.title = trimmed;
		}
		if (body.content !== undefined) {
			if (typeof body.content !== "string") {
				return c.json(badRequest("content must be a string"), 400);
			}
			if (body.content.length > 1_000_000) {
				return c.json(
					badRequest("content must be under 1,000,000 characters"),
					400,
				);
			}
			updates.content = body.content;
		}
		if (body.status !== undefined) {
			if (!isDocumentStatus(body.status)) {
				return c.json(
					badRequest(`Invalid status: ${body.status}`),
					400,
				);
			}
			// Integration contract status belongs to the Discovery run (plan
			// Slice 4); the query layer enforces this too, this just gives a
			// typed 409 instead of a 500.
			if (
				existing.type === "INTEGRATION_CONTRACT" &&
				body.status !== existing.status
			) {
				return c.json(
					{
						error: {
							message:
								"Integration contract status is managed by the discovery run; use Mark contract complete",
							code: "INTEGRATION_CONTRACT_STATUS_MANAGED",
						},
					},
					409,
				);
			}
			updates.status = body.status;
		}
		if (body.changeDescription !== undefined) {
			updates.changeDescription = String(body.changeDescription).slice(
				0,
				500,
			);
		}

		if (Object.keys(updates).length === 0) {
			return c.json(badRequest("No supported fields to update"), 400);
		}

		let updated: Awaited<ReturnType<typeof updateDocument>>;
		try {
			updated = await updateDocument(c.req.param("id")!, {
				...updates,
				lastEditedBy: ctx.userId,
				userId: ctx.userId,
				organizationId: ctx.organizationId ?? undefined,
			});
		} catch (error) {
			// Last line of defence in the query layer (a completion may land
			// between the pre-read above and its own read).
			if (error instanceof IntegrationContractStatusManagedError) {
				return c.json(
					{ error: { message: error.message, code: error.code } },
					409,
				);
			}
			throw error;
		}

		return c.json(ok(mapDetail(updated)));
	});
}
