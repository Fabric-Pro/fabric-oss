import {
	buildDocumentLink,
	clearRefreshProposal,
	completeRefreshCycle,
	createDocumentRefreshNotifications,
	DocumentVersionConflictError,
	getAutoRefreshSettings,
	getDocumentById,
	markRefreshAttempt,
	recordRefreshOutcome,
	storeRefreshProposal,
	updateDocument,
} from "@repo/database";
import { logger } from "@repo/logs";
import { AI_REFRESH_AUTHOR_ID } from "@repo/utils/document-version-author";
import { isLivingDocsRefreshEnabled } from "@repo/utils/feature-flag";
import { ApplicationFailure, heartbeat } from "@temporalio/activity";
import {
	ContextUpdateTruncatedError,
	fetchProjectContextSources,
	runContextUpdate,
} from "../../lib/update-with-context-core";
import type { DueDocument } from "./find-due-documents";
import { applyDocumentRefreshSideEffects } from "./lib/side-effects";

/**
 * One document's refresh cycle.
 *
 * The engine is the same one behind the editor's "Update using context" button.
 * That button is a PROPOSAL: it returns a candidate and a human reads the diff
 * before anything is saved. Every safety property that engine has is "a person
 * looks at the diff."
 *
 * So this activity does not simply delete the person and write. By default it
 * PROPOSES too — storing the candidate and notifying — and only writes when the
 * document's owner explicitly turned `autoApply` on. When it does write, it adds
 * the guards a human standing there would otherwise have provided:
 *
 *  - source-only context, so an unattended cycle never reads its own output;
 *  - a no-op gate, so a quiet fortnight leaves no version behind;
 *  - a refusal on the model's own ambiguity flag, and on a rewrite that would
 *    delete most of the document;
 *  - a compare-and-set, because the model call takes minutes and someone can
 *    save inside that window;
 *  - a re-check of the kill switch immediately before the write.
 */

/**
 * Every FAILURE throws, so Temporal retries it — there is deliberately no
 * `FAILED` member here. A returned outcome always means the cycle reached a
 * conclusion.
 */
export type RefreshOutcome =
	| { status: "COMMITTED"; summary: string }
	| { status: "PROPOSED"; summary: string }
	| { status: "NO_CHANGES"; summary: string }
	| { status: "REFUSED"; summary: string }
	| { status: "SKIPPED_COLLISION" }
	| { status: "SKIPPED_DELETED" }
	| { status: "SKIPPED_DISABLED" };

/**
 * A refresh that shrinks a substantial document to a fraction of itself is far
 * more likely to be a truncated generation, a refusal, or a successful prompt
 * injection than a legitimate edit. A human pressing "Update using context"
 * would see that in the diff and reject it; nobody is looking at this one.
 *
 * Documents genuinely do get descoped, so this is deliberately a floor and not a
 * tight bound — it catches the catastrophic case and lets ordinary editing
 * through. Only applied to documents big enough for the ratio to mean anything.
 */
const SUSPICIOUS_SHRINK_RATIO = 0.5;
const SHRINK_GUARD_MIN_CHARS = 500;

