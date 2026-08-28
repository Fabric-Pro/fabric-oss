/**
 * Captured conversation bundles for monitored Teams / Slack channels
 * (Fizzy #2228).
 *
 * A linked channel's `ProjectContext` row is a pointer — a cursor and dedup
 * markers, never the messages — so a monitored channel exported as "Content
 * unavailable" and the assistant could not cite it. These helpers write the
 * text somewhere durable: one `ProjectContextConversationBundle` row per
 * analyzed bundle, hanging off that channel's context row.
 *
 * # Idempotency is a property of the schema, not of this file
 *
 * `recordConversationBundle` writes a bundle over exactly the messages whose
 * claim rows its own transaction managed to INSERT. A repeat or concurrent
 * write of the same message loses the unique index
 * `project_context_conversation_claim_message_key` and contributes nothing,
 * so two workers over overlapping snapshots of one thread produce DISJOINT
 * bundles regardless of what each fetched — without either of them holding a
 * lock, and without this module comparing anything.
 *
 * The claim and the bundle share one transaction on purpose. Claims committing
 * without their bundle would leave a retry with an empty claim set and no row
 * to attach to, which loses those messages permanently.
 *
 * # `ownerKey` is never written here
 *
 * Both tables carry a database-GENERATED `ownerKey` that the composite foreign
 * key to `project_context` compares against. Postgres rejects any INSERT that
 * supplies it. Nothing in this file may put it in a `data` payload, and no
 * caller may either.
 */
import { db } from "../../client";
import type { Prisma } from "../../generated/client";
import type { RetrievableContext } from "./contexts";

/** The tenant a capture runs under, in the shape callers already hold. */
export interface ConversationCaptureTenant {
	userId: string;
	organizationId?: string | null;
}

/**
 * Collapse a caller's tenant into the XOR the capture tables — and the pending
 * vector-cleanup queue beside them — enforce with a CHECK constraint.
 *
 * `ProjectContext` itself stores BOTH columns for an organization row (see
 * `createContext`), and that is fine there — its `ownerKey` resolves through
 * `COALESCE(organizationId, userId)` to the organization either way. The
 * children are stricter: exactly one column, so a row can never name two
 * owners and quietly resolve to one of them.
 *
 * Exported so `pending-vector-cleanup.ts` collapses a tenant the SAME way. Two
 * copies of this could drift into writing a personal record with an
 * organization column set, which the CHECK would then refuse inside the one
 * transaction that must not fail.
 */
export function conversationTenantColumns(tenant: ConversationCaptureTenant): {
	userId: string | null;
	organizationId: string | null;
} {
	const organizationId = tenant.organizationId ?? null;
	return organizationId
		? { userId: null, organizationId }
		: { userId: tenant.userId, organizationId: null };
}

/** XOR read filter, the same shape every project-scoped query in this repo uses. */
export function conversationTenantFilter(tenant: ConversationCaptureTenant) {
	return tenant.organizationId
		? { organizationId: tenant.organizationId }
		: { userId: tenant.userId, organizationId: null };
}

export interface ConversationMessageToClaim {
	/** The provider's own message identifier — the thing being claimed. */
	providerMessageId: string;
	providerThreadId?: string | null;
	messageCreatedAt?: Date | null;
}

/**
 * A message this call actually won. Deliberately NOT an extension of
 * `ConversationMessageToClaim`: what a caller MAY omit on the way in, the
 * database has decided on the way out, so these columns are nullable rather
 * than optional.
 */
export interface ClaimedConversationMessage {
	/** The claim row's id, so the bundle write can stamp exactly these rows. */
	claimId: string;
	providerMessageId: string;
	providerThreadId: string | null;
	messageCreatedAt: Date | null;
}

