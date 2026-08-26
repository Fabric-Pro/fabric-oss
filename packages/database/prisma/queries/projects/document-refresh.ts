import {
	type DocumentRefreshCadence,
	type DocumentRefreshCompletedStatus,
	type DocumentRefreshFailureStatus,
	isRefreshDue,
} from "../../../src/document-refresh-cadence";
import { db } from "../../client";
import { hasProjectAccess } from "./projects";

/**
 * Living Documents auto-refresh — enrollment reads/writes and the sweep's
 * due-list query.
 *
 * The sweep runs with no session (the Temporal worker uses the `fabric_worker`
 * role, which has an RLS bypass), so `listEnabledAutoRefreshSettings` reads
 * across tenants by design. Every downstream write is scoped by the row's own
 * userId/organizationId, which are copied from the parent document.
 */

interface UpsertAutoRefreshInput {
	documentId: string;
	projectId: string;
	enabled: boolean;
	cadence: DocumentRefreshCadence;
	/**
	 * Write to the document directly instead of proposing. Off by default — an
	 * unattended whole-document rewrite is opted INTO, never defaulted into.
	 */
	autoApply: boolean;
	/**
	 * The caller. Re-homed on every write on purpose: the sweep borrows this
	 * identity for model resolution and usage logging, so the most recent member
	 * to touch the setting is the safest actor to run under.
	 */
	createdByUserId: string;
	userId: string | null;
	organizationId: string | null;
}

export async function getAutoRefreshSettings(documentId: string) {
	return db.documentAutoRefreshSettings.findUnique({
		where: { documentId },
	});
}

export async function upsertAutoRefreshSettings(input: UpsertAutoRefreshInput) {
	const { documentId, ...rest } = input;

	const settings = await db.documentAutoRefreshSettings.upsert({
		where: { documentId },
		// `lastRefreshedAt` is deliberately absent from both branches: disabling
		// and re-enabling a document must not reset its cycle, and enrolling must
		// not backdate one.
		create: { documentId, ...rest },
		update: {
			enabled: rest.enabled,
			cadence: rest.cadence,
			autoApply: rest.autoApply,
			createdByUserId: rest.createdByUserId,
		},
	});

	// Enrolling a document IS an expression of interest in it. Without this, the
	// feature's default state was: the AI rewrites your PRD and nobody is told,
	// because `Subscription` rows are only ever created by the separate "Watch"
	// button and nothing here created one. The notification this feature exists to
	// send had no recipients.
	if (rest.enabled) {
		await db.subscription
			.upsert({
				where: {
					userId_subjectType_subjectId: {
						userId: rest.createdByUserId,
						subjectType: "DOCUMENT",
						subjectId: documentId,
					},
				},
				create: {
					userId: rest.createdByUserId,
					organizationId: rest.organizationId,
					subjectType: "DOCUMENT",
					subjectId: documentId,
				},
				update: {},
			})
			.catch(() => {
				// A missing watch row must never fail the enrollment itself.
			});
	}

	return settings;
}

/**
 * The sweep's only read. Runs hourly, across every tenant, forever — so it
 * selects the bare minimum the due-list computation touches and nothing else.
 *
 * In particular it does NOT pull the document `content`: the sweep only needs
 * the title (for the notification) and the lock/updatedAt (for the collision
 * gate). Pulling a full markdown body for every enrolled document, 24 times a
 * day, to read two timestamps off it, is a lot of Postgres and a lot of worker
 * heap for nothing. The refresh job re-reads the content itself, per document,
 * only once it is actually going to use it.
 */
/**
 * The most documents one tick will ever dispatch.
 *
 * Without a cap, the first sweep after the flag is switched on finds EVERY
 * enrolled document due at once (a document that has never refreshed is due
 * immediately) and dispatches all of them. They then queue behind a small worker
 * pool, and the ones at the back time out having done nothing — without even
 * recording an attempt, so they come back next hour with no backoff, forever.
 *
 * A cap turns that into a steady drain: the oldest-refreshed documents go first,
 * the rest wait an hour. Nothing about this work is urgent.
 */
export const MAX_REFRESHES_PER_SWEEP = 50;

/**
 * The shortest supported cadence. Any row refreshed more recently than this
 * cannot be due under ANY cadence, so the database can discard it before the
 * cap is applied — otherwise a `take` would fill up with recently-refreshed rows
 * and starve the genuinely stale ones sitting behind them.
 *
 * `isRefreshDue` remains the authority; this is only a pre-filter, and it is
 * deliberately the loosest one that is still correct.
 *
 * **This constant must never exceed the shortest interval in
 * `refreshIntervalDays`.** It was left at 7 when DAILY was added, which silently
 * made DAILY behave as weekly: a document refreshed yesterday was discarded by
 * this pre-filter before `isRefreshDue` ever saw it, so the cadence the reader
 * chose could not fire. A pre-filter that is tighter than the real interval does
 * not optimise the sweep — it removes documents from it.
 */
