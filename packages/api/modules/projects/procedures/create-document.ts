/**
 * Create Document Procedure
 *
 * Three routes share one procedure, because "document created" and "generation
 * started" have to be a single decision point rather than two independently
 * failing client round trips:
 *
 *  - **Plain** — a title (and optionally a body) with no source and no
 *    generation. The original behavior, unchanged: it is what an AI-unconfigured
 *    tenant still uses to create a document at all.
 *  - **Use As-Is** — pasted source becomes the document body verbatim, and is
 *    retained as a project context row linked to that document (so it stays out
 *    of the Context tab, exactly as a tagged import behaves) and deliberately
 *    not embedded — the document is the retrievable artifact, and embedding both
 *    would put the same words in the retrieval corpus twice, forever.
 *  - **Use as Context** — the source is retained as ordinary, visible project
 *    context and embedded normally, the document is created empty, and a
 *    generation run is dispatched with that text delivered directly alongside
 *    whatever retrieval finds.
 *
 * The two content-supplied routes take their tenant from the project record's
 * own organization, never from `resolveOrganizationId`: that resolver returns
 * the client-supplied identifier ahead of the middleware-derived one, so a
 * caller with legitimate project access could otherwise stamp a foreign
 * organization onto the rows and onto the generation run that drives provider
 * resolution and usage attribution. The plain route keeps the resolver it has
 * always used — changing it is a separate, deferred fix with its own callers.
 */

import { ORPCError } from "@orpc/client";
import {
	createDocument,
	db,
	hasProjectAccess,
	type ProjectDocument,
} from "@repo/database";
import {
	ProjectDocumentStatusSchema,
	ProjectDocumentTypeSchema,
} from "@repo/database/prisma/zod";
import { logger } from "@repo/logs";
import { getTemporalClient } from "@repo/temporal";
import type { AiChatExtractionOutcome } from "@repo/utils/ai-chat-attachment";
import { z } from "zod";
import { emitActivity, emitDocumentChange } from "../../../lib/realtime";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { createDocumentWithContent } from "../lib/create-document-with-content";
import {
	type DispatchDocumentGenerationResult,
	dispatchDocumentGeneration,
	MAX_RUN_INSTRUCTIONS_CHARS,
} from "../lib/dispatch-document-generation";
import {
	isBlankSuppliedText,
	MAX_SUPPLIED_SOURCE_TEXT_CHARS,
	prepareSuppliedText,
} from "../lib/supplied-context";
import { buildDocumentTitle } from "../utils/document-title";

/** How supplied source content is used. Named after the flow, not after story attachments' `designation`. */
const SourceUsageSchema = z.enum(["CONTEXT", "AS_IS"]);

/** The version-row description for a document composed from pasted text. */
const PASTED_VERSION_DESCRIPTION = "Created from pasted source content";

/**
 * What every create route returns, whichever one ran.
 *
 * Declared once and annotated at both return sites: the two routes are far
 * apart in this file, and inferred object literals would let a field be added
 * to one and quietly forgotten in the other — the client branches on three of
 * these, so a missing one reads as "nothing happened" rather than as an error.
 */
interface CreateDocumentResult {
	document: ProjectDocument;
	sourceContextId: string | null;
	generation: DispatchDocumentGenerationResult | null;
	/**
	 * R31 — an existing active document of this type was stood down for this
	 * one. Reported so the client can say so: demoting a document someone else
	 * may be relying on is not something to do silently.
	 */
	displacedActive: boolean;
	/** R29 — the user's half of the truncation disclosure. */
	suppliedTextOutcome: AiChatExtractionOutcome | null;
}

