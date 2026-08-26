import type { NotificationType } from "@repo/database";

/**
 * Incident/alert notification types that are **no longer surfaced in the
 * notification bell**. Incidents moved off the per-user inbox entirely — the
 * durable record now lives in the admin monitoring "Incident history" timeline
 * (active + resolved, every stream), and outbound Teams/Slack/email still flows
 * via Alertmanager → Power Automate. Dispatch of these rows is disabled at the
 * source (`notifyIncident` activity is a no-op); this list is the read-side
 * guard that also hides any pre-existing rows from the list + unread count.
 */
// Plain string literals (the Prisma enum's values) typed as `NotificationType[]`
// via a TYPE-ONLY import — so this module has no runtime dependency on the
// `@repo/database` enum object. That keeps it safe to import from code paths
// whose tests `vi.mock("@repo/database")` without re-exporting `NotificationType`
// (they would otherwise crash at module load reading `NotificationType.*`).
export const INCIDENT_NOTIFICATION_TYPES: NotificationType[] = [
	"SYSTEM_INCIDENT",
	"INTEGRATION_INCIDENT",
];

/**
 * Dedupe-key prefix of the **weekly incident digest** (`dispatchWeeklyIncidentDigest`
 * in `@repo/database`). The digest is the one incident-typed notification we
 * deliberately KEEP in the bell — a low-noise, once-a-week summary, not the
 * per-incident spam. It shares the `SYSTEM_INCIDENT` type with the per-incident
 * rows, so the notification list + unread-count queries exclude
 * `INCIDENT_NOTIFICATION_TYPES` *except* rows whose dedupe key starts with this
 * prefix. MUST stay in sync with the digest's dedupe key (`weekly-digest:<week>:<admin>`).
 */
export const WEEKLY_DIGEST_DEDUPE_PREFIX = "weekly-digest";