export async function runDocumentRefreshActivity(
	due: DueDocument,
): Promise<RefreshOutcome> {
	heartbeat("runDocumentRefresh");

	try {
		// Inside the try: the document (and, by cascade, this settings row) can be
		// deleted between dispatch and run, and Prisma throws P2025 on an update
		// that matches nothing. Outside the try that surfaced as an opaque activity
		// crash and a Temporal retry of work that could never succeed.
		await markRefreshAttempt(due.documentId, new Date());

		const document = await getDocumentById(due.documentId);
		if (!document) {
			// Nothing to record — the settings row went with it.
			logger.info(
				"[DocumentRefresh] Document was deleted before the refresh ran",
				{ documentId: due.documentId },
			);
			return { status: "SKIPPED_DELETED" };
		}

		const baselineVersion = document.version;
		const documentMarkdown = document.content ?? "";
		const organizationId = due.organizationId ?? undefined;

		// A refresh is an UPDATE. With nothing to update, the model would be handed
		// an empty spec plus the last 60 chat messages and told to return "the
		// COMPLETE specification document" — and it would invent one, out of
		// standup chatter, with no prior version to restore to.
		if (documentMarkdown.trim().length === 0) {
			await completeRefreshCycle(due.documentId, {
				when: new Date(),
				status: "NO_CHANGES",
				summary:
					"The document is empty. Write something first — a refresh updates a document, it does not invent one.",
			});
			return {
				status: "NO_CHANGES",
				summary: "Document is empty; nothing to refresh.",
			};
		}

		// Retrieval and the model call together take minutes — the 20-minute
		// startToCloseTimeout exists precisely because they do. Without a heartbeat
		// in that window the server declares the activity dead after 2 minutes and
		// starts a SECOND one, while the first keeps running the model call,
		// oblivious: two concurrent generations on one document, double the spend,
		// and two writers racing to record the outcome.
		//
		// 30s MUST stay below the proxy's heartbeatTimeout (2 minutes) — do not
		// raise. Same pattern as curate-newsletter-from-releases.ts.
		const heartbeatInterval = setInterval(() => {
			try {
				heartbeat("runDocumentRefresh:generating");
			} catch {
				/* cancelled */
			}
		}, 30_000);

		let sources: Awaited<ReturnType<typeof fetchProjectContextSources>>;
		let result: Awaited<ReturnType<typeof runContextUpdate>>;
		try {
			sources = await fetchProjectContextSources({
				projectId: due.projectId,
				userId: due.triggeredByUserId,
				organizationId,
				baselineDate: document.createdAt,
				specMarkdown: documentMarkdown,
				// Transcripts, features, code, human contexts and chat — never a
				// document a previous refresh generated.
				excludeDocumentChunks: true,
				// An outage must not masquerade as "nothing changed".
				failOnRetrievalError: true,
			});

			result = await runContextUpdate({
				title: document.title,
				baselineDate: document.createdAt,
				documentMarkdown,
				contextItems: sources.contextItems,
				userId: due.triggeredByUserId,
				organizationId,
				projectId: due.projectId,
			});
		} catch (error) {
			// Truncation is deterministic for a given document + model — retrying
			// burns another full-cost LLM call to hit the same output-token
			// ceiling. Fail the activity non-retryably so Temporal doesn't loop
			// on it; the document keeps its last committed version.
			if (error instanceof ContextUpdateTruncatedError) {
				await recordRefreshOutcome(
					due.documentId,
					"FAILED",
					"The document is too large for the configured AI model's output limit — the update was truncated before completion.",
				);
				throw ApplicationFailure.nonRetryable(
					error.message,
					"CONTEXT_UPDATE_TRUNCATED",
				);
			}
			throw error;
		} finally {
			clearInterval(heartbeatInterval);
		}

		// A cycle that could not READ its sources has not completed. Retrieval
		// resolves empty when the embedding provider is down — it does not throw —
		// so without this an outage is indistinguishable from "the project has no
		// context", gets recorded as NO_CHANGES, ADVANCES the cadence clock, and
		// silences the document for a fortnight. Across every tenant, in one sweep.
		if (sources.retrievalFailed) {
			await recordRefreshOutcome(
				due.documentId,
				"FAILED",
				"Could not read this project's context (the retrieval service failed). The refresh will retry.",
			);
			throw new Error("Context retrieval failed");
		}

		if (!result) {
			await recordRefreshOutcome(
				due.documentId,
				"FAILED",
				"The AI update could not be completed. The refresh will retry.",
			);
			// Throw, so Temporal's retry policy actually engages. Returning would
			// mark the activity a success and a transient provider blip would never
			// be retried.
			throw new Error("runContextUpdate failed");
		}

		// The no-op gate. `runContextUpdate` overrides a model that claims a change
		// while handing back normalized-identical content, so this is a trustworthy
		// signal — not the model's word for it.
		if (!result.hasRelevantContext) {
			await completeRefreshCycle(due.documentId, {
				when: new Date(),
				status: "NO_CHANGES",
				summary: result.summary,
			});
			logger.info(
				"[DocumentRefresh] No material change — nothing committed",
				{ documentId: due.documentId },
			);
			return { status: "NO_CHANGES", summary: result.summary };
		}

		const refusal = refuse(documentMarkdown, result);
		if (refusal) {
			logger.warn("[DocumentRefresh] Refusing the model's output", {
				documentId: due.documentId,
				reason: refusal,
			});
			await completeRefreshCycle(due.documentId, {
				when: new Date(),
				status: "REFUSED",
				summary: refusal,
			});
			return { status: "REFUSED", summary: refusal };
		}

		// Re-read the switches immediately before writing. The sweep decided to run
		// this document up to an hour ago; in that window the feature can have been
		// killed, or the document un-enrolled. Without this, flipping the flag off
		// still lets every in-flight refresh commit.
		const settings = await getAutoRefreshSettings(due.documentId);
		if (!isLivingDocsRefreshEnabled() || !settings?.enabled) {
			logger.info(
				"[DocumentRefresh] Abandoning: auto-refresh was turned off while this ran",
				{ documentId: due.documentId },
			);
			return { status: "SKIPPED_DISABLED" };
		}

		// The default. The model's output is stored for a human to accept or reject
		// — the same contract the interactive button has always had.
		if (!settings.autoApply) {
			await storeRefreshProposal(due.documentId, {
				when: new Date(),
				content: result.updatedDocument,
				summary: result.summary,
				baselineVersion,
			});
			await notify(due, result.summary, "proposed");
			logger.info("[DocumentRefresh] Proposed an update for review", {
				documentId: due.documentId,
			});
			return { status: "PROPOSED", summary: result.summary };
		}

		try {
			await updateDocument(due.documentId, {
				content: result.updatedDocument,
				changeDescription: result.summary,
				lastEditedBy: AI_REFRESH_AUTHOR_ID,
				userId: due.userId ?? due.triggeredByUserId,
				organizationId,
				// Lost race → DocumentVersionConflictError → we abandon rather than
				// overwrite whoever saved while the model was thinking.
				expectedVersion: baselineVersion,
			});
		} catch (error) {
			if (error instanceof DocumentVersionConflictError) {
				logger.info(
					"[DocumentRefresh] Abandoned: a human saved during generation",
					{
						documentId: due.documentId,
						expectedVersion: error.expectedVersion,
						actualVersion: error.actualVersion,
					},
				);
				await recordRefreshOutcome(
					due.documentId,
					"SKIPPED_COLLISION",
					"Someone saved the document while the refresh was running. It will retry on the next sweep.",
				);
				return { status: "SKIPPED_COLLISION" };
			}
			throw error;
		}

		await completeRefreshCycle(due.documentId, {
			when: new Date(),
			status: "COMMITTED",
			summary: result.summary,
		});

		// The interactive save runs these; a write that skips them leaves Qdrant
		// serving the pre-refresh document forever and never tells an open editor
		// that the text under it changed.
		await applyDocumentRefreshSideEffects({
			documentId: due.documentId,
			projectId: due.projectId,
			userId: due.triggeredByUserId,
			organizationId,
		});

		await notify(due, result.summary, "committed");

		logger.info("[DocumentRefresh] Committed a new version", {
			documentId: due.documentId,
			fromVersion: baselineVersion,
		});

		return { status: "COMMITTED", summary: result.summary };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.error("[DocumentRefresh] Refresh failed", {
			documentId: due.documentId,
			error: message,
		});
		await recordRefreshOutcome(due.documentId, "FAILED", message).catch(
			() => {
				/* the settings row may be gone; the throw below is what matters */
			},
		);
		// Rethrow so Temporal records the failure and applies its retry policy.
		throw error;
	}
}

