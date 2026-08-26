/**
 * Push notifications for customer-facing status announcements.
 *
 * The status page is otherwise pull-only: an announcement appears and nothing tells
 * anyone it did. This is the push half.
 *
 * ## Why a stateless sweeper rather than a fan-out at publish time
 *
 * Looping over organizations inside the publish procedure would be wrong twice: it
 * scales with tenant count inside a single request (a human clicking "publish" waits
 * on thousands of writes, and the announcement may or may not exist depending on
 * where it died), and a retry would re-send something that cannot be recalled.
 *
 * So this runs on a schedule, leaves the publish path untouched, and keeps NO
 * "already notified" state. It scans a bounded lookback window, attempts the writes,
 * and lets the partial unique index on `(userId, dedupeKey)` absorb repeats — a
 * `P2002` means "already sent", exactly as `project-service-alert-digest` treats it.
 * Idempotence lives in the database, which is the only layer where at-least-once
 * delivery can actually be made safe.
 *
 * ## v1 scope, deliberately narrow
 *
 *  - **Only `MAJOR` / `CRITICAL` impact.** `NONE` is informational and must never
 *    notify; `MINOR` would train people to ignore these.
 *  - **Only platform-wide announcements** (empty `affectedProviderKeys`). Mapping
 *    provider keys to affected organizations needs the integration-provider registry,
 *    which this package deliberately cannot import — that belongs in the Temporal
 *    activity layer and is a follow-up.
 *  - **Only organization owners/admins.** They are the accountable parties, and
 *    notifying every member multiplies volume by team size.
 *  - **In-app only.** Email needs deliverability, unsubscribe and a sender identity.
 *
 * Gated by `FABRIC_STATUS_ANNOUNCEMENT_NOTIFICATIONS_ENABLED`, which the deployment
 * sets TRUE in every environment. It is the kill switch, not the rollout gate: the
 * decision that reaches customers is publishing the announcement, which is
 * admin-only, human-authored and already visible on the public status page. Setting
 * this false stops delivery on the next tick without a redeploy. Absent locally, so
 * the sweep is inert in development and tests. Note
 * `SYSTEM` is an always-on notification category — recipients cannot opt out — which
 * is defensible for "the platform is degraded" and is the reason the impact floor
 * above is set where it is.
 */

import { parseOptInFlag } from "@repo/utils/feature-flag";
import { db } from "../client";
import type { Prisma } from "../generated/client";

const ENABLED_ENV = "FABRIC_STATUS_ANNOUNCEMENT_NOTIFICATIONS_ENABLED";

/**
 * How far back the sweeper looks. Wide enough that a missed run recovers on the
 * next tick, narrow enough that re-enabling the flag does not notify about
 * week-old incidents.
 */
const LOOKBACK_HOURS = 24;

/**
 * How many organizations are pulled per page. Bounds memory and query size; it is
 * NOT a ceiling on coverage — the sweeper pages until the organizations are
 * exhausted.
 *
 * A truncating cap would have been wrong here, and subtly: this sweeper is
 * stateless by design, so "the rest next tick" has nowhere to record where it got
 * to. With a stable `id asc` ordering, every run would re-process the same first
 * page and organizations past it would never be notified at all.
 */
const ORGANIZATION_PAGE_SIZE = 500;

/**
 * Runaway backstop on pages per run, not a routine limit — 250 pages is 125,000
 * organizations. Tripping it means organizations went unnotified and the ceiling
 * needs raising, which is why it is reported rather than logged and forgotten.
 */
const MAX_ORGANIZATION_PAGES = 250;

/** Impacts that justify an unavoidable notification. */
const NOTIFIABLE_IMPACTS = ["MAJOR", "CRITICAL"] as const;

/** Lifecycles that mean "over" — no point announcing them as news. */
const TERMINAL_LIFECYCLES = ["RESOLVED", "COMPLETED"] as const;

/**
 * Organization roles that receive these. Lowercase, matching the org membership
 * role values (project roles are the uppercase ones).
 */
const NOTIFIABLE_ROLES = ["owner", "admin"] as const;

/** Matches the notification snippet ceiling enforced by `createNotification`. */
const SNIPPET_MAX_CHARS = 280;

