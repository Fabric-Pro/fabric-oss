/**
 * Database queries for ProjectDocument model
 * Handles document CRUD operations with version tracking
 */

import { createHash } from "node:crypto";
import {
	isAiRefreshAuthor,
	resolveDocumentVersionAuthor,
} from "@repo/utils/document-version-author";
import { normalizeForComparison } from "@repo/utils/normalize-for-comparison";
import {
	db,
	Prisma,
	type ProjectDocumentStatus,
	type ProjectDocumentType,
} from "../../client";

/**
 * Freshly compute the content hash the document editor's decision-precheck
 * banner compares against.
 *
 * MUST stay byte-for-byte identical to `@repo/rag`'s `generateContentHash`
 * (sha256, first 16 hex chars): the pre-check activity stores
 * `decisionPrecheck.checkedContentHash` with that function, and the banner only
 * shows while `checkedContentHash === currentContentHash`. Recomputing it from
 * the live content on every read — rather than reading the embed-owned
 * `ProjectDocument.contentHash` column — is what decouples the warning from the
 * embed pipeline, so it no longer disappears when the separate (later,
 * best-effort) embed step fails, is skipped, or has not run yet. `@repo/database`
 * cannot import `@repo/rag` (that package depends on this one), so the one-line
 * hash is duplicated here deliberately.
 */
export function computeDocumentContentHash(content: string): string {
	return createHash("sha256").update(content).digest("hex").substring(0, 16);
}

/**
 * Count meaningful prose words in document content.
 * Strips mermaid blocks, code blocks, image references, and base64 data URLs
 * before counting so that non-prose content does not inflate the word count.
 */
export function countDocumentWords(content: string): number {
	let cleaned = content;
	// 1. Strip fenced code blocks (including mermaid diagrams)
	cleaned = cleaned.replace(/```[\s\S]*?```/g, "");
	// 2. Strip image references: ![alt](src) and HTML <img> tags
	cleaned = cleaned.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
	cleaned = cleaned.replace(/<img\s[^>]*\/>/g, "");
	// 3. Strip any remaining base64 data URLs
	cleaned = cleaned.replace(/data:[a-z/]+;base64,[A-Za-z0-9+/=]+/g, "");
	// 4. Split on whitespace and count non-empty tokens
	return cleaned.split(/\s+/).filter((w) => w.length > 0).length;
}

/**
 * Sanitize content for PostgreSQL UTF8 encoding
 * Removes null bytes (0x00) which are not valid in PostgreSQL UTF8 strings
 *
 * Exported because every path that writes document content needs it, including
 * ones outside this module. A second copy elsewhere is a copy that can drift.
 */
export function sanitizeContent(content: string): string {
	// Remove null bytes that may come from AI streaming or other sources
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching null bytes
	return content.replace(/\x00/g, "");
}

/**
 * Create a new document
 *
 * TENANT ISOLATION: userId and organizationId are required for proper tenant filtering.
 * These columns enable RLS policies and application-level filtering.
 */
export async function createDocument(data: {
	projectId: string;
	type: ProjectDocumentType;
	title: string;
	content: string;
	status?: ProjectDocumentStatus;
	lastEditedBy?: string;
	userId: string;
	organizationId?: string;
}) {
	const sanitizedContent = sanitizeContent(data.content);

	// Use transaction to ensure document + initial version are created atomically
	const document = await db.$transaction(async (tx) => {
		const doc = await tx.projectDocument.create({
			data: {
				projectId: data.projectId,
				type: data.type,
				title: data.title,
				content: sanitizedContent,
				status: data.status || "DRAFT",
				version: 1,
				wordCount: countDocumentWords(sanitizedContent),
				lastEditedBy: data.lastEditedBy,
				userId: data.userId,
				organizationId: data.organizationId,
			},
		});

		// Create initial version record for version history
		if (sanitizedContent.trim().length > 0) {
			await tx.documentVersion.create({
				data: {
					documentId: doc.id,
					version: 1,
					content: sanitizedContent,
					changeDescription: "Initial version",
					changedBy: data.lastEditedBy,
					userId: data.userId,
					organizationId: data.organizationId,
				},
			});
		}

		return doc;
	});

	return document;
}

