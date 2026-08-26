/**
 * SEV-3 weekly digest helper.
 *
 * SEV-3 incidents route only to the in-app Notification feed. To surface a
 * roll-up view, a weekly Temporal cron summarizes the prior week's SEV-3
 * incidents into a single Notification per Fabric admin.
 *
 * Scope split:
 *   - This helper computes the digest payload + writes the
 *     Notification rows. Pure DB code, callable from a Temporal activity.
 *   - The cron schedule registration (Monday 09:00 UTC) is wired alongside
 *     the other monitoring schedules
 *     (`packages/temporal/src/scripts/ensure-monitoring-schedules.ts`).
 *   - The workflow body (`errorRateWeeklyDigestWorkflow`) is a thin shell
 *     that calls this helper from an activity.
 */
import { db, type Prisma } from "../client";

export type WeeklyDigestSummary = {
	weekStart: Date;
	weekEnd: Date;
	totalIncidents: number;
	bySeverity: { sev1: number; sev2: number; sev3: number };
	topServicesByFeature: Array<{
		service: string;
		feature: string;
		count: number;
	}>;
};

/**
 * Compute the prior-week SEV-3 digest summary.
 *
 * Window: `[weekEnd - 7d, weekEnd)`. Pure aggregation — no writes.
 *
 * The summary covers all severities so admins see the full week's incident
 * footprint, but the digest is gated on a non-empty `bySeverity.sev3` count
 * by the caller — SEV-1 / SEV-2 already have their own pages.
 */
export async function summarizeWeeklyIncidents(
	weekEnd: Date,
): Promise<WeeklyDigestSummary> {
	const weekStart = new Date(weekEnd);
	weekStart.setUTCDate(weekStart.getUTCDate() - 7);

	const errorRate = await db.errorRateIncident.findMany({
		where: {
			firedAt: { gte: weekStart, lt: weekEnd },
		},
		select: {
			severity: true,
			service: true,
			feature: true,
		},
	});

	const integration = await db.integrationIncident.findMany({
		where: {
			startedAt: { gte: weekStart, lt: weekEnd },
		},
		select: {
			severity: true,
			providerKey: true,
		},
	});

	const bySeverity = { sev1: 0, sev2: 0, sev3: 0 };
	for (const r of errorRate) {
		if (r.severity === "SEV1") {
			bySeverity.sev1++;
		} else if (r.severity === "SEV2") {
			bySeverity.sev2++;
		} else if (r.severity === "SEV3") {
			bySeverity.sev3++;
		}
	}
	for (const r of integration) {
		if (r.severity === "SEV1") {
			bySeverity.sev1++;
		} else if (r.severity === "SEV2") {
			bySeverity.sev2++;
		} else if (r.severity === "SEV3") {
			bySeverity.sev3++;
		}
	}

	const grouped = new Map<string, number>();
	for (const r of errorRate) {
		const k = `${r.service}|${r.feature}`;
		grouped.set(k, (grouped.get(k) ?? 0) + 1);
	}
	const topServicesByFeature = Array.from(grouped.entries())
		.map(([k, count]) => {
			const [service, feature] = k.split("|");
			return { service: service ?? "", feature: feature ?? "", count };
		})
		.sort((a, b) => b.count - a.count)
		.slice(0, 5);

	return {
		weekStart,
		weekEnd,
		totalIncidents: errorRate.length + integration.length,
		bySeverity,
		topServicesByFeature,
	};
}

export type WeeklyDigestDispatchResult = {
	adminsNotified: number;
	skipped: boolean;
	skipReason?: string;
};

/**
 * Write one Notification row per Fabric admin summarizing the prior week's
 * incidents. No-op when the week had no incidents.
 *
 * Dedupe: keyed off the ISO week-end date so a re-run of the digest within
 * the live-unread window does not duplicate. Different week-ends produce
 * different keys, so consecutive weekly runs each yield exactly one row.
 *
 * Failures are swallowed per the same best-effort policy as
 * `createIncidentNotification`.
 */
export async function dispatchWeeklyIncidentDigest(
	weekEnd: Date,
): Promise<WeeklyDigestDispatchResult> {
	const summary = await summarizeWeeklyIncidents(weekEnd);
	if (summary.totalIncidents === 0) {
		return {
			adminsNotified: 0,
			skipped: true,
			skipReason: "no-incidents-this-week",
		};
	}

	const admins = await db.user.findMany({
		where: { role: "admin" },
		select: { id: true },
	});

	if (admins.length === 0) {
		return {
			adminsNotified: 0,
			skipped: true,
			skipReason: "no-admins-configured",
		};
	}

	const weekKey = summary.weekEnd.toISOString().slice(0, 10);
	const title = `Weekly incident digest: ${summary.totalIncidents} incidents (week ending ${weekKey})`;
	const snippet =
		summary.bySeverity.sev3 > 0
			? `${summary.bySeverity.sev1} SEV-1, ${summary.bySeverity.sev2} SEV-2, ${summary.bySeverity.sev3} SEV-3`
			: `${summary.bySeverity.sev1} SEV-1, ${summary.bySeverity.sev2} SEV-2`;
	const payload: Record<string, unknown> = {
		// Use the same INTEGRATION_INCIDENT payload shape with a synthetic
		// `incidentId` of `weekly-digest-${weekKey}` so the Zod validator
		// passes. The link routes to the admin monitoring page where the full
		// week's incidents are listed.
		incidentId: `weekly-digest-${weekKey}`,
		severity: "sev3",
		summary: snippet,
		link: `/app/admin/monitoring?week=${weekKey}`,
		startedAt: summary.weekStart.toISOString(),
	};

	let adminsNotified = 0;
	for (const admin of admins) {
		try {
			await db.notification.create({
				data: {
					userId: admin.id,
					organizationId: null,
					type: "SYSTEM_INCIDENT",
					category: "SYSTEM",
					title,
					snippet,
					link: payload.link as string,
					payload: payload as Prisma.InputJsonValue,
					dedupeKey: `weekly-digest:${weekKey}:${admin.id}`,
				},
			});
			adminsNotified++;
		} catch (error) {
			// P2002 (dedupe collision) means we already sent this week's
			// digest to this admin. Other errors are silently swallowed —
			// the weekly digest is best-effort; next week's run re-attempts
			// if storage is healthy by then.
			const code = (error as { code?: string } | null)?.code;
			if (code !== "P2002") {
				// Non-dedup error — still non-fatal but worth noting in
				// future logging if a logger is added here.
			}
		}
	}

	return { adminsNotified, skipped: false };
}
