/**
 * Atomic creation of a document, its first version, and — optionally — the
 * project context row the content came from.
 *
 * ── Why this exists rather than a call to `createDocument()` ─────────────────
 * The shared query helper in `packages/database/prisma/queries/projects/documents.ts`
 * is the right transaction shape and the right sanitization, and this mirrors
 * both. What it cannot do is carry the three fields a content-supplied creation
 * needs — `isActive` (the one-active-document-per-type invariant, KTD10),
 * `source` (an imported document is not a generated one), and `sourceContextId`
 * (the link that keeps a used-as-is source out of the Context tab) — and it
 * hardcodes its version description to "Initial version", which is affirmatively
 * false for pasted text. Widening it was rejected because it has many unrelated
 * callers; this is a sibling, not a replacement, and the ordinary create path
 * keeps calling the original.
 *
 * ── Why the context row is written in the SAME transaction (KTD11) ───────────
 * The existing tagged-context branch writes the document and its version as two
 * sequential statements inside a try/catch that logs and swallows, after the
 * context row is already committed. A caller whose entire purpose was creating a
 * document can therefore receive success with no document, or a document with no
 * version row, or — worst — an orphaned source row describing a document that
 * does not exist. Pulling all three writes into one transaction makes the
 * failure atomic: R32's "never returns success having written only the source"
 * is a property of the shape here, not of a caller remembering to clean up.
 *
 * That branch is deliberately left alone. It has other callers and it writes
 * content unsanitized; repairing it in place would mean reimplementing in shared
 * code what the shared document helper already provides.
 */

import { db, type Prisma, type ProjectDocument } from "@repo/database";
import {
	countDocumentWords,
	sanitizeContent,
} from "@repo/database/prisma/queries/projects/documents";
import type {
	DocumentSource,
	ProjectContextType,
	ProjectDocumentStatus,
	ProjectDocumentType,
} from "@repo/database/prisma/zod";

/** The source material persisted alongside the document, in the same transaction. */
interface CreateDocumentSourceContext {
	type: ProjectContextType;
	/**
	 * Already-neutralized text (see `supplied-context.ts`). This helper does not
	 * neutralize: the row it writes is retrieved raw by later generation runs, so
	 * the guard belongs at the point the text is prepared, where a single call
	 * site produces both the stored and the delivered copy.
	 */
	content: string;
	metadata?: Prisma.InputJsonObject;
	/**
	 * Whether the document points back at this context row.
	 *
	 * `true` on the used-as-is route: the link is what keeps the source out of
	 * the Context tab, exactly as a tagged import behaves, because the document
	 * *is* the source. `false` when the source is genuinely a different text
	 * from the document (used-as-context), where hiding it would be a silent
	 * surprise — the user asked for it to be retained as project context.
	 */
	link: boolean;
}

export interface CreateDocumentWithContentInput {
	projectId: string;
	type: ProjectDocumentType;
	title: string;
	content: string;
	status?: ProjectDocumentStatus;
	/** `IMPORTED` for a document composed from supplied material. */
	source?: DocumentSource;
	/**
	 * False when a document of this type is already active (KTD10). Required
	 * rather than defaulted: only active documents reach retrieval, so two
	 * active documents of one type put conflicting sources in front of every
	 * future generation — and a default would let a new call site inherit the
	 * ordinary path's always-active bug by omission.
	 */
	isActive: boolean;
	/**
	 * Stand down whatever is currently active for this type before inserting.
	 *
	 * Deliberately not "demote this one id". An id assumes there is at most one
	 * active document of the type, and where that is already false — projects
	 * carrying duplicates from before the rule existed — demoting a single row
	 * leaves the rest standing and adds a new one, so the count grows. Demoting
	 * by `(projectId, type)` is correct whether there are none, one, or five,
	 * and needs no read beforehand to decide.
	 *
	 * Inside the same transaction as the create: never a moment with two active
	 * documents, and never one where the old is stood down but the new failed
	 * to appear.
	 */
	takesOverActive?: boolean;
	/** Version-row change description. The shared helper hardcodes "Initial version". */
	changeDescription: string;
	lastEditedBy?: string;
	userId: string;
	organizationId: string | null;
	sourceContext?: CreateDocumentSourceContext;
}

export interface CreateDocumentWithContentResult {
	document: ProjectDocument;
	/** The context row written with it, or null when no source was supplied. */
	context: { id: string } | null;
	/**
	 * How many documents this one stood down to take over as active.
	 *
	 * Counted by the write rather than by a read beforehand, so it is the truth
	 * at the moment it happened: a caller that queried first could be told "one
	 * was active" and then displace two, or none. The client says this out loud,
	 * so it has to be right.
	 */
	displacedCount: number;
}

/**
 * Write the document, its first version, and its optional source context as one
 * unit.
 *
 * Failure propagates. Nothing here is best-effort and nothing is swallowed: a
 * caller that gets a resolved promise has a document, and a caller that gets a
 * rejection has no rows at all.
 */
export async function createDocumentWithContent(
	input: CreateDocumentWithContentInput,
): Promise<CreateDocumentWithContentResult> {
	const sanitizedContent = sanitizeContent(input.content);

	return await db.$transaction(async (tx) => {
		const context = input.sourceContext
			? await tx.projectContext.create({
					data: {
						projectId: input.projectId,
						type: input.sourceContext.type,
						content: sanitizeContent(input.sourceContext.content),
						metadata: input.sourceContext.metadata ?? {},
						userId: input.userId,
						organizationId: input.organizationId,
					},
					select: { id: true },
				})
			: null;

		// Stand the previous ones down first. Only active documents reach
		// retrieval, so the window between the two writes is the window in which
		// a concurrent generation could see both — inside the transaction there
		// is no such window.
		let displacedCount = 0;
		if (input.takesOverActive) {
			const { count } = await tx.projectDocument.updateMany({
				where: {
					projectId: input.projectId,
					type: input.type,
					isActive: true,
				},
				data: { isActive: false },
			});
			displacedCount = count;
		}

		const document = await tx.projectDocument.create({
			data: {
				projectId: input.projectId,
				type: input.type,
				title: input.title,
				content: sanitizedContent,
				status: input.status ?? "DRAFT",
				version: 1,
				wordCount: countDocumentWords(sanitizedContent),
				source: input.source,
				sourceContextId:
					context && input.sourceContext?.link ? context.id : null,
				isActive: input.isActive,
				lastEditedBy: input.lastEditedBy,
				userId: input.userId,
				organizationId: input.organizationId,
			},
		});

		// Mirrors the shared helper: a document created empty (the generation
		// route creates the row before the model has written anything) gets no
		// version row, because there is no content to keep a history of yet.
		if (sanitizedContent.trim().length > 0) {
			await tx.documentVersion.create({
				data: {
					documentId: document.id,
					version: 1,
					content: sanitizedContent,
					changeDescription: input.changeDescription,
					changedBy: input.lastEditedBy,
					userId: input.userId,
					organizationId: input.organizationId,
				},
			});
		}

		return { document, context, displacedCount };
	});
}