/**
 * Get document by ID
 *
 * Returns `currentContentHash`, a hash freshly computed from the live content,
 * so the editor's decision-precheck banner can gate staleness on the judged
 * content rather than on the embed-owned `contentHash` column (which stays null
 * until — and is absent/stale whenever — the separate embed step succeeds).
 */
export async function getDocumentById(documentId: string) {
	const document = await db.projectDocument.findUnique({
		where: { id: documentId },
		include: {
			project: {
				select: {
					id: true,
					name: true,
					userId: true,
					organizationId: true,
				},
			},
			versions: {
				orderBy: { version: "desc" },
				take: 10, // Last 10 versions
			},
		},
	});

	if (!document) {
		return null;
	}

	return {
		...document,
		currentContentHash: computeDocumentContentHash(document.content),
	};
}

/**
 * Clear the async decision pre-check result on a document.
 *
 * Called when the author acknowledges ("Keep anyway") the contradiction
 * warning: the override is logged to the audit ledger and the finding is
 * cleared so the editor stops surfacing it. Sets the nullable `Json?` column to
 * SQL NULL via `Prisma.DbNull` (a bare `null` is not a valid nullable-JSON
 * write in Prisma).
 */
export async function clearProjectDocumentDecisionPrecheck(
	documentId: string,
): Promise<void> {
	await db.projectDocument.update({
		where: { id: documentId },
		data: { decisionPrecheck: Prisma.DbNull },
	});
}

/**
 * List documents for a project
 */
export async function listDocuments(options: {
	projectId: string;
	type?: ProjectDocumentType;
	status?: ProjectDocumentStatus;
	limit?: number;
	offset?: number;
}) {
	const { projectId, type, status, limit = 50, offset = 0 } = options;

	const where: Prisma.ProjectDocumentWhereInput = {
		projectId,
		...(type ? { type } : {}),
		...(status ? { status } : {}),
	};

	const [documents, total] = await Promise.all([
		db.projectDocument.findMany({
			where,
			include: {
				_count: {
					select: {
						versions: true,
					},
				},
			},
			orderBy: { updatedAt: "desc" },
			take: limit,
			skip: offset,
		}),
		db.projectDocument.count({ where }),
	]);

	return {
		documents,
		total,
		hasMore: offset + limit < total,
	};
}

/**
 * The context-relative deep link to a document. No leading slash and no org
 * segment — the notification inbox prepends the recipient's own base.
 *
 * Lives here, next to the document queries, for the same reason `fabric-url.ts`
 * does: @repo/temporal cannot import @repo/api, so a link builder private to an
 * API procedure is unreachable from the refresh activity that also needs it.
 * Both sides already import from @repo/database.
 */
export function buildDocumentLink(args: {
	projectId: string;
	documentId: string;
}): string {
	return `projects/${args.projectId}/documents/${args.documentId}`;
}

/**
 * Thrown when `updateDocument` is given an `expectedVersion` that no longer
 * matches the document. It means the caller lost a race — someone saved while
 * the caller was preparing its write — and the caller's content is stale.
 *
 * Only reachable when `expectedVersion` is supplied, so no existing caller can
 * see it.
 */
export class DocumentVersionConflictError extends Error {
	constructor(
		readonly documentId: string,
		readonly expectedVersion: number,
		readonly actualVersion: number,
	) {
		super(
			`Document ${documentId} moved from version ${expectedVersion} to ${actualVersion} while the update was being prepared.`,
		);
		this.name = "DocumentVersionConflictError";
	}
}

/**
 * Update document and create version
 *
 * TENANT ISOLATION: userId and organizationId are required for proper tenant filtering
 * on the DocumentVersion child record.
 */