/** What a caller formats over the messages it actually won. */
export interface ConversationBundleDraft {
	/**
	 * Formatted AND prompt-injection-neutralized text. Every derived copy —
	 * vector payload, retrieval result, export archive, MCP read — inherits the
	 * guard from this column, so raw provider text must never reach it.
	 */
	content: string;
	contentHash: string;
	/**
	 * Start of the window this bundle covers. Not `createdAt`: capture can lag
	 * the conversation by a poll interval, and an export states the period its
	 * captured content covers.
	 */
	bundleStartedAt: Date;
	bundleEndedAt?: Date | null;
	providerThreadId?: string | null;
}

/**
 * Claim each message for this context, returning ONLY the ones this call won.
 *
 * `ON CONFLICT DO NOTHING ... RETURNING` — a losing row comes back absent, not
 * as an error, which is what makes a retry a no-op instead of a failure. The
 * returned array is what the caller must bundle; anything it fetched but is not
 * in this array belongs to somebody else's bundle.
 *
 * Takes a transaction client so the claim can share the bundle's transaction.
 */
export async function claimConversationMessages(
	client: Prisma.TransactionClient,
	params: {
		parentContextId: string;
		projectId: string;
		tenant: ConversationCaptureTenant;
		messages: ConversationMessageToClaim[];
	},
): Promise<ClaimedConversationMessage[]> {
	if (params.messages.length === 0) {
		return [];
	}
	const tenantColumns = conversationTenantColumns(params.tenant);

	// De-duplicate within the batch as well. A provider can hand the same
	// message twice inside one snapshot, and ON CONFLICT DO NOTHING does not
	// resolve a conflict between two rows of the SAME statement — Postgres
	// raises "ON CONFLICT DO UPDATE command cannot affect row a second time"
	// for the update form, and for DO NOTHING the second copy would simply be
	// dropped without telling us which one survived.
	const seen = new Set<string>();
	const unique = params.messages.filter((message) => {
		if (seen.has(message.providerMessageId)) {
			return false;
		}
		seen.add(message.providerMessageId);
		return true;
	});

	// Insert in a deterministic order across ALL callers. A losing INSERT does
	// not fail immediately — it waits on the winner's row lock — so two workers
	// inserting the same two messages in opposite orders would each hold the
	// row the other is waiting for, and Postgres would break the tie by
	// aborting one transaction as a deadlock. Sorting on the claimed key means
	// every worker takes those locks in the same order, so the loser simply
	// waits and then claims nothing. The caller's original ordering is restored
	// below, since insertion order is an implementation detail and message
	// order is not.
	const ordered = [...unique].sort((a, b) =>
		a.providerMessageId < b.providerMessageId
			? -1
			: a.providerMessageId > b.providerMessageId
				? 1
				: 0,
	);

	const won =
		await client.projectContextConversationClaim.createManyAndReturn({
			data: ordered.map((message) => ({
				parentContextId: params.parentContextId,
				projectId: params.projectId,
				providerMessageId: message.providerMessageId,
				providerThreadId: message.providerThreadId ?? null,
				messageCreatedAt: message.messageCreatedAt ?? null,
				...tenantColumns,
			})),
			skipDuplicates: true,
			select: {
				id: true,
				providerMessageId: true,
				providerThreadId: true,
				messageCreatedAt: true,
			},
		});

	const wonByMessageId = new Map(
		won.map((claim) => [
			claim.providerMessageId,
			{
				claimId: claim.id,
				providerMessageId: claim.providerMessageId,
				providerThreadId: claim.providerThreadId,
				messageCreatedAt: claim.messageCreatedAt,
			},
		]),
	);

	// Caller order, not insertion order.
	return unique
		.map((message) => wonByMessageId.get(message.providerMessageId))
		.filter((claim): claim is ClaimedConversationMessage => Boolean(claim));
}

/**
 * Claim, bundle and stamp — in one transaction.
 *
 * Returns `null` when this call won no messages, which is the normal outcome
 * for a retry or for the loser of a race. An empty claim set writes no bundle:
 * a bundle over nothing is not a smaller bundle, it is a row that claims to
 * cover a window it holds no content for.
 *
 * `buildBundle` runs AFTER the claim and receives exactly the won messages, so
 * the formatted text and its coverage window describe what this bundle actually
 * holds rather than what the caller happened to fetch.
 */
