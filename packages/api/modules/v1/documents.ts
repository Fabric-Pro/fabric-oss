/**
 * v1 Documents routes — project-scoped PRDs / specs / architecture notes /
 * other markdown documents attached to a Project.
 *
 *   GET   /projects/:projectId/documents    list (optional type filter)
 *   POST  /projects/:projectId/documents    create
 *   GET   /documents/:id                    get full content + metadata
 *   PATCH /documents/:id                    update title/content/status
 *
 * A document's detail carries `version` and `contentHash`, its base: a PATCH
 * that sends them back as `expectedVersion` and `expectedContentHash` (both
 * or neither) is
 * refused with 409 `DOCUMENT_VERSION_CONFLICT` instead of overwriting a newer
 * save. A content or status PATCH of a client-document Proposal while a
 * generation run is queued or writing it is refused with 409
 * `DOCUMENT_GENERATION_IN_PROGRESS`.
 *
 * A content PATCH of a client-document Proposal is checked as an AI write
 * no person reviewed (Fizzy #2946): one that changes or removes an existing
 * diagram, its section's removal or renaming included, is refused with 422
 * `REVISION_CHANGED_DIAGRAM`, `error.data.violations` naming each by section
 * key, position and visual id; one that repeats the wording of an answer the
 * key's creator was shown as settled is refused with 422 `RESPONSE_ECHOED`.
 * Prose may change anywhere, and a diagram may move.
 *
 * QUEUED and GENERATING belong to generation runs: a create or PATCH that
 * sends either status is refused with 400 `DOCUMENT_STATUS_GENERATION_OWNED`.
 * Both still work as a list filter.
 *
 * Access model: tenant-scoped via the parent Project. Reads require
 * hasProjectAccess; writes additionally require canEditProject.
 */
import {
	canEditProject,
	createDocument,
	DocumentGenerationInProgressError,
	DocumentVersionConflictError,
	getDocumentById,
	hasProjectAccess,
	IntegrationContractStatusManagedError,
	listDocuments,
	updateDocument,
} from "@repo/database";
import { contentIdentity } from "@repo/utils/content-identity";
import {
	isCreatableDocumentType,
	RETIRED_TYPE_MESSAGE,
} from "@repo/utils/document-type-catalog";
import {
	DOCUMENT_STATUS_GENERATION_OWNED,
	generationOwnedStatusMessage,
	isGenerationOwnedStatus,
	isRunGuardedDocumentType,
} from "@repo/utils/generation-run-guard";
import {
	hasVisualSlots,
	preserveVisualSlots,
} from "@repo/utils/glossy/visual-slots";
import { preserveVisualMarkers } from "@repo/utils/proposal-artifact/visual-identity";
import type { Hono } from "hono";
import { requireScope } from "../external-api/middleware/api-key-auth";
import type { ExternalApiVariables } from "../external-api/types";
import {
	checkWholeBodyAiWrite,
	wholeBodyRefusalMessage,
} from "../projects/lib/client-proposal-main-check";
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

/**
 * `userName` of the `document_change` nudge an API-key update sends. The
 * schema requires one and the key carries no display name; the page only
 * refetches on the event, so it reads like any other document update.
 */
const V1_DOCUMENT_NUDGE_USER_NAME = "Fabric API";

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
		// The body half of the document's base, as `projects.documents.get`
		// returns it. It shadows the embed-owned `contentHash` column, which
		// no reader of this API should see.
		contentHash: contentIdentity(d.content),
	};
}

/** 409 code: the caller's base no longer matches the stored document. */
const DOCUMENT_VERSION_CONFLICT = "DOCUMENT_VERSION_CONFLICT";
/** 409 code: a generation run owns a Proposal's body. */
const DOCUMENT_GENERATION_IN_PROGRESS = "DOCUMENT_GENERATION_IN_PROGRESS";

