/**
 * Incident notification dispatch.
 *
 * Lives in `@repo/database` (alongside agent-reply-notifications.ts and
 * pm-conflict-notifications.ts) so it can be invoked from `@repo/temporal`
 * activities. `@repo/api` depends on `@repo/temporal`, so the activity cannot
 * import the API-side notification-service helper without a circular
 * dependency.
 *
 * The payload shape is the same as the Zod schema in
 * `packages/api/modules/notifications/lib/payloads.ts` for the
 * INTEGRATION_INCIDENT and SYSTEM_INCIDENT types — keep both in lock-step:
 *
 *   { incidentId, providerKey?, severity, summary, link, startedAt }
 *
 * Severity routing (v3 admin-incidents pass — admin-only):
 *   - SEV-1: one Notification row per Fabric admin (User.role === "admin").
 *   - SEV-2: one Notification row per Fabric admin. Previously, integration
 *            SEV-2 rolled up to org *owners* (Member.role === "owner") for
 *            affected orgs. That branch was dropped — org-owner inboxes
 *            no longer surface platform-wide incident rows. The per-org
 *            integration BANNER on each customer's settings page is still
 *            the right surface for affected-tenant visibility; the incident
 *            inbox is admin-only.
 *   - SEV-3: in-app only Notification per admin. No Action Group / webhook
 *            dispatch; the in-app inbox suffices (the weekly digest job
 *            summarizes these in bulk).
 *
 * NON-NEGOTIABLE: this helper does NOT call Teams/Slack/email webhooks.
 * Direct outbound notification delivery happens via Alertmanager posting
 * directly to the existing Power Automate flow at ${ALERTS_WEBHOOK_URL}
 * (the same flow the parent app-downtime feature's Action Group posts to).
 * The Power Automate flow then fans out to Teams + Slack + email. This
 * helper is responsible only for the in-app Notification rows.
 *
 * Dedupe keys:
 *   - Admin rows:        `system-incident-${incidentId}:${userId}`
 * The existing 60s partial-unique index on (userId, dedupeKey) prevents
 * duplicates within the window.
 *
 * Historical note: prior versions emitted per-org rollups using
 * `integration-incident-${incidentId}:${userId}`. That branch was removed
 * in the v3 admin-incidents pass — see top of file. The legacy dedupe-key
 * prefix is still consulted in helper functions for back-compat with any
 * in-flight rows, but no new rows with that prefix are emitted.
 *
 * The helper swallows failures: notification dispatch must never break the
 * caller. P2002 (dedup collision) is also swallowed — the existing row stands.
 */
import { db, type Prisma } from "../client";
import type {
	IncidentSeverity,
	IncidentSource,
	IncidentTarget,
} from "./incident-notifications-types";

export type {
	IncidentNotificationPayload,
	IncidentSeverity,
	IncidentSource,
	IncidentTarget,
} from "./incident-notifications-types";

const SNIPPET_MAX_LENGTH = 280;

function truncate(text: string): string {
	if (text.length <= SNIPPET_MAX_LENGTH) {
		return text;
	}
	return `${text.slice(0, SNIPPET_MAX_LENGTH - 1).trimEnd()}…`;
}

export type CreateIncidentNotificationInput = {
	/**
	 * Discriminates the canonical row. `errorRate` → admin SYSTEM_INCIDENT
	 * notifications. `integration` → per-org INTEGRATION_INCIDENT rollups.
	 */
	source: IncidentSource;
	incidentId: string;
	severity: IncidentSeverity;
	/** Short human title used as Notification.title (e.g., "SEV-1: api/ai_generation error budget burn"). */
	title: string;
	/** Free-text incident summary. Truncated to 280 chars. */
	summary: string;
	/** Link target (admin: `/app/admin/monitoring?incident={id}`; per-org: `/app/{slug}/settings/integrations`). */
	link: string;
	/** Incident `firedAt` / `startedAt` timestamp. Persisted in payload as ISO 8601. */
	startedAt: Date;
	/**
	 * Optional integration-source registry key (e.g., "openai", "stripe").
	 * Required for INTEGRATION_INCIDENT routing in the per-org SEV-2 path
	 * because we use it to look up affected DataConnection rows.
	 */
	providerKey?: string;
	/**
	 * Routing override. When omitted, severity drives routing.
	 * Tests and the recovery path (closeIncident) can force a specific target
	 * (e.g., "admin" only for a recovery summary) without re-running the
	 * severity matrix.
	 */
	target?: IncidentTarget;
};