export async function updateDocument(
	documentId: string,
	data: {
		title?: string;
		content?: string;
		status?: ProjectDocumentStatus;
		lastEditedBy?: string;
		changeDescription?: string;
		userId: string;
		organizationId?: string;
		/**
		 * When true, content is updated without incrementing the version number
		 * or creating a version snapshot. Used when reverting a rejected regeneration
		 * where the Temporal workflow already saved the new content to the DB but
		 * the user chose to keep the old content.
		 */
		skipVersionBump?: boolean;
		/**
		 * Optimistic-concurrency guard. When supplied, the write is abandoned with
		 * `DocumentVersionConflictError` if the document is no longer at this
		 * version.
		 *
		 * The unattended auto-refresh needs this and a human editor does not: a
		 * refresh reads the document, spends MINUTES in a model call, then writes.
		 * Someone can open the editor and save in that window, and without the
		 * guard the refresh would silently overwrite them. Nobody is watching, so
		 * there is no one to notice. Omitted by every interactive caller, whose
		 * behavior is unchanged.
		 */
		expectedVersion?: number;
	},
) {
	// Get current document
	const currentDoc = await db.projectDocument.findUnique({
		where: { id: documentId },
	});

	if (!currentDoc) {
		throw new Error("Document not found");
	}

	if (
		data.expectedVersion !== undefined &&
		currentDoc.version !== data.expectedVersion
	) {
		throw new DocumentVersionConflictError(
			documentId,
			data.expectedVersion,
			currentDoc.version,
		);
	}

	// Sanitize content if provided (use !== undefined so empty string is treated as intentional)
	const sanitizedContent =
		data.content !== undefined ? sanitizeContent(data.content) : undefined;

	// Use normalized comparison to detect real changes.
	// The HTML→Markdown roundtrip (TipTap → Turndown) introduces trivial
	// differences (trailing whitespace, extra newlines) that are NOT real edits.
	const contentActuallyChanged =
		sanitizedContent !== undefined &&
		normalizeForComparison(sanitizedContent) !==
			normalizeForComparison(currentDoc.content);

	// When skipVersionBump is set (e.g., reverting rejected regeneration),
	// update content directly without version history changes
	if (
		data.skipVersionBump &&
		contentActuallyChanged &&
		sanitizedContent !== undefined
	) {
		return await db.projectDocument.update({
			where: { id: documentId },
			data: {
				...(data.title ? { title: data.title } : {}),
				content: sanitizedContent,
				wordCount: countDocumentWords(sanitizedContent),
				// Version stays the same — this is a revert, not an edit
				...(data.status ? { status: data.status } : {}),
				...(data.lastEditedBy
					? { lastEditedBy: data.lastEditedBy }
					: {}),
			},
		});
	}

	// The snapshot row holds the content that was live AT `currentDoc.version` —
	// so its author is whoever wrote THAT content, not whoever is superseding it
	// now.
	//
	// This used to copy the incoming writer onto it, which was harmless while
	// every writer was a person and nothing rendered the name. It stopped being
	// harmless the moment an AI became a writer and version history started
	// showing authors: the row containing a human's text would be labelled with
	// the agent, and — worse — the next human edit would snapshot the AGENT's
	// rewrite under that human's name. The ledger inverted exactly where it
	// mattered most: after "the AI corrupted our document", the history would say
	// a person did it.
	//
	// `changeDescription` stays as-is: it describes the change that superseded
	// this row, which is what the version-history UI renders beside it and what
	// every existing row already means.
	const versionSnapshot = {
		documentId,
		version: currentDoc.version,
		content: currentDoc.content,
		changeDescription: data.changeDescription,
		changedBy: currentDoc.lastEditedBy,
		userId: data.userId,
		organizationId: data.organizationId,
	};

	// Only bump version/content if content truly changed.
	const documentWrite = {
		...(data.title ? { title: data.title } : {}),
		...(contentActuallyChanged
			? {
					content: sanitizedContent,
					wordCount: countDocumentWords(sanitizedContent),
					version: currentDoc.version + 1,
				}
			: {}),
		...(data.status ? { status: data.status } : {}),
		...(data.lastEditedBy ? { lastEditedBy: data.lastEditedBy } : {}),
	};

	// Guarded path — the caller supplied an expectedVersion, so it needs the
	// write to LOSE rather than clobber if someone else got there first.
	//
	// The equality check above is not enough on its own: it reads, and only then
	// writes, leaving a window in between. That window is microseconds for a
	// human save, but the auto-refresh reads the document, spends MINUTES in a
	// model call, and writes — a person can comfortably land a save in the middle
	// and nobody is watching to notice it vanish. Closing it needs the version to
	// be part of the WHERE clause, in a transaction, so the database itself
	// arbitrates. Same shape as `updateStory`'s optimistic-concurrency guard.
	if (data.expectedVersion !== undefined) {
		return await db.$transaction(async (tx) => {
			if (contentActuallyChanged) {
				const existingVersion = await tx.documentVersion.findFirst({
					where: { documentId, version: currentDoc.version },
				});
				if (!existingVersion) {
					await tx.documentVersion.create({ data: versionSnapshot });
				}
			}

			const { count } = await tx.projectDocument.updateMany({
				where: { id: documentId, version: currentDoc.version },
				data: documentWrite,
			});
			if (count !== 1) {
				// Someone wrote between our read and this update. Roll the snapshot
				// back with the transaction and let the caller decide what to do.
				const actual = await tx.projectDocument.findUnique({
					where: { id: documentId },
					select: { version: true },
				});
				throw new DocumentVersionConflictError(
					documentId,
					currentDoc.version,
					actual?.version ?? -1,
				);
			}

			return await tx.projectDocument.findUniqueOrThrow({
				where: { id: documentId },
			});
		});
	}

	// Unguarded path — unchanged. Every interactive caller lands here: a human is
	// present, the read-to-write window is negligible, and last-write-wins is the
	// behavior the editor has always had.
	if (contentActuallyChanged) {
		// Check if a version record for this version number already exists
		// (e.g., initial version created by createDocument)
		const existingVersion = await db.documentVersion.findFirst({
			where: { documentId, version: currentDoc.version },
		});
		if (!existingVersion) {
			await db.documentVersion.create({ data: versionSnapshot });
		}
	}

	return await db.projectDocument.update({
		where: { id: documentId },
		data: documentWrite,
	});
}