export const SHORTEST_CADENCE_DAYS = 1;

export async function listEnabledAutoRefreshSettings(now: Date) {
	const earliestPossiblyDue = new Date(
		now.getTime() - SHORTEST_CADENCE_DAYS * 24 * 60 * 60 * 1000,
	);

	return db.documentAutoRefreshSettings.findMany({
		where: {
			enabled: true,
			OR: [
				{ lastRefreshedAt: null },
				{ lastRefreshedAt: { lte: earliestPossiblyDue } },
				// A document pending a deploy is due whenever it last refreshed —
				// that is the point of the marker. Without this arm the
				// `lastRefreshedAt` pre-filter would discard an ON_DEPLOY document
				// that shipped twice in a day, which is exactly the case the
				// cadence exists for.
				{ deployPendingSince: { not: null } },
			],
		},
		// Oldest first, so a capped tick drains the most-stale documents and never
		// starves one at the back of the list.
		orderBy: [{ lastRefreshedAt: { sort: "asc", nulls: "first" } }],
		take: MAX_REFRESHES_PER_SWEEP,
		include: {
			document: {
				select: {
					title: true,
					updatedAt: true,
					lock: { select: { expiresAt: true } },
				},
			},
			// `organizationId` is pulled so the sweep can cross-check the settings
			// row's tenant against the project's. A mis-tenanted row (a settings row
			// claiming personal on an org project) would otherwise be run as
			// personal — resolving the ACTOR's own AI key and billing them, on an
			// org's document. Fails closed.
			project: { select: { userId: true, organizationId: true } },
		},
	});
}

export type EnabledAutoRefreshSettings = Awaited<
	ReturnType<typeof listEnabledAutoRefreshSettings>
>[number];

/**
 * Resolves, in ONE query, which of the sweep's candidate documents may still run
 * under their stored actor.
 *
 * The rule itself is the newsletter's (`isScheduledActorValid`): the actor flows
 * into AI model resolution and usage logging, and org model resolution prefers
 * the actor's PERSONAL provider — so a member who has left the organization must
 * not keep paying for, or lending their model config to, a refresh that runs
 * without them. Skipping is recoverable: any current member re-saving the
 * setting re-homes the actor.
 *
 * What differs is the shape. The newsletter sweeps PROJECTS and can afford a
 * membership lookup each; this sweeps DOCUMENTS, so one project with twenty
 * enrolled documents would fire twenty identical queries every tick.
 *
 * Personal-context rows never touch the database: their rule is a plain equality
 * against the project owner, decided in memory here.
 */
export interface RefreshActorCandidate {
	documentId: string;
	projectId: string;
	createdByUserId: string;
	organizationId: string | null;
	/** The project owner, for personal-context rows. */
	ownerUserId: string | null;
}

export async function resolveValidRefreshActors(
	candidates: RefreshActorCandidate[],
): Promise<Set<string>> {
	const valid = new Set<string>();

	const orgCandidates = candidates.filter((c) => c.organizationId !== null);
	for (const c of candidates) {
		if (c.organizationId === null) {
			// `createdByUserId` has no FK, so a drifted id must not be trusted —
			// require it to BE the owner rather than merely look plausible.
			if (c.ownerUserId !== null && c.createdByUserId === c.ownerUserId) {
				valid.add(c.documentId);
			}
		}
	}

	if (orgCandidates.length === 0) {
		return valid;
	}

	const members = await db.member.findMany({
		where: {
			organizationId: {
				in: [
					...new Set(
						orgCandidates.map((c) => c.organizationId as string),
					),
				],
			},
			userId: {
				in: [...new Set(orgCandidates.map((c) => c.createdByUserId))],
			},
		},
		select: { organizationId: true, userId: true },
	});

	// Keyed on the PAIR. The two `in` clauses above form a cross product, so the
	// result can contain an (org, user) combination no candidate actually asked
	// about — matching on either half alone would wave through an actor who
	// belongs to a different one of the queried orgs.
	const memberships = new Set(
		members.map((m) => `${m.organizationId}:${m.userId}`),
	);

	// Org membership is necessary but NOT sufficient. The actor's identity decides
	// whose AI provider config resolves and whose usage is billed — and org model
	// resolution falls back to the actor's PERSONAL key when the org has none. A
	// member who was removed from the PROJECT (but is still in the org) would
	// otherwise keep paying, out of their own key, for unattended writes to a
	// project they can no longer open. Check the project, not just the org.
	const stillInOrg = orgCandidates.filter((c) =>
		memberships.has(`${c.organizationId}:${c.createdByUserId}`),
	);
	const projectAccess = await Promise.all(
		stillInOrg.map((c) =>
			hasProjectAccess(
				c.projectId,
				c.createdByUserId,
				c.organizationId ?? undefined,
			),
		),
	);
	stillInOrg.forEach((c, i) => {
		if (projectAccess[i]) {
			valid.add(c.documentId);
		}
	});

	return valid;
}