export const createDocumentProcedure = tenantProtectedProcedure
	// Project-authoritative, and deliberately NOT the gate the regenerate route
	// carries: this call can dispatch a generation, so it must refuse a
	// read-only project guest before anything is written or started.
	.use(requireProjectPermission(Permissions.DOCUMENT_CREATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/documents",
		tags: ["Projects", "Documents"],
		summary: "Create document",
		description: "Create a new document for a project",
	})
	.input(
		z.object({
			projectId: z.string(),
			/**
			 * Accepted for wire compatibility and used only by the plain route.
			 * The content-supplied routes ignore it on purpose — see the module
			 * comment.
			 */
			organizationId: z.string().nullable().optional(),
			type: ProjectDocumentTypeSchema,
			title: z.string().min(1).max(255),
			content: z.string().optional().default(""),
			status: ProjectDocumentStatusSchema.optional(),
			/** Renders the one type whose default title carries a date in the user's day. */
			timeZone: z.string().optional(),
			sourceText: z
				.string()
				.max(MAX_SUPPLIED_SOURCE_TEXT_CHARS)
				.optional()
				.describe("Source material pasted by the user."),
			sourceUsage: SourceUsageSchema.optional().describe(
				"How the supplied source is used. Defaults to CONTEXT when generating, AS_IS otherwise.",
			),
			awaitingSourceFile: z
				.boolean()
				.optional()
				.describe(
					"The source is a file the caller is about to upload. Creates the row in GENERATING and dispatches nothing; the extraction workflow finishes it.",
				),
			generateWithAi: z
				.boolean()
				.optional()
				.describe(
					"Dispatch a generation run for the created document.",
				),
			prompt: z
				.string()
				.max(MAX_RUN_INSTRUCTIONS_CHARS)
				.optional()
				.describe(
					"Optional custom instructions for this run only. Never changes prompt binding configuration.",
				),
			promptId: z
				.string()
				.optional()
				.describe("Optional custom prompt ID from Prompt Library"),
			promptVersionId: z
				.string()
				.optional()
				.describe(
					"Specific prompt version ID for attribution tracking",
				),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;

		const suppliedText = input.sourceText ?? "";
		const hasSuppliedText = suppliedText.length > 0;

		// R19 — a blank paste is refused before any write. It is also the
		// cheapest way around the blocked-empty-creation rule, so the check
		// cannot live only in the dialog.
		if (hasSuppliedText && isBlankSuppliedText(suppliedText)) {
			throw new ORPCError("BAD_REQUEST", {
				message: "Source content cannot be empty.",
			});
		}

		const generationRequested = input.generateWithAi === true;

		// A file is the one source that does not exist yet at this point: the
		// caller needs the document's id before it can upload, because the
		// upload names the row the extraction workflow will fill. So this route
		// writes the row and stops — no content, no dispatch, status GENERATING
		// so the documents list shows it arriving and a failed extraction has
		// something to mark.
		//
		// Checked ahead of everything below because none of that reasoning
		// applies: there is no supplied text to route on, and the
		// blocked-empty-creation rule is about a document that would stay empty,
		// which this one will not.
		if (input.awaitingSourceFile) {
			if (hasSuppliedText) {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"Supply either pasted text or a file, not both — a document has one source.",
				});
			}
			return await createDocumentAwaitingFile({ input, user });
		}

		if (!hasSuppliedText) {
			if (input.sourceUsage === "AS_IS") {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"Source content is required to use it as the document.",
				});
			}
			// Neither source nor generation: the original path, and the one an
			// AI-unconfigured tenant uses to create a document from a title
			// alone (R27). Checked before any mode is derived, so the routing
			// below never has to reason about an absent source.
			if (!generationRequested) {
				return await createPlainDocument({ input, user });
			}
		}

		// With no explicit mode: generating means the source is context;
		// not generating means the source IS the document. That default is what
		// lets an AI-unconfigured tenant — where the mode control is not shown
		// at all — still paste content and get a document out of it (R34).
		const usage = hasSuppliedText
			? (input.sourceUsage ?? (generationRequested ? "CONTEXT" : "AS_IS"))
			: "CONTEXT";
		const useAsIs = usage === "AS_IS";

		// Use As-Is turns generation off for the action (R15): the user's words
		// are the document, and no AI step runs against them.
		const wantsGeneration = generationRequested && !useAsIs;

		if (hasSuppliedText && !useAsIs && !wantsGeneration) {
			// Source retained as context, but nothing to consume it — that
			// combination produces an empty document, so refuse it rather than
			// create one.
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Turn on Generate with AI to use source content as context.",
			});
		}

		// TENANT: the project record is the authority for the organization on
		// every write below and on the generation run. The name comes with it,
		// for the one type whose default title carries a date.
		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: { id: true, name: true, organizationId: true },
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found",
			});
		}

		const organizationId = project.organizationId ?? null;

		// The one type with a dynamic default title is resolved here too, so a
		// document created through this route is named the same as one created
		// through any other.
		const title = buildDocumentTitle(
			input.type,
			project.name,
			input.title,
			{ timeZone: input.timeZone },
		);

		const prepared = hasSuppliedText
			? prepareSuppliedText(suppliedText)
			: null;

		// KTD10: only active documents reach retrieval, so a second active
		// document of one type would put conflicting sources in front of every
		// future generation.
		//
		// The newest wins. A user who just created a PRD means that one — the
		// alternative, landing it inactive behind an older document, produces a
		// document that exists but influences nothing, for a reason nothing on
		// screen explains. The previous ones are not deleted, only stood down,
		// and the caller is told how many so the displacement is visible rather
		// than silent.
		//
		// Which rows those are is decided by the write, not read here first:
		// a project carrying duplicates from before this rule has more than one
		// active document, and a caller that picked a single id would demote one
		// and leave the rest.

		let created: Awaited<ReturnType<typeof createDocumentWithContent>>;
		try {
			created = await createDocumentWithContent({
				projectId: input.projectId,
				type: input.type,
				title,
				// As-is stores the user's words; the generation route creates the
				// row empty for the run to fill.
				//
				// The neutralized copy, not the raw paste. On this route the
				// document is what later runs retrieve and re-interpolate into a
				// prompt — the context row beside it is deliberately not embedded.
				// Neutralizing the row that is never read and leaving the one that
				// is would put R30's guard on the wrong copy. Only delimiter-forming
				// sequences are mangled, so nothing readable is lost.
				content: useAsIs ? (prepared?.storedText ?? "") : input.content,
				status: useAsIs ? "COMPLETE" : (input.status ?? "DRAFT"),
				source: useAsIs ? "IMPORTED" : "GENERATED",
				isActive: true,
				takesOverActive: true,
				changeDescription: PASTED_VERSION_DESCRIPTION,
				lastEditedBy: user.id,
				userId: user.id,
				organizationId,
				sourceContext: prepared
					? {
							type: "TEXT",
							// Already neutralized: this row is retrieved raw by
							// later runs (R30).
							content: prepared.storedText,
							metadata: {
								sourceTitle: title,
								origin: "document-create-flow",
								usage,
							},
							// As-is links the source to its document, which keeps
							// it out of the Context tab. Used-as-context leaves it
							// unset so the user can see what they retained.
							link: useAsIs,
						}
					: undefined,
			});
		} catch (error) {
			// The raw error can carry schema names, constraint text, and
			// connection details. Log it for operators; hand the client a fixed
			// message. R32: a failed write is a failed call — this never
			// returns success having written only the source.
			logger.error(
				`[CreateDocument] Failed to create document for project ${input.projectId}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Failed to create document",
			});
		}

		const { document, context: sourceContext } = created;

		await emitDocumentCreated({
			projectId: input.projectId,
			document,
			user,
		});

		/*
		 * Both dispatches happen after the transaction commits, and neither
		 * depends on the other: embedding only makes the source retrievable
		 * for *future* runs, while this run receives the text directly and is
		 * told to skip that context id during retrieval. Running them
		 * concurrently keeps the common route — source used as context, with
		 * generation on — from paying one workflow start serialized in front
		 * of another.
		 *
		 * Embedding is awaited rather than fire-and-forget so its failure is
		 * logged inside the request that caused it, and so ordering against
		 * the commit is a guarantee rather than a coincidence. It is dispatched
		 * only for a source that is genuinely a different text from the
		 * document.
		 */
		let generation: DispatchDocumentGenerationResult | null = null;

		const embedding =
			sourceContext && !useAsIs
				? startContextEmbedding({
						contextId: sourceContext.id,
						projectId: input.projectId,
						userId: user.id,
						organizationId,
						content: prepared?.storedText ?? "",
					})
				: Promise.resolve();

		const dispatch = wantsGeneration
			? dispatchDocumentGeneration({
					documentId: document.id,
					projectId: input.projectId,
					// The persisted, schema-validated type is the authority for
					// prompt resolution — not a separately held client value.
					documentType: document.type,
					userId: user.id,
					organizationId: project.organizationId || undefined,
					prompt: input.prompt,
					promptId: input.promptId,
					promptVersionId: input.promptVersionId,
					suppliedContext: prepared?.promptText,
					// Held server-side, keyed off the document we just created —
					// never a caller-supplied parameter.
					excludeContextId: sourceContext?.id,
				})
			: Promise.resolve(null);

		// `allSettled`, not `all`: a rejected dispatch must not leave the
		// embedding promise unhandled, and the two failures are reported
		// differently — embedding never fails the call, dispatch does.
		const [, dispatchResult] = await Promise.allSettled([
			embedding,
			dispatch,
		]);

		if (dispatchResult.status === "rejected") {
			const error = dispatchResult.reason;
			logger.error(
				`[CreateDocument] Failed to start document generation for document ${document.id}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Failed to start document generation",
			});
		}
		generation = dispatchResult.value;

		const result: CreateDocumentResult = {
			document,
			sourceContextId: sourceContext?.id ?? null,
			generation,
			displacedActive: created.displacedCount > 0,
			suppliedTextOutcome: (prepared?.outcome ??
				null) as AiChatExtractionOutcome | null,
		};

		return result;
	});

