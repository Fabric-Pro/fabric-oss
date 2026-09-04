/**
 * Capture a monitored channel's analyzed conversation as a durable, embedded,
 * neutralized bundle row (Fizzy #2228, U5).
 *
 * A linked Teams or Slack channel's `ProjectContext` row is a POINTER: a
 * cursor and dedup markers, with `content` empty. The messages themselves only
 * ever existed inside a `PendingBacklogProposal`'s `sourceMetadata.transcript`
 * — and only when the analyzer proposed something. An analyzer run that
 * proposed nothing left no trace of the conversation anywhere, which is why
 * "Download All" reported those channels as having no exportable content and
 * why the assistant could not cite them.
 *
 * This helper runs on BOTH branches of the analyzer's outcome by running
 * before it. It is deliberately a plain function and NOT re-exported through
 * `activities/index.ts`: the worker registers everything that barrel exports as
 * a Temporal activity, and this is called inline from inside activities that
 * are already registered.
 *
 * # Shared channels only
 *
 * Teams channels and Slack channels. One-to-one and group chats are excluded
 * by decision — a project is a wider audience than a private conversation, and
 * a link-time disclosure is not an authorization model. The Teams CHAT analyzer
 * is not a caller of this file and must not become one.
 *
 * # Why the caller hands over messages rather than text
 *
 * The claim decides which messages this run actually owns, and it does that
 * inside the transaction. A caller cannot know that beforehand — two workers
 * over overlapping snapshots of one thread each win a different subset. So the
 * caller supplies the messages and a display name; the formatted text is
 * derived from the WON subset afterwards, inside the transaction, so a bundle's
 * text always describes exactly what that bundle holds.
 *
 * # Neutralization happens before the row write, not on the way to the index
 *
 * Accumulated conversation text is externally authored and ends up in a prompt.
 * Neutralizing the embedding payload would guard the copy nothing reads —
 * retrieval uses the vector store to resolve ids and then refetches `content`
 * from Postgres. Applying `neutralizeAiChatAttachmentBody` before the write
 * makes every derived copy inherit the guard: vector payload, retrieval result,
 * export archive, and the MCP project-context read, which no retrieval-time
 * guard covers at all.
 */

import { createHash } from "node:crypto";
import { getSystemRAGProviderConfig } from "@repo/ai";
import {
	type ClaimedConversationMessage,
	claimConversationBundleForEmbedding,
	db,
	markConversationBundleEmbedded,
	recordContextIndexingFailure,
	recordConversationBundle,
	releaseConversationBundleEmbeddingLease,
	slackChannelContextMatches,
	teamsChannelContextMatches,
} from "@repo/database";
import { logger } from "@repo/logs";
import { embedProjectContext } from "@repo/rag";
import {
	getCollectionName,
	PROJECT_CONTEXTS_BASE_COLLECTION,
} from "@repo/rag/lib/collection-manager";
import { neutralizeAiChatAttachmentBody } from "@repo/utils/ai-chat-attachment";
import { deleteContextVectors } from "./delete-channel-context";

// =============================================================================
// Types
// =============================================================================

/**
 * Which linked channel this capture belongs to, in the terms its own
 * `ProjectContext.metadata` is written in.
 *
 * Teams is keyed on `(teamId, channelId)` and Slack on `channelId` alone —
 * that asymmetry is not an oversight, it mirrors the two matching predicates,
 * and the Slack one exists because the Add-Context writers never persisted a
 * workspace id. See `slack-integration-context.ts`.
 */
export type CaptureChannelRef =
	| { provider: "MICROSOFT_TEAMS"; teamId: string; channelId: string }
	| { provider: "SLACK"; channelId: string };

/** One provider message, in the shape both channel monitors already hold. */
export interface ChannelConversationMessage {
	/** The provider's own message id — a Teams message id, a Slack `ts`. */
	providerMessageId: string;
	author: string;
	/** ISO 8601. Ordering and the bundle's coverage window come from this. */
	createdAt: string;
	content: string;
}