/**
 * Delete document (cascade deletes versions)
 *
 * Also removes every Document-Assistant chat history attached to this
 * document. `DocumentAssistantConversation.documentRefId` is polymorphic
 * (no single FK) so the cascade has to live here at the query layer.
 * Deleting the underlying `AgentConversation` rows lets the existing
 * `onDelete: Cascade` on the join table remove the join rows.
 *
 * spec §3.9 FR-24 — keeping orphan AI history is more confusing than
 * useful; see release notes.
 */
export async function deleteDocument(documentId: string) {
	return await db.$transaction(async (tx) => {
		const attachments = await tx.documentAssistantConversation.findMany({
			where: {
				documentRefKind: "PROJECT_DOCUMENT",
				documentRefId: documentId,
			},
			select: { conversationId: true },
		});

		if (attachments.length > 0) {
			await tx.agentConversation.deleteMany({
				where: { id: { in: attachments.map((a) => a.conversationId) } },
			});
		}

		// Polymorphic cleanup: Subscription has no FK to the subject (subjectId
		// is an untyped pointer), so watch rows must be removed explicitly.
		await tx.subscription.deleteMany({
			where: { subjectType: "DOCUMENT", subjectId: documentId },
		});

		return await tx.projectDocument.delete({ where: { id: documentId } });
	});
}

/**
 * Get document versions, each with its author resolved for display.
 *
 * `DocumentVersion.changedBy` has no FK to `user` (schema.prisma:1818) — it is a
 * bare string holding a `user.id`, the auto-refresh agent's sentinel, or null —
 * so Prisma cannot `include` the author and we resolve it here instead. This is
 * the ONLY read path for version history, which makes it the right place: the
 * raw `changedBy` never has to be interpreted (or leaked) downstream.
 *
 * The user lookup is ONE batched `findMany` over the page's distinct non-sentinel
 * ids, not one query per version — a 20-version page by 3 authors issues 1 query,
 * not 20.
 */
export async function getDocumentVersions(
	documentId: string,
	limit = 20,
	offset = 0,
) {
	const [versions, total] = await Promise.all([
		db.documentVersion.findMany({
			where: { documentId },
			orderBy: { version: "desc" },
			take: limit,
			skip: offset,
			include: {
				promptVersion: {
					select: {
						id: true,
						version: true,
						prompt: {
							select: {
								id: true,
								name: true,
								scope: true,
							},
						},
					},
				},
			},
		}),
		db.documentVersion.count({ where: { documentId } }),
	]);

	const authorsById = await resolveVersionAuthors(versions);

	return {
		versions: versions.map((version) => ({
			...version,
			author: resolveDocumentVersionAuthor(
				version.changedBy,
				version.changedBy ? authorsById.get(version.changedBy) : null,
			),
		})),
		total,
		hasMore: offset + limit < total,
	};
}