export type CreateIncidentNotificationResult = {
	adminRowsWritten: number;
	perOrgRowsWritten: number;
	skipped: boolean;
	skipReason?: string;
};

/**
 * Insert Notification rows for an incident.
 *
 * Returns a summary of writes. Never throws — caller (Temporal activity)
 * treats notification dispatch as best-effort.
 */
export async function createIncidentNotification(
	input: CreateIncidentNotificationInput,
): Promise<CreateIncidentNotificationResult> {
	const result: CreateIncidentNotificationResult = {
		adminRowsWritten: 0,
		perOrgRowsWritten: 0,
		skipped: false,
	};

	const target = input.target ?? defaultTargetForSeverity(input.severity);
	if (target === "none") {
		result.skipped = true;
		result.skipReason = `no-routing-for-severity:${input.severity}`;
		return result;
	}

	const sharedPayload = {
		incidentId: input.incidentId,
		providerKey: input.providerKey,
		severity: input.severity,
		summary: truncate(input.summary),
		link: input.link,
		startedAt: input.startedAt.toISOString(),
	} satisfies Record<string, unknown>;

	if (target === "admins" || target === "admins+orgs") {
		result.adminRowsWritten = await insertAdminNotifications({
			incidentId: input.incidentId,
			title: input.title,
			summary: sharedPayload.summary,
			link: input.link,
			payload: sharedPayload,
		});
	}

	if (target === "orgs" || target === "admins+orgs") {
		// Integration source is required for per-org routing (we look up
		// affected DataConnection rows by provider). Without it, skip the org
		// path silently — admin rows above still went out.
		if (input.source === "integration" && input.providerKey) {
			result.perOrgRowsWritten = await insertPerOrgNotifications({
				incidentId: input.incidentId,
				providerKey: input.providerKey,
				title: input.title,
				summary: sharedPayload.summary,
				link: input.link,
				payload: sharedPayload,
			});
		}
	}

	return result;
}

/**
 * Severity → target mapping (v3 admin-incidents pass — admin-only).
 *
 * As of the v3 admin-incidents pass, all in-app incident notifications are
 * admin-only. Previously SEV-1 / SEV-2 integration incidents fanned out to
 * org owners; that branch was dropped because org owners cannot act on
 * platform-wide incident triage from the customer dashboard. Per-org
 * visibility lives in the integration banner on each customer's settings
 * page (a separate UI surface), not in the notification inbox.
 *
 * - SEV-1: admin Notification per system admin.
 * - SEV-2: admin Notification per system admin.
 * - SEV-3: admin Notification per system admin; no Action Group / webhook;
 *          weekly digest job batches these for the morning admin email.
 *
 * The `target = "orgs"` and `target = "admins+orgs"` enum values are
 * retained in the public type so test fixtures that explicitly opt-in
 * (e.g., to simulate the legacy v1 routing for back-compat tests) still
 * compile. The default mapping never returns them.
 */
function defaultTargetForSeverity(severity: IncidentSeverity): IncidentTarget {
	switch (severity) {
		case "sev1":
			return "admins";
		case "sev2":
			return "admins";
		case "sev3":
			return "admins";
		default:
			return "none";
	}
}

async function insertAdminNotifications(args: {
	incidentId: string;
	title: string;
	summary: string;
	link: string;
	payload: Record<string, unknown>;
}): Promise<number> {
	const admins = await db.user.findMany({
		where: { role: "admin" },
		select: { id: true },
	});

	if (admins.length === 0) {
		return 0;
	}

	const writes = await Promise.all(
		admins.map((admin) =>
			tryInsert({
				userId: admin.id,
				organizationId: null,
				type: "SYSTEM_INCIDENT",
				title: args.title,
				summary: args.summary,
				link: args.link,
				payload: args.payload,
				dedupeKey: `system-incident-${args.incidentId}:${admin.id}`,
			}),
		),
	);
	return writes.filter(Boolean).length;
}