export async function recordConversationBundle(params: {
	parentContextId: string;
	projectId: string;
	tenant: ConversationCaptureTenant;
	messages: ConversationMessageToClaim[];
	buildBundle: (
		claimed: ClaimedConversationMessage[],
	) => ConversationBundleDraft;
}): Promise<{ bundleId: string; claimedMessageIds: string[] } | null> {
	const tenantColumns = conversationTenantColumns(params.tenant);

	return await db.$transaction(async (tx) => {
		const claimed = await claimConversationMessages(tx, {
			parentContextId: params.parentContextId,
			projectId: params.projectId,
			tenant: params.tenant,
			messages: params.messages,
		});
		if (claimed.length === 0) {
			return null;
		}

		const draft = params.buildBundle(claimed);
		const bundle = await tx.projectContextConversationBundle.create({
			data: {
				parentContextId: params.parentContextId,
				projectId: params.projectId,
				providerThreadId: draft.providerThreadId ?? null,
				content: draft.content,
				contentHash: draft.contentHash,
				messageCount: claimed.length,
				bundleStartedAt: draft.bundleStartedAt,
				bundleEndedAt: draft.bundleEndedAt ?? null,
				...tenantColumns,
			},
			select: { id: true },
		});

		await tx.projectContextConversationClaim.updateMany({
			where: { id: { in: claimed.map((claim) => claim.claimId) } },
			data: { bundleId: bundle.id },
		});

		return {
			bundleId: bundle.id,
			claimedMessageIds: claimed.map((claim) => claim.providerMessageId),
		};
	});
}

export interface ConversationBundleRow {
	id: string;
	parentContextId: string;
	providerThreadId: string | null;
	content: string;
	messageCount: number;
	bundleStartedAt: Date;
	bundleEndedAt: Date | null;
	qdrantId: string | null;
	embeddedAt: Date | null;
	extractionStatus: string;
	createdAt: Date;
}

/**
 * Every captured bundle for one monitored channel, oldest first.
 *
 * Ordered by `bundleStartedAt` rather than `createdAt`, so a bundle captured
 * late for an older window sorts where the conversation actually happened —
 * which is the order an export reads them in and the basis of the coverage
 * period it states. `id` breaks ties so the order is total and stable.
 */
export async function listConversationBundlesForContext(params: {
	parentContextId: string;
	tenant: ConversationCaptureTenant;
}): Promise<ConversationBundleRow[]> {
	return await db.projectContextConversationBundle.findMany({
		where: {
			parentContextId: params.parentContextId,
			...conversationTenantFilter(params.tenant),
		},
		orderBy: [{ bundleStartedAt: "asc" }, { id: "asc" }],
		select: {
			id: true,
			parentContextId: true,
			providerThreadId: true,
			content: true,
			messageCount: true,
			bundleStartedAt: true,
			bundleEndedAt: true,
			qdrantId: true,
			embeddedAt: true,
			extractionStatus: true,
			createdAt: true,
		},
	});
}

/**
 * Every captured bundle for one monitored channel, as one readable body.
 *
 * The mirror of `getCrawledUrlSourceMarkdown`, and for the same reason: the
 * `ProjectContext` row carries no text of its own, so a reader that only knows
 * about `content` sees an empty conversation. Chronological, oldest first, with
 * the same rule separator the URL-source assembly uses.
 *
 * The text is NOT neutralized here. The capture path applies
 * `neutralizeAiChatAttachmentBody` before the row write precisely so every
 * derived copy inherits the guard and no reader has to remember to re-apply it.
 */