/**
 * Batch-load the `user` rows for a page of versions, keyed by id.
 *
 * Skips the sentinel (the agent has no `user` row) and legacy nulls, and skips
 * the query entirely when a page has no human authors at all. Ids that match no
 * row — deleted accounts, which nothing cleans out of the FK-less column — are
 * simply absent from the map; `resolveDocumentVersionAuthor` turns those into
 * the neutral fallback rather than exposing the id.
 */
async function resolveVersionAuthors(
	versions: { changedBy: string | null }[],
): Promise<Map<string, { name: string | null; email: string | null }>> {
	const userIds = Array.from(
		new Set(
			versions
				.map((version) => version.changedBy)
				.filter(
					(changedBy): changedBy is string =>
						!!changedBy && !isAiRefreshAuthor(changedBy),
				),
		),
	);

	if (userIds.length === 0) {
		return new Map();
	}

	const users = await db.user.findMany({
		where: { id: { in: userIds } },
		select: { id: true, name: true, email: true },
	});

	return new Map(
		users.map((user) => [user.id, { name: user.name, email: user.email }]),
	);
}

/**
 * Get specific version
 */
export async function getDocumentVersion(documentId: string, version: number) {
	return await db.documentVersion.findFirst({
		where: {
			documentId,
			version,
		},
	});
}

/**
 * Restore document to a previous version
 *
 * TENANT ISOLATION: userId and organizationId are required for proper tenant filtering.
 */
export async function restoreDocumentVersion(
	documentId: string,
	version: number,
	restoredBy: string,
	tenantContext: {
		userId: string;
		organizationId?: string;
	},
) {
	const versionData = await getDocumentVersion(documentId, version);

	if (!versionData) {
		throw new Error("Version not found");
	}

	return await updateDocument(documentId, {
		content: versionData.content,
		lastEditedBy: restoredBy,
		changeDescription: `Restored to version ${version}`,
		userId: tenantContext.userId,
		organizationId: tenantContext.organizationId,
	});
}

/**
 * Reject the most recent regeneration: delete the freshly-created
 * `DocumentVersion` row and revert `projectDocument.{content, version}`
 * to the prior snapshot.
 *
 * The standard regen flow (see `saveProjectDocument` + `createDocumentVersion`
 * in `packages/temporal/src/activities/project-document-generation.ts`) bumps
 * `projectDocument.version` to N+1 and writes a `DocumentVersion` row at
 * v=N+1 holding the new content. Rejecting via `updateDocument` with
 * `skipVersionBump=true` only reverts the live content — it leaves a phantom
 * v=N+1 row containing the rejected content, so version history then lies
 * about what's at v=N+1.
 *
 * This helper makes Reject a true rollback in a single transaction.
 *
 * Throws `NO_PRIOR_VERSION` when the document has no version history
 * preceding the latest row (e.g. first-ever generation). Callers should
 * fall back to the old skipVersionBump path in that case.
 */
export async function rejectDocumentRegeneration(
	documentId: string,
	options: {
		userId: string;
		organizationId?: string | null;
	},
): Promise<{ id: string; version: number; content: string }> {
	return await db.$transaction(async (tx) => {
		const doc = await tx.projectDocument.findUnique({
			where: { id: documentId },
			select: { id: true, version: true, content: true },
		});
		if (!doc) {
			throw new Error("Document not found");
		}

		const latest = await tx.documentVersion.findFirst({
			where: { documentId },
			orderBy: { version: "desc" },
			select: { id: true, version: true, content: true },
		});

		// Rejection only makes sense when the latest snapshot IS the regen
		// output — its version matches the live document AND its content
		// matches what's on the live document. The regen flow runs in two
		// activity calls (`saveProjectDocument` then `createDocumentVersion`):
		// between them, the latest DV row is the pre-regeneration snapshot
		// (OLD content) while `projectDocument.content` already holds the
		// new content. If we only checked versions, a Reject in that window
		// would delete the user's actual prior version and rewind to an
		// even older snapshot. Comparing content rules that out.
		if (
			!latest ||
			latest.version !== doc.version ||
			latest.content !== doc.content
		) {
			throw new Error("NO_PRIOR_VERSION");
		}

		const previous = await tx.documentVersion.findFirst({
			where: { documentId, version: { lt: latest.version } },
			orderBy: { version: "desc" },
			select: { version: true, content: true },
		});
		if (!previous) {
			throw new Error("NO_PRIOR_VERSION");
		}

		await tx.documentVersion.delete({ where: { id: latest.id } });

		const updated = await tx.projectDocument.update({
			where: { id: documentId },
			data: {
				content: previous.content,
				version: previous.version,
				wordCount: countDocumentWords(previous.content),
				lastEditedBy: options.userId,
			},
			select: { id: true, version: true, content: true },
		});

		return updated;
	});
}