export interface CaptureChannelConversationParams {
	channel: CaptureChannelRef;
	projectId: string;
	/**
	 * Tenant, passed explicitly all the way through to the embedding call. The
	 * vector collection is resolved from `organizationId`, so a capture that
	 * wrote its row under one tenant and its point under another would leave
	 * vectors an unlink could never clear.
	 */
	userId: string;
	organizationId?: string;
	/** `#engineering`, `Contoso - engineering` — whatever the analyzer displays. */
	channelDisplayName: string;
	/** The provider thread these messages belong to, when they belong to one. */
	providerThreadId?: string | null;
	messages: ChannelConversationMessage[];
}

export interface CaptureChannelConversationResult {
	/** Null when the channel was unlinked — nothing is written, nothing recreated. */
	parentContextId: string | null;
	/** Null when this run won no messages: a retry, or the loser of a race. */
	bundleId: string | null;
	/** Provider message ids this run actually claimed, in caller order. */
	claimedMessageIds: string[];
	embedding: EmbedBundleOutcome | "not-attempted";
}

export type EmbedBundleOutcome =
	| "embedded"
	| "not-claimed"
	| "abandoned"
	| "abandoned-orphaned"
	| "failed";

// =============================================================================
// Formatting
// =============================================================================

/**
 * Render the won messages as the bundle's stored text.
 *
 * Close to the analyzers' own thread formatters on purpose — the same content
 * should read the same way whether it reached the assistant through a proposal
 * transcript or through retrieval — but headed with the window it covers rather
 * than with a thread root, because a bundle is a slice of a conversation and
 * not necessarily a whole thread.
 *
 * Exported for the tests that assert on the stored text.
 */
export function formatConversationBundle(params: {
	channelDisplayName: string;
	messages: ChannelConversationMessage[];
	startedAt: Date;
	endedAt: Date;
}): string {
	const lines: string[] = [];
	lines.push(
		`## Conversation in #${params.channelDisplayName} — ${params.startedAt.toISOString()} to ${params.endedAt.toISOString()}`,
	);
	lines.push("");
	for (const message of params.messages) {
		lines.push(
			`**${message.author}** (${message.createdAt}): ${message.content}`,
		);
	}
	return lines.join("\n");
}