/** 400 body: a caller sent a status only a generation run may set. */
function generationOwnedStatus(status: "QUEUED" | "GENERATING") {
	return {
		error: {
			message: generationOwnedStatusMessage(status),
			code: DOCUMENT_STATUS_GENERATION_OWNED,
		},
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
			// Still a valid type for list filters and reads; only new ones are
			// refused (Fizzy #2776).
			if (!isCreatableDocumentType(body.type)) {
				return c.json(badRequest(RETIRED_TYPE_MESSAGE), 400);
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
			if (
				body.status !== undefined &&
				isGenerationOwnedStatus(body.status)
			) {
				return c.json(generationOwnedStatus(body.status), 400);
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
	 * updateDocument). Visual slots (`<visual-slot …></visual-slot>` lines)
	 * are managed by Fabric: the stored document's slots are kept in place
	 * and slot tags sent in `content` are ignored, so the saved body can
	 * differ from the one sent when the document holds a slot.
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
			expectedVersion?: unknown;
			expectedContentHash?: unknown;
		};
		try {
			body = await c.req.json();
		} catch {
			return c.json(badRequest("Invalid JSON body"), 400);
		}

		// The base the caller read (`version` and `contentHash` from GET).
		// `updateDocument` refuses the write when either half no longer
		// matches the stored document.
		if (
			body.expectedVersion !== undefined &&
			!(
				typeof body.expectedVersion === "number" &&
				Number.isInteger(body.expectedVersion) &&
				body.expectedVersion >= 0
			)
		) {
			return c.json(
				badRequest("expectedVersion must be a non-negative integer"),
				400,
			);
		}
		if (
			body.expectedContentHash !== undefined &&
			(typeof body.expectedContentHash !== "string" ||
				body.expectedContentHash === "")
		) {
			return c.json(
				badRequest("expectedContentHash must be a non-empty string"),
				400,
			);
		}
		// Half a base cannot name a body: a version alone misses a body
		// saved at the same version, so both halves come together or not at
		// all.
		if (
			(body.expectedVersion === undefined) !==
			(body.expectedContentHash === undefined)
		) {
			return c.json(
				badRequest(
					"Send both expectedVersion and expectedContentHash, or neither",
				),
				400,
			);
		}
		const expectedVersion = body.expectedVersion as number | undefined;
		const expectedContentHash = body.expectedContentHash as
			| string
			| undefined;

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
			// An API-key writer may drop, move, or echo a Glossy visual slot.
			// Strip whatever slot tags it sent and splice back the ones the
			// stored body holds, from the read authorized above (KTD17). A
			// body with no slot on either side passes through as is.
			updates.content = preserveVisualMarkers(
				existing.content,
				preserveVisualSlots(existing.content, body.content),
			);
		}
		if (body.status !== undefined) {
			if (!isDocumentStatus(body.status)) {
				return c.json(
					badRequest(`Invalid status: ${body.status}`),
					400,
				);
			}
			if (isGenerationOwnedStatus(body.status)) {
				return c.json(generationOwnedStatus(body.status), 400);
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

		// When a slot is involved, the spliced body is only right for the
		// version its slots were lifted from: guard the write with it, so a slot
		// added or deleted in between is neither lost nor resurrected. Bodies
		// with no slot on either side keep the unguarded write they had.
		const slotsInvolved =
			body.content !== undefined &&
			(hasVisualSlots(existing.content) || hasVisualSlots(body.content));

		// A Proposal's body is written by generation runs as well as by
		// people (Fizzy #2946). A content write while a run is queued or
		// writing would be replaced by the run, or replace its body, so it is
		// refused. A content write is otherwise always guarded: by the
		// caller's base, or else by the body this request read, so a
		// generated body that lands between that read and the write is never
		// overwritten. Decided by type, not by the rollout gate: a run keeps
		// writing when the gate is turned off mid-run.
		// A status write is refused under a run as well: moving a queued or
		// generating Proposal to another status would end the run's hold, so
		// a content write after it would pass, and the run's own final save
		// would land on a status it did not expect. A title-only write
		// touches neither the body nor the status a run owns, so it stays
		// allowed.
		const runGuarded =
			(updates.content !== undefined || updates.status !== undefined) &&
			isRunGuardedDocumentType(existing.type);
		const runGuardedContentWrite =
			runGuarded && updates.content !== undefined;
		const generationInProgress = () =>
			c.json(
				{
					error: {
						message:
							"A generation run is writing this document; try again when it finishes.",
						code: DOCUMENT_GENERATION_IN_PROGRESS,
					},
				},
				409,
			);
		if (
			runGuarded &&
			(existing.status === "QUEUED" || existing.status === "GENERATING")
		) {
			return generationInProgress();
		}
		const versionConflict = () =>
			c.json(
				{
					error: {
						message:
							"The document changed while it was being updated. Read it again and retry.",
						code: DOCUMENT_VERSION_CONFLICT,
					},
				},
				409,
			);

		// A client-document Proposal's Main is checked like an AI chat accept
		// (Fizzy #2946), stricter on diagrams since no person reviews this
		// diff: every AI writer is held to it, and an API key is one. Against
		// the body this request read, which the write is guarded by, with the
		// key creator's settled answers in the project's owning organization.
		// Only a Proposal can be a client document, so no other type reads
		// the gate.
		if (runGuardedContentWrite && updates.content !== undefined) {
			const verdict = await checkWholeBodyAiWrite({
				surface: "v1",
				projectId: existing.projectId,
				documentId: existing.id,
				documentType: existing.type,
				owningOrganizationId: existing.project?.organizationId ?? null,
				userId: ctx.userId,
				previous: existing.content,
				next: updates.content,
			});
			if (!verdict.ok) {
				// Checked against a body the caller's base no longer names:
				// answered as the guarded write would answer it.
				if (
					expectedVersion !== undefined &&
					(existing.version !== expectedVersion ||
						contentIdentity(existing.content) !==
							expectedContentHash)
				) {
					return versionConflict();
				}
				return c.json(
					{
						error: {
							message: wholeBodyRefusalMessage(
								verdict,
								existing.content,
							),
							code: verdict.code,
							...("violations" in verdict
								? { data: { violations: verdict.violations } }
								: {}),
						},
					},
					422,
				);
			}
		}

		let updated: Awaited<ReturnType<typeof updateDocument>>;
		try {
			updated = await updateDocument(c.req.param("id")!, {
				...updates,
				lastEditedBy: ctx.userId,
				userId: ctx.userId,
				organizationId: ctx.organizationId ?? undefined,
				...(expectedVersion !== undefined
					? { expectedVersion }
					: slotsInvolved || runGuardedContentWrite
						? { expectedVersion: existing.version }
						: {}),
				...(expectedContentHash !== undefined
					? { expectedContentHash }
					: runGuardedContentWrite
						? {
								expectedContentHash: contentIdentity(
									existing.content,
								),
							}
						: {}),
				// A run queued after the read above is refused by the write
				// itself too: `updateDocument` refuses a Proposal's content
				// and status writes under a run by default.
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
			if (error instanceof DocumentGenerationInProgressError) {
				return generationInProgress();
			}
			if (error instanceof DocumentVersionConflictError) {
				return versionConflict();
			}
			throw error;
		}

		// Open editors refetch on `document_change`, so a collaborative room
		// holding the body this write replaced brings itself to the saved one
		// instead of saving the older body back (Fizzy #2946). Sent for every
		// update, as the editor's own save does. Lazy: the realtime client is
		// needed by no other v1 document route. Never throws.
		const { emitDocumentChange } = await import("../../lib/realtime");
		await emitDocumentChange({
			projectId: updated.projectId,
			documentId: updated.id,
			action: "updated",
			userId: ctx.userId,
			userName: V1_DOCUMENT_NUDGE_USER_NAME,
			documentType: updated.type,
			documentTitle: updated.title,
		});

		return c.json(ok(mapDetail(updated)));
	});
}