/**
 * Mark a document as actively generating, immediately before the caller
 * starts the Temporal workflow that will produce its content.
 *
 * Ordering is the whole point: writing GENERATING (and clearing any stale
 * `generationError`) BEFORE `workflow.start` means a workflow that fails
 * within seconds — before its own first milestone write — can never have
 * its `FAILED` write clobbered by this one landing after it. Without this,
 * a retry left the row FAILED with the previous run's error until (or
 * unless) the new workflow's first milestone write arrived, and the editor
 * stayed on the "Regenerating…" spinner in the meantime (issue #720).
 */
export async function markDocumentGenerationStarted(documentId: string) {
	return await db.projectDocument.update({
		where: { id: documentId },
		data: {
			status: "GENERATING",
			generationProgress: 0,
			generationError: null,
			generationStartedAt: new Date(),
		},
	});
}

/**
 * Mark a document's generation as failed. Used by the generate-document
 * procedure when starting the Temporal workflow itself throws (the workflow
 * never got a chance to write its own FAILED status via its activities), so
 * the row doesn't stay stuck on GENERATING forever.
 *
 * Attempt-scoped by design: `startedAt` must be the `generationStartedAt`
 * from the SAME `markDocumentGenerationStarted` call this attempt made, and
 * the write only applies `where: { status: "GENERATING", generationStartedAt:
 * startedAt }`. `workflow.start` can throw even though Temporal actually
 * accepted the start (e.g. a lost response), and a delayed failing request
 * can resolve after a second, newer attempt has already re-marked the row
 * (GENERATING with a fresh timestamp, or COMPLETE/FAILED from the workflow
 * itself). Without the guard, that stale request would blindly overwrite
 * whatever the newer attempt has since written. With it, a write that no
 * longer matches this exact attempt's identity is silently a no-op — we only
 * ever fail the attempt we ourselves started. `updateMany` (not `update`)
 * because the compound where isn't a unique selector; the affected count is
 * intentionally ignored by the caller.
 */
export async function markDocumentGenerationFailed(
	documentId: string,
	startedAt: Date,
	error: string,
): Promise<void> {
	await db.projectDocument.updateMany({
		where: {
			id: documentId,
			status: "GENERATING",
			generationStartedAt: startedAt,
		},
		data: {
			status: "FAILED",
			generationError: error,
		},
	});
}

/**
 * Write an extracted file's text into a document that was created before the
 * upload, and mark it done.
 *
 * The create flow writes the row GENERATING so the documents list has something
 * to show while extraction runs. This is the other end of that: the row is
 * filled rather than created, so its id — already handed to the client, already
 * in the URL the dialog navigated to — stays valid.
 *
 * Scoped to GENERATING so a row a user has since edited, or one a second
 * dispatch has already completed, is not overwritten by a late extraction.
 * `updateMany` because that compound where is not a unique selector.
 */
export async function fillGeneratingDocument({
	documentId,
	content,
	contextId,
}: {
	documentId: string;
	content: string;
	contextId?: string;
}): Promise<number> {
	return await db.$transaction(async (tx) => {
		const { count } = await tx.projectDocument.updateMany({
			where: { id: documentId, status: "GENERATING" },
			data: {
				content: sanitizeContent(content),
				status: "COMPLETE",
				wordCount: countDocumentWords(content),
				generationProgress: 100,
				generationCompletedAt: new Date(),
				generationError: null,
				isActive: true,
				...(contextId ? { sourceContextId: contextId } : {}),
			},
		});

		// Take over as the active document of the type, now that there is
		// something to be canonical with. The row was created inactive on
		// purpose: an empty document should not stand a real one down, and a
		// file that turns out to be unreadable should displace nothing at all.
		//
		// Scoped to the same type in the same project, and to rows other than
		// this one, so a project already carrying several active documents of
		// the type converges rather than gaining one more.
		if (count > 0) {
			const row = await tx.projectDocument.findUnique({
				where: { id: documentId },
				select: { projectId: true, type: true },
			});
			if (row) {
				await tx.projectDocument.updateMany({
					where: {
						projectId: row.projectId,
						type: row.type,
						isActive: true,
						id: { not: documentId },
					},
					data: { isActive: false },
				});
			}
		}

		return count;
	});
}