/**
 * Reasons to discard the model's output rather than act on it. Returns the
 * human-readable reason, or null to proceed.
 */
function refuse(
	before: string,
	result: { needsHumanResolution: boolean; updatedDocument: string },
): string | null {
	// The engine already tells us when it could not confidently resolve
	// conflicting sources — the interactive path surfaces that to the person
	// looking at the diff. A successful prompt injection (a forged
	// high-precedence "source" contradicting the document) looks exactly like
	// this, so it must not be acted on unsupervised.
	if (result.needsHumanResolution) {
		return "The update was not applied: the AI found conflicting information it could not resolve. Review the document and the recent context, then re-run the refresh.";
	}

	const after = result.updatedDocument.length;
	if (
		before.length >= SHRINK_GUARD_MIN_CHARS &&
		after < before.length * SUSPICIOUS_SHRINK_RATIO
	) {
		return `The update was not applied: it would have removed most of the document (${before.length} to ${after} characters). This is usually a truncated generation rather than a real edit.`;
	}

	return null;
}

async function notify(
	due: DueDocument,
	summary: string,
	kind: "proposed" | "committed",
): Promise<void> {
	// Never allowed to fail the refresh — the work is already recorded.
	await createDocumentRefreshNotifications({
		documentId: due.documentId,
		documentTitle: due.documentTitle,
		projectId: due.projectId,
		organizationId: due.organizationId,
		link: buildDocumentLink({
			projectId: due.projectId,
			documentId: due.documentId,
		}),
		summary,
		kind,
	});
}

export { clearRefreshProposal };