/**
 * Create the row a file upload will fill in.
 *
 * Deliberately not a variant of the plain route: that one is finished when it
 * returns, and this one is the opposite — a row that exists precisely so
 * something else can complete it. Writing it GENERATING is what makes the wait
 * visible (the documents list already renders that state) and what gives the
 * extraction workflow a row to mark FAILED when the file turns out to be
 * unreadable. Before it existed, that outcome produced nothing and explained
 * nothing.
 *
 * `generationStartedAt` is set even though no generation has started, because
 * it is what the stale-generation sweep measures against. A file whose upload
 * never arrives, or whose extraction workflow never runs, is exactly the shape
 * that sweep exists to clear.
 */
async function createDocumentAwaitingFile({
	input,
	user,
}: {
	input: {
		projectId: string;
		type: z.infer<typeof ProjectDocumentTypeSchema>;
		title: string;
		timeZone?: string;
	};
	user: { id: string; name?: string | null };
}): Promise<CreateDocumentResult> {
	// One read: the organization the rows are labelled with, and the name the
	// title default may need. Taken from the project record rather than the
	// caller's input for the same reason as every other route here.
	const project = await db.project.findUnique({
		where: { id: input.projectId },
		select: { id: true, organizationId: true, name: true },
	});
	if (!project) {
		throw new ORPCError("NOT_FOUND", { message: "Project not found" });
	}
	const organizationId = project.organizationId ?? null;

	const document = await db.projectDocument.create({
		data: {
			projectId: input.projectId,
			organizationId: organizationId ?? undefined,
			userId: user.id,
			type: input.type,
			title: buildDocumentTitle(input.type, project.name, input.title, {
				timeZone: input.timeZone,
			}),
			content: "",
			status: "GENERATING",
			generationStartedAt: new Date(),
			source: "IMPORTED",
			// Not canonical yet. It has no body, so making it the active
			// document of its type would point retrieval at an empty one and
			// stand a real document down for a file that may still turn out to
			// be unreadable. The take-over happens when the extraction fills it
			// — see `fillGeneratingDocument`.
			isActive: false,
			lastEditedBy: user.id,
		},
	});

	await emitDocumentCreated({
		projectId: input.projectId,
		document,
		user,
	});

	return {
		document,
		sourceContextId: null,
		generation: null,
		displacedActive: false,
		suppliedTextOutcome: null,
	};
}