/**
 * Stamped before the model is called. A failed refresh never advances
 * `lastRefreshedAt`, so this is the only thing keeping the hourly sweep from
 * re-dispatching a persistently failing document every hour.
 */
export async function markRefreshAttempt(documentId: string, when: Date) {
	return db.documentAutoRefreshSettings.update({
		where: { documentId },
		data: { lastAttemptAt: when },
	});
}

/**
 * Stamped when a cycle COMPLETES — whether it committed a new version or judged
 * the document already current. A skipped or failed cycle must not call this,
 * or the document would silently lose a cadence interval.
 */
export async function completeRefreshCycle(
	documentId: string,
	result: {
		when: Date;
		status: DocumentRefreshCompletedStatus;
		summary: string | null;
	},
) {
	return db.documentAutoRefreshSettings.update({
		where: { documentId },
		data: {
			lastRefreshedAt: result.when,
			lastRefreshStatus: result.status,
			lastRefreshSummary: result.summary,
			// The deploy has been answered. Cleared on COMPLETION rather than on
			// dispatch, so a refresh that dies mid-flight leaves the document due
			// and the next sweep picks it up — the same "only a completed cycle
			// advances the clock" rule the cadences follow.
			//
			// Unconditional: it is already null for every time-based cadence, and
			// making the write conditional would need a read first for no gain.
			deployPendingSince: null,
		},
	});
}

/**
 * Mark every deploy-triggered document in a project as due.
 *
 * Called when an ingested CI run looks like a deployment. Deliberately a single
 * `updateMany` that sets a flag, NOT a dispatch: the hourly sweep already
 * refuses to overwrite a document somebody has open, refuses a stale enroller,
 * and fails a mis-tenanted row closed. A deploy-driven dispatcher would have to
 * reproduce all three, and the one it forgot would overwrite live human work.
 *
 * Idempotent by `deployPendingSince: null` in the filter: a second deploy while
 * one is already pending does not move the timestamp, so the marker records when
 * the document FIRST became due and a burst of deploys collapses to one refresh.
 */
export async function markDocumentsPendingDeploy(input: {
	projectId: string;
	at: Date;
}): Promise<number> {
	const { count } = await db.documentAutoRefreshSettings.updateMany({
		where: {
			projectId: input.projectId,
			enabled: true,
			cadence: "ON_DEPLOY",
			deployPendingSince: null,
		},
		data: { deployPendingSince: input.at },
	});
	return count;
}

/**
 * Stores a refresh's result WITHOUT writing it to the document — the default
 * mode. The cycle is complete (the model looked, and produced something), so
 * `lastRefreshedAt` advances: a proposal that nobody acts on must not cause the
 * document to be re-generated, and re-billed, every six hours forever.
 */
export async function storeRefreshProposal(
	documentId: string,
	proposal: {
		when: Date;
		content: string;
		summary: string;
		baselineVersion: number;
	},
) {
	return db.documentAutoRefreshSettings.update({
		where: { documentId },
		data: {
			pendingContent: proposal.content,
			pendingSummary: proposal.summary,
			pendingProposedAt: proposal.when,
			pendingBaselineVersion: proposal.baselineVersion,
			lastRefreshedAt: proposal.when,
			lastRefreshStatus: "PROPOSED",
			lastRefreshSummary: proposal.summary,
		},
	});
}

/** Accept or reject clears the proposal either way. */
export async function clearRefreshProposal(documentId: string) {
	return db.documentAutoRefreshSettings.update({
		where: { documentId },
		data: {
			pendingContent: null,
			pendingSummary: null,
			pendingProposedAt: null,
			pendingBaselineVersion: null,
		},
	});
}

/**
 * Records a cycle that did not complete. `lastRefreshedAt` is untouched, so the
 * document stays due and the next sweep (after the attempt backoff) retries it.
 */
export async function recordRefreshOutcome(
	documentId: string,
	status: DocumentRefreshFailureStatus,
	detail: string | null,
) {
	return db.documentAutoRefreshSettings.update({
		where: { documentId },
		data: { lastRefreshStatus: status, lastRefreshSummary: detail },
	});
}

/**
 * Batch form, for the sweep. Every document skipped for the same reason on one
 * tick gets the same static message, so writing them one at a time would be one
 * UPDATE per skipped document, every hour, forever. A no-op when nothing was
 * skipped.
 */
export async function recordRefreshOutcomes(
	documentIds: string[],
	status: DocumentRefreshFailureStatus,
	detail: string | null,
) {
	if (documentIds.length === 0) {
		return;
	}
	await db.documentAutoRefreshSettings.updateMany({
		where: { documentId: { in: documentIds } },
		data: { lastRefreshStatus: status, lastRefreshSummary: detail },
	});
}

export { isRefreshDue };