/**
 * Truncate for the snippet, matching `incident-notifications.ts` and its siblings:
 * an ellipsis marks the cut, so a body that was shortened does not read as a
 * complete sentence that simply stops.
 *
 * Sliced by CODE POINT, not UTF-16 unit — `slice(0, 280)` can cut an emoji in half
 * and leave a lone surrogate, which renders as a broken glyph. Same reasoning, and
 * same fix, as `report-agent-loop.ts`.
 */
function truncateSnippet(text: string): string {
	const codePoints = Array.from(text);
	if (codePoints.length <= SNIPPET_MAX_CHARS) {
		return text;
	}
	return `${codePoints
		.slice(0, SNIPPET_MAX_CHARS - 1)
		.join("")
		.trimEnd()}…`;
}

/**
 * Rows per `createMany`.
 *
 * NOT derived from Postgres's parameter cap, which an earlier version of this
 * comment implied: at nine columns a row, 500 rows is ~4,500 parameters against a
 * 65,535 limit, and even a whole page in one statement (~1,500 rows) would sit
 * comfortably under it. The cap would not bind until roughly 7,000 rows.
 *
 * What this number actually sets is how many recipients one failed statement
 * delays by a tick — five minutes. 500 matches `ORGANIZATION_PAGE_SIZE` for easy
 * reasoning, and is a judgement call rather than something the database dictates.
 */
const WRITE_CHUNK_SIZE = 500;

export interface DispatchStatusAnnouncementNotificationsOutput {
	announcementsConsidered: number;
	announcementsNotified: number;
	recipientsNotified: number;
	/** Organizations examined this run. */
	organizationsScanned: number;
	/**
	 * Organizations left unreached because `MAX_ORGANIZATION_PAGES` was hit. Zero
	 * in every normal run; non-zero means coverage was incomplete and the backstop
	 * needs raising.
	 */
	organizationsDeferred: number;
	/**
	 * Per-recipient writes that failed for a reason other than the expected
	 * "already sent" case. Counted and logged by the workflow for later
	 * inspection — note that is a log line, not an alert or a metric, so a
	 * systematically failing fan-out still needs someone to go looking.
	 */
	writeFailures: number;
	skipped: boolean;
	skipReason?: string;
}

/**
 * One row per (announcement, organization, recipient).
 *
 * The organization belongs in the key because the row is org-scoped and the bell
 * filters on it — without it a person who is owner/admin of two organizations is
 * told in only one, silently.
 */
function dedupeKeyFor(
	announcementId: string,
	member: { organizationId: string; userId: string },
): string {
	return `status-announcement:${announcementId}:${member.organizationId}:${member.userId}`;
}

function isEnabled(): boolean {
	// The repo's canonical opt-in reader (`true`/`1`/`on`/`yes`, trimmed,
	// case-insensitive) rather than a strict `=== "true"`. A strict reader would
	// leave `…_ENABLED=1` off while looking enabled to the operator who set it —
	// the same "looks installed, does nothing" failure this feature's schedule
	// registration exists to avoid. `isTestCasesEnabled` is deliberately strict
	// for a different reason (it must match an API-layer gate that already was);
	// there is no second gate here to disagree with.
	return parseOptInFlag(process.env[ENABLED_ENV]);
}

/**
 * Notify organization owners/admins about live, high-impact status announcements.
 * Safe to run repeatedly: the dedupe key makes a second pass a no-op.
 */