/**
 * The original create path, unchanged.
 *
 * Still always-active, unlike the content-supplied routes: it has
 * callers outside this flow, and KTD10 records teaching them the
 * one-active-document-per-type check as separate, deferred work.
 */
async function createPlainDocument({
	input,
	user,
}: {
	input: {
		projectId: string;
		organizationId?: string | null;
		type: z.infer<typeof ProjectDocumentTypeSchema>;
		title: string;
		content: string;
		status?: z.infer<typeof ProjectDocumentStatusSchema>;
	};
	user: { id: string; name?: string | null };
}): Promise<CreateDocumentResult> {
	// The project record, not the shared resolver — same authority the
	// content-supplied routes use. The resolver returns a client-supplied
	// organization ahead of the middleware-derived one, and the rows written
	// here are read back by organization alone elsewhere, so an unverified
	// label is not inert.
	const project = await db.project.findUnique({
		where: { id: input.projectId },
		select: { id: true, organizationId: true },
	});

	if (!project) {
		throw new ORPCError("NOT_FOUND", { message: "Project not found" });
	}

	const organizationId = project.organizationId ?? null;

	const hasAccess = await hasProjectAccess(
		input.projectId,
		user.id,
		organizationId ?? undefined,
	);

	if (!hasAccess) {
		throw new ORPCError("FORBIDDEN", {
			message: "You don't have access to this project",
		});
	}

	const document = await createDocument({
		projectId: input.projectId,
		type: input.type,
		title: input.title,
		content: input.content,
		status: input.status,
		lastEditedBy: user.id,
		userId: user.id,
		organizationId: organizationId ?? undefined,
	});

	if (!document) {
		throw new ORPCError("INTERNAL_SERVER_ERROR", {
			message: "Failed to create document",
		});
	}

	await emitDocumentCreated({
		projectId: input.projectId,
		document,
		user,
	});

	return {
		document,
		sourceContextId: null,
		generation: null,
		displacedActive: false,
		suppliedTextOutcome: null,
	};
}