/**
 * Mark a pre-created document failed, with a reason the reader can act on.
 *
 * The case this exists for is an extraction that produced nothing — a scan
 * without OCR, a corrupt file, an unsupported container. Before the row was
 * created up front, that outcome was silent: no document appeared and nothing
 * said why. Same GENERATING guard as above, for the same reason.
 */
export async function failGeneratingDocument({
	documentId,
	reason,
}: {
	documentId: string;
	reason: string;
}): Promise<number> {
	const { count } = await db.projectDocument.updateMany({
		where: { id: documentId, status: "GENERATING" },
		data: { status: "FAILED", generationError: reason },
	});
	return count;
}

/**
 * Documents whose generation was dispatched before `cutoff` and never reached a
 * terminal status.
 *
 * The dispatch path marks a row GENERATING *before* starting the workflow, on
 * purpose — see `markDocumentGenerationStarted`. That ordering is right, but it
 * means a start that never took leaves the row GENERATING with nothing left to
 * write a terminal status: the workflow that would have done so does not exist.
 * The dispatch helper recovers the cases it can prove, and deliberately does not
 * guess at the one it cannot — an ambiguous `describe()` is left alone rather
 * than risk failing a run that is actually alive. This query feeds the sweep
 * that closes what that leaves behind.
 *
 * `generationStartedAt` is returned because the caller must pass it back to
 * `markDocumentGenerationFailed`: the write is scoped to one attempt, so a row
 * that has since been re-dispatched is skipped rather than clobbered.
 */
export async function findStaleGeneratingDocuments({
	cutoff,
	limit,
}: {
	cutoff: Date;
	limit: number;
}) {
	return await db.projectDocument.findMany({
		where: {
			status: "GENERATING",
			generationStartedAt: { lt: cutoff },
		},
		select: {
			id: true,
			projectId: true,
			generationStartedAt: true,
			workflowId: true,
			project: { select: { organizationId: true } },
		},
		orderBy: { generationStartedAt: "asc" },
		take: limit,
	});
}

/**
 * Get documents by type for a project
 */
export async function getDocumentsByType(
	projectId: string,
	type: ProjectDocumentType,
) {
	return await db.projectDocument.findMany({
		where: {
			projectId,
			type,
		},
		orderBy: { updatedAt: "desc" },
	});
}

/**
 * Check if document exists
 */
export async function documentExists(
	projectId: string,
	type: ProjectDocumentType,
): Promise<boolean> {
	const count = await db.projectDocument.count({
		where: {
			projectId,
			type,
		},
	});

	return count > 0;
}

/**
 * Mark document as embedded (after RAG embedding)
 */
export async function markDocumentAsEmbedded(
	documentId: string,
	qdrantId: string,
	contentHash: string,
) {
	return await db.projectDocument.update({
		where: { id: documentId },
		data: {
			qdrantId,
			embeddedAt: new Date(),
			contentHash,
		},
	});
}

/**
 * Mark document as embedded only if the document's `version` still matches
 * `expectedVersion`. Used by the embedding activity as a race guard: if the
 * user has saved the document again while we were embedding (which bumps
 * `version`), the older run's mark is suppressed so the DB doesn't end up
 * pointing at a stale `contentHash` / `qdrantId`.
 *
 * Returns `{ updated: true }` on a successful mark, `{ updated: false }` if
 * the version drifted (another save superseded this embed run).
 */
export async function markDocumentAsEmbeddedIfVersionUnchanged(
	documentId: string,
	qdrantId: string,
	contentHash: string,
	expectedVersion: number,
): Promise<{ updated: boolean }> {
	const result = await db.projectDocument.updateMany({
		where: {
			id: documentId,
			version: expectedVersion,
		},
		data: {
			qdrantId,
			embeddedAt: new Date(),
			contentHash,
		},
	});
	return { updated: result.count === 1 };
}