function parseTimestamp(value: string): Date | null {
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * The window a bundle covers, derived from the messages it actually holds.
 *
 * Falls back to `now` for both ends when a provider hands over timestamps
 * nothing can parse. A bundle with no window would still be readable, but the
 * export orders bundles by `bundleStartedAt` and states the period its captured
 * content covers, so the column is non-null in the schema and a bad timestamp
 * must not be able to lose the row.
 */
function coverageWindow(
	messages: ChannelConversationMessage[],
	now: Date,
): { startedAt: Date; endedAt: Date } {
	const times = messages
		.map((message) => parseTimestamp(message.createdAt))
		.filter((date): date is Date => date !== null)
		.map((date) => date.getTime());
	if (times.length === 0) {
		return { startedAt: now, endedAt: now };
	}
	return {
		startedAt: new Date(Math.min(...times)),
		endedAt: new Date(Math.max(...times)),
	};
}

// =============================================================================
// Parent lookup
// =============================================================================

/**
 * Find the linked channel's pointer row through the SAME predicate the link
 * procedures register it with.
 *
 * Deliberately a find, never an ensure. A capture that created its own parent
 * would resurrect the pointer row for a channel the user had just unlinked —
 * an activity already mid-run does not learn about an unlink, so this call
 * returning null IS the correct behaviour for that race, and it must stay one.
 */
async function findParentContextId(params: {
	projectId: string;
	channel: CaptureChannelRef;
}): Promise<string | null> {
	const rows = await db.projectContext.findMany({
		where: { projectId: params.projectId, type: "INTEGRATION" },
		select: { id: true, metadata: true },
	});
	const channel = params.channel;
	const match = rows.find((row) =>
		channel.provider === "MICROSOFT_TEAMS"
			? teamsChannelContextMatches(row.metadata, {
					teamId: channel.teamId,
					channelId: channel.channelId,
				})
			: slackChannelContextMatches(row.metadata, {
					channelId: channel.channelId,
				}),
	);
	return match?.id ?? null;
}

// =============================================================================
// Capture
// =============================================================================

/**
 * Claim, bundle, stamp — then embed.
 *
 * The claim/bundle/stamp half runs in one transaction inside
 * `recordConversationBundle` and is allowed to throw: a failure there rolls the
 * claims back, so the Temporal retry re-claims the same messages and writes the
 * bundle it was going to write. Swallowing it would do the opposite — the
 * claims would be gone and the retry would compute an empty claim set, losing
 * exactly the content this unit exists to keep.
 *
 * The embedding half never throws. The text is already durable by then; a
 * failed embed costs searchability, which the parent row reports through the
 * existing "Not searchable" badge, and which the recovery pass can fix later.
 */
export async function captureChannelConversationBundle(
	params: CaptureChannelConversationParams,
): Promise<CaptureChannelConversationResult> {
	const parentContextId = await findParentContextId({
		projectId: params.projectId,
		channel: params.channel,
	});
	if (!parentContextId) {
		logger.info(
			"[ConversationCapture] No context row for channel — nothing captured",
			{
				projectId: params.projectId,
				provider: params.channel.provider,
				channelId: params.channel.channelId,
			},
		);
		return {
			parentContextId: null,
			bundleId: null,
			claimedMessageIds: [],
			embedding: "not-attempted",
		};
	}

	const byProviderMessageId = new Map(
		params.messages.map((message) => [message.providerMessageId, message]),
	);
	const now = new Date();
	let bundleContent = "";

	const recorded = await recordConversationBundle({
		parentContextId,
		projectId: params.projectId,
		tenant: {
			userId: params.userId,
			organizationId: params.organizationId ?? null,
		},
		messages: params.messages.map((message) => ({
			providerMessageId: message.providerMessageId,
			providerThreadId: params.providerThreadId ?? null,
			messageCreatedAt: parseTimestamp(message.createdAt),
		})),
		buildBundle: (claimed: ClaimedConversationMessage[]) => {
			const won = claimed
				.map((claim) =>
					byProviderMessageId.get(claim.providerMessageId),
				)
				.filter(
					(message): message is ChannelConversationMessage =>
						message !== undefined,
				);
			const { startedAt, endedAt } = coverageWindow(won, now);
			// Neutralize BEFORE the row write. Every derived copy inherits the
			// guard from this column; nothing downstream re-derives the text.
			bundleContent = neutralizeAiChatAttachmentBody(
				formatConversationBundle({
					channelDisplayName: params.channelDisplayName,
					messages: won,
					startedAt,
					endedAt,
				}),
			);
			return {
				content: bundleContent,
				contentHash: createHash("sha256")
					.update(bundleContent)
					.digest("hex"),
				bundleStartedAt: startedAt,
				bundleEndedAt: endedAt,
				providerThreadId: params.providerThreadId ?? null,
			};
		},
	});

	if (!recorded) {
		// Won nothing. Normal for a retry and for the loser of a race — an
		// empty claim set writes no bundle, because a bundle over nothing is
		// not a smaller bundle, it is a row claiming a window it holds no
		// content for.
		return {
			parentContextId,
			bundleId: null,
			claimedMessageIds: [],
			embedding: "not-attempted",
		};
	}

	const embedding = await embedConversationBundle({
		bundleId: recorded.bundleId,
		parentContextId,
		projectId: params.projectId,
		userId: params.userId,
		organizationId: params.organizationId,
		content: bundleContent,
		sourceTitle: params.channelDisplayName,
	});

	return {
		parentContextId,
		bundleId: recorded.bundleId,
		claimedMessageIds: recorded.claimedMessageIds,
		embedding,
	};
}

// =============================================================================
// Embedding — a separately claimable step
// =============================================================================

export interface EmbedConversationBundleParams {
	bundleId: string;
	parentContextId: string;
	projectId: string;
	userId: string;
	organizationId?: string;
	content: string;
	sourceTitle?: string;
	/** Overridable so the recovery pass can use its own staleness window. */
	leaseMs?: number;
}

/**
 * Embed one bundle under a point id derived deterministically from its row id.
 *
 * Exported so the recovery pass over never-embedded bundles can reuse exactly
 * this sequence — including both halves of the unlink guard, which is the part
 * that would otherwise be reimplemented slightly differently and drift.
 *
 * Never throws — INCLUDING the claim, which is a database write like any other
 * and can fail like any other. The live caller in
 * `captureChannelConversationBundle` deliberately does not wrap this call, so
 * anything escaping here would fail a monitor activity whose conversation text
 * is already durable, which is the exact opposite of the contract.
 *
 * The five outcomes:
 *   - `not-claimed`  — somebody else holds a live lease, or the row is already
 *                      embedded. One winner, one set of points.
 *   - `abandoned`    — the channel was unlinked. Either caught before the
 *                      vector write, or compensated afterwards.
 *   - `abandoned-orphaned`
 *                    — the channel was unlinked AND the compensating delete of
 *                      the point just written did not go through. Distinct
 *                      because it is not clean cleanup: a point may still hold
 *                      conversation text for an unlinked channel.
 *   - `failed`       — the embed itself failed. Recorded on the parent so the
 *                      row renders "Not searchable"; `embeddedAt` stays null.
 *   - `embedded`     — the vector store confirmed.
 */
export async function embedConversationBundle(
	params: EmbedConversationBundleParams,
): Promise<EmbedBundleOutcome> {
	// The claim is the LEASE, never `embeddedAt`. A crash from here on leaves
	// `embeddedAt` null and a lease that expires, so the recovery sweep can
	// reclaim the row. Had the claim been written onto `embeddedAt`, the same
	// crash would have made the row permanently invisible to that sweep.
	//
	// Its own try/catch rather than a place inside the big one below: a claim
	// that threw left us NOT holding the lease, so the shared handler's
	// `releaseConversationBundleEmbeddingLease` would clear whatever lease the
	// row happens to carry — possibly a live one belonging to the worker that
	// won it — and its `recordContextIndexingFailure` would badge a channel
	// "Not searchable" over a transient database blip. Nothing was written and
	// nothing is stamped, so the row stays exactly where the recovery sweep
	// will find it.
	let claimed: boolean;
	try {
		claimed = await claimConversationBundleForEmbedding({
			bundleId: params.bundleId,
			leaseMs: params.leaseMs,
		});
	} catch (error) {
		logger.error(
			"[ConversationCapture] Failed to claim bundle for embedding",
			{
				bundleId: params.bundleId,
				parentContextId: params.parentContextId,
				error: error instanceof Error ? error.message : String(error),
			},
		);
		return "failed";
	}
	if (!claimed) {
		return "not-claimed";
	}

	try {
		// Unlink guard, first half. Embedding outlives the bundle transaction,
		// so an embedder holding a lease can reach this point after unlink has
		// already deleted the channel's vectors and cascaded its rows.
		if (!(await parentStillLinked(params.parentContextId))) {
			await releaseConversationBundleEmbeddingLease({
				bundleId: params.bundleId,
			});
			return "abandoned";
		}

		const providerConfig = await getSystemRAGProviderConfig({
			userId: params.userId,
			organizationId: params.organizationId,
		});

		const result = await embedProjectContext({
			// The bundle's OWN row id. `embedProjectContext` derives its point
			// id from this deterministically, so a repeat embed overwrites
			// rather than duplicating — and the same derivation is what lets
			// the compensating delete below find the point it just wrote.
			contextId: params.bundleId,
			projectId: params.projectId,
			userId: params.userId,
			organizationId: params.organizationId,
			content: params.content,
			type: "INTEGRATION",
			apiKey: providerConfig,
			metadata: {
				// The chunk-delete grouping key. An unlink deleting the parent's
				// vectors finds this bundle's chunks through it.
				parentContextId: params.parentContextId,
				sourceTitle: params.sourceTitle,
				conversationBundleId: params.bundleId,
			},
			// The row lives in `ProjectContextConversationBundle`, not
			// `ProjectContext`. Without this opt-out the shared embedder would
			// try `projectContext.update({ id: bundleId })` and throw on a row
			// that is not there. `markConversationBundleEmbedded` below stamps
			// the right table.
			skipDbUpdate: true,
		});

		if (!result.success) {
			throw new Error(result.error || "Embedding generation failed");
		}

		// Unlink guard, second half. If the channel disappeared between the
		// check above and the write that just landed, the point is orphaned
		// content in the vector store after an unlink reported success —
		// delete it. The deterministic point id is what makes this possible.
		if (!(await parentStillLinked(params.parentContextId))) {
			const compensated = await deleteOrphanedBundleVectors(params);
			await releaseConversationBundleEmbeddingLease({
				bundleId: params.bundleId,
			});
			return compensated ? "abandoned" : "abandoned-orphaned";
		}

		// ONLY now. `embeddedAt` means "the vector store confirmed", nothing
		// weaker.
		await markConversationBundleEmbedded({
			bundleId: params.bundleId,
			qdrantId: result.qdrantId ?? null,
		});
		return "embedded";
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Unknown error";
		logger.error("[ConversationCapture] Failed to embed bundle", {
			bundleId: params.bundleId,
			parentContextId: params.parentContextId,
			error: message,
		});

		// Say WHICH step failed. The conversation is stored and intact; the
		// only casualty is search, and `recordContextIndexingFailure` leaves a
		// COMPLETED parent COMPLETED with a reason attached, which is exactly
		// what the existing "Not searchable" badge reads. Nothing is cleared —
		// a bundle is never rewritten, so previously embedded bundles keep
		// serving.
		await recordContextIndexingFailure(
			params.parentContextId,
			`Search indexing failed: ${message}`,
		).catch((writeError) => {
			logger.warn(
				"[ConversationCapture] Failed to flag parent as not searchable",
				{ parentContextId: params.parentContextId, writeError },
			);
		});

		// Hand the lease back so the next pass retries promptly. Recovery does
		// NOT depend on this having run — an expired lease is reclaimable
		// either way, which is what keeps a hard crash recoverable too.
		await releaseConversationBundleEmbeddingLease({
			bundleId: params.bundleId,
			error: `Search indexing failed: ${message}`,
		}).catch(() => {
			/* best effort — the lease expires on its own */
		});
		return "failed";
	}
}

/**
 * Delete the point this run just wrote, because the channel it belongs to was
 * unlinked while the write was in flight.
 *
 * Returns whether the vector store is known to be clean — never throws, because
 * the caller's own contract is that it does not. But it does not report a
 * failure as cleanup either: an unrecoverable one is logged at ERROR with the
 * ids and the collection it was aiming at, and turns the outcome into
 * `abandoned-orphaned`, which is the only signal anyone gets that conversation
 * text may still be searchable for a channel the user unlinked.
 *
 * Deliberately NOT `removeContextEmbedding`: that wrapper logs its failures and
 * resolves, so every failed compensation would have looked identical to a clean
 * one — and it resolves its collection through `ensureCollection`, which
 * CREATES the collection it is about to delete from. A cleanup path that
 * conjures a collection into existence is a bug on its own: unlink's own
 * deleter documents exactly that, so this shares the deleter rather than
 * repeating it.
 */
async function deleteOrphanedBundleVectors(
	params: EmbedConversationBundleParams,
): Promise<boolean> {
	try {
		await deleteContextVectors({
			contextIds: [params.bundleId],
			projectId: params.projectId,
			organizationId: params.organizationId ?? null,
		});
		return true;
	} catch (error) {
		logger.error(
			"[ConversationCapture] Compensating delete failed — bundle vectors may outlive the unlink",
			{
				bundleId: params.bundleId,
				parentContextId: params.parentContextId,
				projectId: params.projectId,
				// The collection the stranded point is in, resolved by the same
				// name-only function the delete used — an operator clearing it
				// by hand needs the name, and resolving it costs no call.
				collectionName: getCollectionName(
					PROJECT_CONTEXTS_BASE_COLLECTION,
					params.organizationId,
				),
				error: error instanceof Error ? error.message : String(error),
			},
		);
		return false;
	}
}

/** Is the channel still linked? A missing parent row means it is not. */
async function parentStillLinked(parentContextId: string): Promise<boolean> {
	const parent = await db.projectContext.findUnique({
		where: { id: parentContextId },
		select: { id: true },
	});
	return parent !== null;
}