/** Real-time events for collaboration, identical on every route. */
async function emitDocumentCreated({
	projectId,
	document,
	user,
}: {
	projectId: string;
	document: { id: string; type: string; title: string };
	user: { id: string; name?: string | null };
}) {
	await Promise.all([
		emitDocumentChange({
			projectId,
			documentId: document.id,
			action: "created",
			userId: user.id,
			userName: user.name || "Anonymous",
			documentType: document.type,
			documentTitle: document.title,
		}),
		emitActivity({
			projectId,
			userId: user.id,
			userName: user.name || "Anonymous",
			activityType: "document_created",
			resourceType: "document",
			resourceId: document.id,
			resourceName: document.title,
			timestamp: new Date().toISOString(),
		}),
	]);
}

/**
 * Durable embedding for a retained source, mirroring the context procedure's own
 * dispatch. Failure is logged and swallowed: the document and its source both
 * exist, and an un-embedded context is a retrieval gap, not a failed creation.
 */
async function startContextEmbedding({
	contextId,
	projectId,
	userId,
	organizationId,
	content,
}: {
	contextId: string;
	projectId: string;
	userId: string;
	organizationId: string | null;
	content: string;
}) {
	try {
		const client = await getTemporalClient();
		const workflowId = `context-embedding-${contextId}-${Date.now()}`;

		await client.workflow.start(
			"contextEmbeddingWorkflow",
			withCorrelationMemo({
				taskQueue: "project-documents",
				workflowId,
				args: [
					{
						contextId,
						projectId,
						userId,
						organizationId: organizationId ?? undefined,
						content,
						type: "TEXT",
						metadata: { origin: "document-create-flow" },
					},
				],
			}),
		);
	} catch (error) {
		logger.error(
			`[CreateDocument] Failed to start context embedding workflow for ${contextId}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}