async function insertPerOrgNotifications(args: {
	incidentId: string;
	providerKey: string;
	title: string;
	summary: string;
	link: string;
	payload: Record<string, unknown>;
}): Promise<number> {
	// Map provider registry key → DataConnectionProvider enum to find affected
	// orgs. We look up registry first because not every providerKey maps to
	// a DataConnection (platform providers like OpenAI/Stripe/Resend live in
	// the registry without a DataConnection counterpart). When no enum match
	// exists, no per-org rollup is emitted — those incidents already go to
	// admins via the SEV path above.
	const registry = await db.integrationProviderRegistry.findUnique({
		where: { providerKey: args.providerKey },
		select: { dataConnectionProvider: true },
	});

	const dcProvider = registry?.dataConnectionProvider;
	if (!dcProvider) {
		return 0;
	}

	// Active DataConnections — exclude PAUSED / EXPIRED so we don't ping orgs
	// whose connection is already in a known-bad state. We cast through string
	// because the registry stores the enum value as a raw string; Prisma's
	// generated where input still narrows it via the enum union at runtime.
	const affectedConnections = await db.dataConnection.findMany({
		where: {
			provider: dcProvider as never,
			status: { in: ["CONNECTED", "SYNCING", "ERROR"] as never },
		},
		select: { organizationId: true, userId: true },
	});

	if (affectedConnections.length === 0) {
		return 0;
	}

	// Group connections by tenant scope (org-scoped vs personal-scoped).
	const affectedOrgIds = new Set<string>();
	const affectedPersonalUserIds = new Set<string>();
	for (const conn of affectedConnections) {
		if (conn.organizationId) {
			affectedOrgIds.add(conn.organizationId);
		} else if (conn.userId) {
			affectedPersonalUserIds.add(conn.userId);
		}
	}

	let perOrgRows = 0;

	if (affectedOrgIds.size > 0) {
		// Look up the OWNER members for each affected org. Per ,
		// org-scoped rollups land in owners' inboxes (not every member, to
		// avoid notification storms).
		const owners = await db.member.findMany({
			where: {
				organizationId: { in: Array.from(affectedOrgIds) },
				role: "owner",
			},
			select: { userId: true, organizationId: true },
		});

		const ownerWrites = await Promise.all(
			owners.map((m) =>
				tryInsert({
					userId: m.userId,
					organizationId: m.organizationId,
					type: "INTEGRATION_INCIDENT",
					title: args.title,
					summary: args.summary,
					link: args.link,
					payload: args.payload,
					dedupeKey: `integration-incident-${args.incidentId}:${m.userId}`,
				}),
			),
		);
		perOrgRows += ownerWrites.filter(Boolean).length;
	}

	if (affectedPersonalUserIds.size > 0) {
		// Personal-scope DataConnections (userId set, organizationId null)
		// fire one Notification per user. The XOR is preserved: organizationId
		// is null on the Notification row, matching the personal scope.
		const personalWrites = await Promise.all(
			Array.from(affectedPersonalUserIds).map((userId) =>
				tryInsert({
					userId,
					organizationId: null,
					type: "INTEGRATION_INCIDENT",
					title: args.title,
					summary: args.summary,
					link: args.link,
					payload: args.payload,
					dedupeKey: `integration-incident-${args.incidentId}:${userId}`,
				}),
			),
		);
		perOrgRows += personalWrites.filter(Boolean).length;
	}

	return perOrgRows;
}

async function tryInsert(args: {
	userId: string;
	organizationId: string | null;
	type: "SYSTEM_INCIDENT" | "INTEGRATION_INCIDENT";
	title: string;
	summary: string;
	link: string;
	payload: Record<string, unknown>;
	dedupeKey: string;
}): Promise<boolean> {
	try {
		await db.notification.create({
			data: {
				userId: args.userId,
				organizationId: args.organizationId,
				type: args.type,
				category: "SYSTEM",
				title: args.title,
				snippet: args.summary,
				link: args.link,
				payload: args.payload as Prisma.InputJsonValue,
				dedupeKey: args.dedupeKey,
			},
		});
		return true;
	} catch (error) {
		// Coalesce on dedupe-key collision; swallow other errors so the
		// caller (incident lifecycle activity) is never blocked by
		// notification writes.
		const code = (error as { code?: string } | null)?.code;
		if (code === "P2002") {
			return false;
		}
		// Intentionally silent: notification dispatch is best-effort. Errors
		// other than dedup collisions are surfaced via the upstream app_errors
		// counter when the caller observes a zero write count.
		return false;
	}
}