export async function dispatchStatusAnnouncementNotifications(
	now: Date = new Date(),
	/**
	 * Called after every write batch and at the end of every organization page. The
	 * Temporal activity heartbeats here and reports whether the attempt has been
	 * cancelled — this package cannot import the Temporal SDK, so the caller owns
	 * both.
	 *
	 * Return `false` to stop the sweep. That is what makes cancellation real: the
	 * activity SDK delivers cancellation via a signal the caller must check, and a
	 * heartbeat alone does not interrupt anything (`heartbeat()`'s own type doc:
	 * "Cancellation is not propagated from this function"). Without an honoured stop
	 * request, a superseded attempt keeps writing to natural completion while its
	 * retry runs concurrently.
	 */
	onProgress?: (progress: {
		organizationsScanned: number;
		recipientsNotified: number;
		writeFailures: number;
	}) => boolean | void,
): Promise<DispatchStatusAnnouncementNotificationsOutput> {
	const empty: DispatchStatusAnnouncementNotificationsOutput = {
		announcementsConsidered: 0,
		announcementsNotified: 0,
		recipientsNotified: 0,
		organizationsScanned: 0,
		organizationsDeferred: 0,
		writeFailures: 0,
		skipped: false,
	};

	if (!isEnabled()) {
		return { ...empty, skipped: true, skipReason: "flag-disabled" };
	}

	const since = new Date(now.getTime() - LOOKBACK_HOURS * 3_600_000);

	const announcements = await db.statusUpdate.findMany({
		where: {
			impact: { in: [...NOTIFIABLE_IMPACTS] },
			lifecycle: { notIn: [...TERMINAL_LIFECYCLES] },
			startedAt: { gte: since },
			// A maintenance window scheduled for next week must not notify today.
			// `createStatusUpdate` defaults `startedAt` to publish time regardless of
			// `scheduledFor`, so lifecycle alone does not separate "happening now"
			// from "announced now, happening later" — SCHEDULED is not terminal and
			// would otherwise be treated exactly like a live incident.
			OR: [{ scheduledFor: null }, { scheduledFor: { lte: now } }],
			// Platform-wide only in v1 — see the scope note above.
			affectedProviderKeys: { isEmpty: true },
		},
		select: {
			id: true,
			title: true,
			body: true,
			impact: true,
			lifecycle: true,
			startedAt: true,
		},
		orderBy: { startedAt: "asc" },
	});

	if (announcements.length === 0) {
		return {
			...empty,
			skipped: true,
			skipReason: "no-notifiable-announcements",
		};
	}

	// Payload built once per announcement, ahead of the paging loop, and carried
	// alongside it — the shape is pinned by the STATUS_ANNOUNCEMENT schema
	// registered in `packages/api/modules/notifications/lib/payloads.ts`, which
	// this package cannot import without a workspace cycle.
	const notifiable = announcements.map((announcement) => ({
		announcement,
		payload: {
			statusUpdateId: announcement.id,
			impact: announcement.impact,
			lifecycle: announcement.lifecycle,
			startedAt: announcement.startedAt.toISOString(),
		} satisfies Prisma.InputJsonObject,
	}));

	let organizationsScanned = 0;
	let organizationsDeferred = 0;
	let recipientsNotified = 0;
	let writeFailures = 0;
	/** Announcement ids that reached at least one recipient this run. */
	const notifiedAnnouncementIds = new Set<string>();

	let cursor: string | undefined;
	let pages = 0;
	/** Set when the caller reports the attempt has been cancelled. */
	let stopRequested = false;

	while (true) {
		if (pages >= MAX_ORGANIZATION_PAGES) {
			// Count what is left so the shortfall is a number, not a silence.
			//
			// `cursor` is necessarily set here — reaching the page backstop means at
			// least MAX_ORGANIZATION_PAGES iterations have each assigned it. Guarded
			// explicitly anyway, because the failure mode is quiet and wrong rather
			// than loud: Prisma drops a `gt: undefined` filter, so the count would
			// silently become "every organization in the deployment" and report a
			// shortfall that never happened.
			organizationsDeferred = cursor
				? await db.organization.count({ where: { id: { gt: cursor } } })
				: 0;
			break;
		}

		const organizations = await db.organization.findMany({
			select: { id: true },
			orderBy: { id: "asc" },
			take: ORGANIZATION_PAGE_SIZE,
			...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
		});
		if (organizations.length === 0) {
			break;
		}
		pages++;
		organizationsScanned += organizations.length;
		cursor = organizations[organizations.length - 1]?.id;

		const members = await db.member.findMany({
			where: {
				organizationId: { in: organizations.map((o) => o.id) },
				role: { in: [...NOTIFIABLE_ROLES] },
			},
			select: { userId: true, organizationId: true },
		});

		// Which of this page's rows already exist — INDEPENDENT of read state.
		//
		// The partial unique index this sweeper relied on for idempotence is
		//   ON (userId, dedupeKey) WHERE readAt IS NULL AND archivedAt IS NULL
		// so it stops constraining a row the moment the recipient opens the bell.
		// That is harmless for an event-driven writer, because the event happens
		// once. This is a sweeper: it re-attempts the same write every five minutes
		// for as long as the announcement stays live, so "unique among unread rows"
		// is not idempotence — a recipient who read the notification would get a
		// fresh one on every tick for the whole 24-hour lookback window.
		//
		// One indexed lookup per page, served by `@@index([userId, dedupeKey,
		// createdAt])`, which carries no read-state predicate. It also removes most
		// of the P2002 round-trips the previous version spent on already-sent rows.
		const candidateKeys = notifiable.flatMap(({ announcement }) =>
			members.map((member) => dedupeKeyFor(announcement.id, member)),
		);
		const alreadySent = new Set<string>();
		if (candidateKeys.length > 0) {
			const existing = await db.notification.findMany({
				where: {
					type: "STATUS_ANNOUNCEMENT",
					userId: { in: members.map((m) => m.userId) },
					dedupeKey: { in: candidateKeys },
				},
				select: { userId: true, dedupeKey: true },
			});
			for (const row of existing) {
				if (row.dedupeKey) {
					alreadySent.add(`${row.userId}::${row.dedupeKey}`);
				}
			}
		}

		for (const { announcement, payload } of notifiable) {
			// Batched, not one INSERT per recipient. A page of 500 organizations at
			// ~3 owners/admins each is ~1,500 rows: sequential creates made that
			// ~1,500 round trips per announcement per tick, which is what pushed a
			// large deployment past the activity's 5-minute budget and made the
			// "retries reach further" story false — a retry re-walked the same
			// ground at the same cost.
			//
			// `skipDuplicates` compiles to INSERT ... ON CONFLICT DO NOTHING, which
			// covers the partial unique index without a conflict target and does not
			// throw, so it cannot poison a surrounding transaction the way a
			// create()/P2002 pair does. Its `count` is the number of rows actually
			// inserted, so races with a concurrent sweep are absorbed AND still
			// counted honestly.
			const pending = members
				.filter(
					(member) =>
						!alreadySent.has(
							`${member.userId}::${dedupeKeyFor(announcement.id, member)}`,
						),
				)
				.map((member) => ({
					userId: member.userId,
					organizationId: member.organizationId,
					type: "STATUS_ANNOUNCEMENT" as const,
					category: "SYSTEM" as const,
					title: announcement.title,
					// Already reviewed customer-safe prose, so it is the right
					// snippet — nothing can leak here that is not already on the
					// public page.
					snippet: truncateSnippet(announcement.body),
					// Context-relative on purpose: `resolveNotificationLink`
					// prepends the notification's OWN workspace base, giving
					// `/app/{slug}/system-health`. A leading slash would send every
					// recipient to the personal page instead.
					link: "system-health",
					payload,
					dedupeKey: dedupeKeyFor(announcement.id, member),
				}));

			// Chunked so one failed statement cannot lose a whole page's worth of
			// recipients, and so the failure count means something.
			for (let i = 0; i < pending.length; i += WRITE_CHUNK_SIZE) {
				if (stopRequested) {
					break;
				}
				const chunk = pending.slice(i, i + WRITE_CHUNK_SIZE);
				try {
					const { count } = await db.notification.createMany({
						data: chunk,
						skipDuplicates: true,
					});
					if (count > 0) {
						recipientsNotified += count;
						notifiedAnnouncementIds.add(announcement.id);
					}
				} catch {
					// Counted rather than swallowed, and logged by the workflow for
					// later inspection. No alert is wired, so this makes a failing
					// fan-out findable rather than self-announcing.
					writeFailures += chunk.length;
				}

				// Per CHUNK, not just per page. Heartbeat RPCs are throttled by the
				// SDK to 80% of `heartbeatTimeout` however often this is called, so
				// the extra calls cost nothing on the wire — and a page whose own
				// work stalls (a long dedupe IN-list, a row lock held by a zombie
				// sweep) would otherwise have no opportunity to heartbeat at all
				// until it finished.
				if (
					onProgress?.({
						organizationsScanned,
						recipientsNotified,
						writeFailures,
					}) === false
				) {
					stopRequested = true;
					break;
				}
			}
			if (stopRequested) {
				break;
			}
		}

		// End of page. Heartbeating keeps the server from timing the attempt out;
		// honouring a `false` return is what actually stops this loop once the
		// attempt HAS been superseded, so two passes cannot write the same rows.
		if (
			stopRequested ||
			onProgress?.({
				organizationsScanned,
				recipientsNotified,
				writeFailures,
			}) === false
		) {
			break;
		}
	}

	return {
		announcementsConsidered: announcements.length,
		announcementsNotified: notifiedAnnouncementIds.size,
		recipientsNotified,
		organizationsScanned,
		organizationsDeferred,
		writeFailures,
		skipped: false,
	};
}