export async function getCapturedConversationMarkdown(
	parentContextId: string,
	tenant: ConversationCaptureTenant,
): Promise<string> {
	const bundles = await listConversationBundlesForContext({
		parentContextId,
		tenant,
	});

	return bundles
		.filter((bundle) => bundle.content.length > 0)
		.map((bundle) => bundle.content)
		.join("\n\n---\n\n");
}

/**
 * Resolve one captured bundle into the envelope the context retrieval path
 * returns, or null.
 *
 * A vector hit on a bundle point carries the BUNDLE's own row id — that is what
 * `embedConversationBundle` hands the embedder as its context id, so it is what
 * reaches the payload's `contextId` / `originalContextId`. That id is not a
 * `ProjectContext` and not a `ProjectContextUrlPage`, so
 * `getRetrievableContextById` returns null for it and the hit is silently
 * dropped: embedding bundles without this resolver writes into a store nothing
 * reads back.
 *
 * Tenant-filtered, unlike the context resolver it sits beside. On the context
 * path the isolation is the per-organization collection plus the search's
 * `projectId` filter; here the same XOR filter every project-scoped query uses
 * is applied as a second barrier, because this resolver is reached by row id
 * alone and a row id is not a permission.
 *
 * Returns null for a bundle whose row is gone — an unlink cascades the rows
 * before it deletes their vectors, so a point outliving its row is a normal,
 * momentary state and must resolve to nothing rather than throw.
 */
export async function getRetrievableConversationBundleById(params: {
	bundleId: string;
	projectId: string;
	tenant: ConversationCaptureTenant;
}): Promise<RetrievableContext | null> {
	const bundle = await db.projectContextConversationBundle.findFirst({
		where: {
			id: params.bundleId,
			projectId: params.projectId,
			...conversationTenantFilter(params.tenant),
		},
		select: {
			id: true,
			parentContextId: true,
			providerThreadId: true,
			content: true,
			messageCount: true,
			bundleStartedAt: true,
			bundleEndedAt: true,
			createdAt: true,
			parentContext: {
				select: {
					metadata: true,
					sourceUrl: true,
					sourceTitle: true,
					sourceType: true,
					aiInstructions: true,
				},
			},
		},
	});

	if (!bundle) {
		return null;
	}

	const parent = bundle.parentContext;
	const parentMetadata =
		parent?.metadata && typeof parent.metadata === "object"
			? (parent.metadata as Record<string, unknown>)
			: {};

	return {
		id: bundle.id,
		// The channel's own type. `resolveEffectiveContextType` reads the
		// provider out of the metadata below and turns this into TEAMS_CHAT or
		// SLACK_CHANNEL, so the model is told what kind of source it is reading
		// rather than a bare "INTEGRATION".
		type: "INTEGRATION",
		content: bundle.content,
		createdAt: bundle.createdAt,
		metadata: {
			...parentMetadata,
			parentContextId: bundle.parentContextId,
			conversationBundleId: bundle.id,
			providerThreadId: bundle.providerThreadId,
			messageCount: bundle.messageCount,
			bundleStartedAt: bundle.bundleStartedAt.toISOString(),
			bundleEndedAt: bundle.bundleEndedAt?.toISOString() ?? null,
		},
		originalFilename: null,
		// The channel's label and link, carried through from the pointer row —
		// the same trick the URL-page branch uses to cite the user's own name
		// for a source instead of a raw identifier.
		sourceUrl: parent?.sourceUrl ?? null,
		sourceTitle: parent?.sourceTitle ?? null,
		sourceType: parent?.sourceType ?? null,
		aiInstructions: parent?.aiInstructions ?? null,
	};
}

// =============================================================================
// Embedding: a separately claimable step
// =============================================================================

/**
 * How long a held embedding lease is respected before another pass may take it.
 *
 * Not a timeout on the embed itself — nothing cancels a worker whose lease
 * expires. It is the window after which a crashed worker's row is assumed
 * abandoned. Long enough to cover a slow provider round trip over a large
 * bundle; short enough that a crash does not strand the row for a shift.
 */