/**
 * Get documents that need embedding (new or content changed)
 * Used for batch embedding operations
 */
export async function getDocumentsNeedingEmbedding(projectId: string) {
	return await db.projectDocument.findMany({
		where: {
			projectId,
			status: "COMPLETE", // Only embed completed documents
			OR: [
				{ embeddedAt: null }, // Never embedded
				// Content hash mismatch is checked at application layer
			],
		},
		select: {
			id: true,
			projectId: true,
			type: true,
			title: true,
			content: true,
			contentHash: true,
			qdrantId: true,
			embeddedAt: true,
			userId: true,
			organizationId: true,
		},
	});
}

/**
 * Paginated listing of documents that currently have Qdrant embeddings.
 * Used by the zombie-sweep workflow to drive a per-document cleanup pass
 * that deletes chunks whose `documentVersion` has fallen behind the DB row.
 *
 * Only returns the minimal fields needed for the sweep — `id`, `version`,
 * and `organizationId` (needed to route to the correct Qdrant collection).
 */
export async function listEmbeddedDocumentsForSweep(params: {
	limit: number;
	cursor?: string;
}): Promise<
	Array<{
		id: string;
		version: number;
		organizationId: string | null;
	}>
> {
	return db.projectDocument.findMany({
		where: {
			// Only rows that have actually been embedded at least once.
			// An unembedded doc has no Qdrant points to reap.
			embeddedAt: { not: null },
			contentHash: { not: null },
		},
		select: {
			id: true,
			version: true,
			organizationId: true,
		},
		orderBy: { id: "asc" },
		take: params.limit,
		...(params.cursor
			? {
					skip: 1,
					cursor: { id: params.cursor },
				}
			: {}),
	});
}

/**
 * Clear embedding info (used before re-embedding)
 */
export async function clearDocumentEmbedding(documentId: string) {
	return await db.projectDocument.update({
		where: { id: documentId },
		data: {
			qdrantId: null,
			embeddedAt: null,
			contentHash: null,
		},
	});
}

/**
 * Get embeddable documents for a project (PRD, PROPOSAL, etc.)
 * These are source-of-truth documents that should be used as context
 */
export async function getEmbeddableDocuments(
	projectId: string,
	types: ProjectDocumentType[] = ["PRD", "PROPOSAL"],
) {
	return await db.projectDocument.findMany({
		where: {
			projectId,
			type: { in: types },
			status: "COMPLETE",
		},
		select: {
			id: true,
			projectId: true,
			type: true,
			title: true,
			content: true,
			contentHash: true,
			qdrantId: true,
			embeddedAt: true,
			userId: true,
			organizationId: true,
			updatedAt: true,
		},
		orderBy: { updatedAt: "desc" },
	});
}

/**
 * Set a document as active and deactivate the previous active document of the same type.
 * Returns the IDs of the deactivated and activated documents for embedding management.
 */
export async function setDocumentActive(params: {
	documentId: string;
	projectId: string;
}): Promise<{ deactivatedDocId: string | null; activatedDocId: string }> {
	const { documentId, projectId } = params;

	// Get target document
	const targetDoc = await db.projectDocument.findUnique({
		where: { id: documentId },
		select: { id: true, type: true, projectId: true, isActive: true },
	});

	if (!targetDoc) {
		throw new Error("Document not found");
	}

	if (targetDoc.projectId !== projectId) {
		throw new Error("Document does not belong to project");
	}

	// Already active - no-op
	if (targetDoc.isActive) {
		return { deactivatedDocId: null, activatedDocId: documentId };
	}

	// Find current active doc of same type
	const currentActive = await db.projectDocument.findFirst({
		where: {
			projectId,
			type: targetDoc.type,
			isActive: true,
			id: { not: documentId },
		},
		select: { id: true },
	});

	// Deactivate current and activate target in a transaction
	await db.$transaction([
		...(currentActive
			? [
					db.projectDocument.update({
						where: { id: currentActive.id },
						data: { isActive: false },
					}),
				]
			: []),
		db.projectDocument.update({
			where: { id: documentId },
			data: { isActive: true },
		}),
	]);

	return {
		deactivatedDocId: currentActive?.id ?? null,
		activatedDocId: documentId,
	};
}