export const CONVERSATION_BUNDLE_EMBEDDING_LEASE_MS = 10 * 60 * 1000;

/**
 * The rows nothing has finished and nobody currently holds: `embeddedAt` still
 * null, and either no lease or one taken before `expiredBefore`.
 *
 * There is exactly ONE definition because the claim and the recovery listing
 * must remain EXACT complements of a live lease. A listing that admitted a row
 * the claim then refuses would burn a batch slot every run forever; a listing
 * narrower than the claim would leave rows permanently unreachable. Written
 * twice, a future edit could tighten one copy and leave the other — which is
 * the one failure mode neither side can detect on its own.
 */
function awaitingEmbeddingWhere(
	expiredBefore: Date,
): Prisma.ProjectContextConversationBundleWhereInput {
	return {
		embeddedAt: null,
		OR: [
			{ embeddingLeaseAt: null },
			{ embeddingLeaseAt: { lt: expiredBefore } },
		],
	};
}

/**
 * Take the embedding lease on one bundle by compare-and-set.
 *
 * Returns true only for the caller whose UPDATE actually matched — the row is
 * matched on `embeddedAt: null` AND (no lease, or an expired one), so two
 * embedders racing the same row produce exactly one winner, and one set of
 * points, because the point id is derived from the row id either way.
 *
 * `embeddedAt` is NOT the claim, and must never become it. A crash between
 * claiming and the vector write would leave `embeddedAt` non-null with no
 * vector behind it, and the recovery sweep — which looks for a null
 * `embeddedAt` and no live lease — would skip that row forever. Writing the
 * claim to a separate column is what keeps a crashed embed recoverable.
 */
export async function claimConversationBundleForEmbedding(params: {
	bundleId: string;
	now?: Date;
	leaseMs?: number;
}): Promise<boolean> {
	const now = params.now ?? new Date();
	const leaseMs = params.leaseMs ?? CONVERSATION_BUNDLE_EMBEDDING_LEASE_MS;
	const expiredBefore = new Date(now.getTime() - leaseMs);

	const claimed = await db.projectContextConversationBundle.updateMany({
		where: {
			id: params.bundleId,
			...awaitingEmbeddingWhere(expiredBefore),
		},
		data: { embeddingLeaseAt: now },
	});
	return claimed.count === 1;
}

/**
 * Record that the vector store confirmed this bundle's point.
 *
 * Called ONLY after Qdrant returns, never before — see the note on the claim
 * above. Clears the lease in the same write so the row leaves the recovery
 * sweep's predicate on both of its terms rather than one.
 */
export async function markConversationBundleEmbedded(params: {
	bundleId: string;
	qdrantId?: string | null;
	now?: Date;
}): Promise<void> {
	await db.projectContextConversationBundle.updateMany({
		where: { id: params.bundleId },
		data: {
			qdrantId: params.qdrantId ?? null,
			embeddedAt: params.now ?? new Date(),
			embeddingLeaseAt: null,
			extractionStatus: "COMPLETED",
			extractionError: null,
		},
	});
}

/**
 * Hand the lease back without claiming success.
 *
 * For the paths that end with no vector written and no crash: a caught
 * embedding failure, and an abandon after the parent context turned out to be
 * gone. Releasing is an optimization, not the recovery mechanism — the sweep
 * would reclaim the row anyway once the lease expired. It just means a
 * transient provider blip is retried on the next pass instead of ten minutes
 * later.
 *
 * `embeddedAt` is left null in both cases, which is the whole point.
 */
export async function releaseConversationBundleEmbeddingLease(params: {
	bundleId: string;
	error?: string | null;
}): Promise<void> {
	await db.projectContextConversationBundle.updateMany({
		where: { id: params.bundleId, embeddedAt: null },
		data: {
			embeddingLeaseAt: null,
			...(params.error === undefined
				? {}
				: { extractionError: params.error }),
		},
	});
}

// =============================================================================
// Recovery: the rows nothing else will finish
// =============================================================================

/**
 * How many bundles one recovery run reclaims.
 *
 * Deliberately modest. Every row costs an embedding round trip against a
 * provider shared with interactive work, and this backlog is supposed to be
 * empty — a recovery pass that is regularly saturated is a signal to read, not
 * a capacity problem to solve by raising this number. The sweep reports what it
 * left behind for exactly that reason.
 */
export const CONVERSATION_BUNDLE_EMBEDDING_SWEEP_BATCH = 25;

/** One bundle the sweep may finish, with the tenant to finish it under. */
export interface ConversationBundleAwaitingEmbedding {
	id: string;
	parentContextId: string;
	projectId: string;
	content: string;
	/**
	 * Never null in practice: an organization bundle carries no `userId` of its
	 * own — the XOR sees to that — so it is widened with the parent context's,
	 * which is the person who linked the channel and the identity the live
	 * capture path embeds under too.
	 */
	userId: string | null;
	/**
	 * The bundle's OWN column, never the parent's. It decides the vector
	 * collection, and it is what an unlink's delete filter is written against;
	 * resolving the collection from anything else is how a point ends up
	 * somewhere no unlink will ever look. The composite owner foreign key
	 * already guarantees the two agree, so preferring this one costs nothing.
	 */
	organizationId: string | null;
	/** Display name for the vector payload, matching what live capture writes. */
	sourceTitle: string | null;
}

/** `metadata.title` is what both channel registrars write. */
function readContextTitle(metadata: unknown): string | null {
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
		return null;
	}
	const title = (metadata as Record<string, unknown>).title;
	return typeof title === "string" && title.length > 0 ? title : null;
}

/**
 * Bundles whose embedding never completed and that nobody is currently working
 * on — the queue the recovery sweep drains.
 *
 * The predicate is the EXACT complement of a live lease, and it is literally
 * the same one `claimConversationBundleForEmbedding` matches on — both call
 * `awaitingEmbeddingWhere`, which is why the two live in one file. A listing
 * that admitted a row the claim then refuses would burn a batch slot every run
 * forever, and a listing narrower than the claim would leave rows permanently
 * unreachable. This function only NOMINATES; the claim is still what decides,
 * so a row that acquires a lease between the two is simply refused rather than
 * embedded twice.
 *
 * Oldest first, because a recovery queue is a FIFO — the bundle that has been
 * unsearchable longest is the one somebody has most likely already looked for
 * and not found. `id` breaks `createdAt` ties so the order is total and two
 * runs over an unchanged backlog agree on the prefix they take.
 */
export async function listConversationBundlesAwaitingEmbedding(
	params: { limit?: number; now?: Date; leaseMs?: number } = {},
): Promise<ConversationBundleAwaitingEmbedding[]> {
	const now = params.now ?? new Date();
	const leaseMs = params.leaseMs ?? CONVERSATION_BUNDLE_EMBEDDING_LEASE_MS;
	const expiredBefore = new Date(now.getTime() - leaseMs);

	const rows = await db.projectContextConversationBundle.findMany({
		where: awaitingEmbeddingWhere(expiredBefore),
		orderBy: [{ createdAt: "asc" }, { id: "asc" }],
		take: params.limit ?? CONVERSATION_BUNDLE_EMBEDDING_SWEEP_BATCH,
		select: {
			id: true,
			parentContextId: true,
			projectId: true,
			content: true,
			userId: true,
			organizationId: true,
			parentContext: {
				select: {
					userId: true,
					sourceTitle: true,
					metadata: true,
				},
			},
		},
	});

	return rows.map((row) => ({
		id: row.id,
		parentContextId: row.parentContextId,
		projectId: row.projectId,
		content: row.content,
		userId: row.userId ?? row.parentContext?.userId ?? null,
		organizationId: row.organizationId,
		sourceTitle:
			row.parentContext?.sourceTitle ??
			readContextTitle(row.parentContext?.metadata),
	}));
}
