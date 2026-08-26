/**
 * Weekly per-project service-alert digest (Notification Center Preferences AC-9).
 *
 * Replaces per-incident service-alert spam with ONE Monday roll-up per project,
 * delivered only to that project's admins (OWNER / PROJECT_ADMIN) — the DSU
 * 6/2/2026 decision. Lives in `@repo/database` so it can run from a Temporal
 * activity (`@repo/api` depends on `@repo/temporal`, so the activity cannot
 * import an API-side helper). Mirrors `incident-weekly-digest.ts`, but scoped to
 * project admins rather than platform admins.
 *
 * "Service alerts" for a project = the week's PM-sync FAILURE + CONFLICT log
 * rows (`PmSyncLog`). The digest notification is category SYSTEM (always-on —
 * NOT user-suppressible via Notification Center Preferences) and type
 * PROJECT_SERVICE_ALERT_DIGEST.
 *
 * Server-side admin gating (AC-12): rows are written ONLY for OWNER /
 * PROJECT_ADMIN members (plus a personal project's owner), so a non-admin never
 * receives one and the notifications API — which only ever returns the caller's
 * own rows — yields nothing for them.
 */
import { db, type Prisma } from "../client";

export type ProjectServiceAlertDigestResult = {
	projectsNotified: number;
	adminsNotified: number;
	skipped: boolean;
	skipReason?: string;
};

type ProjectAlertTally = {
	syncFailureCount: number;
	conflictCount: number;
	total: number;
};

/**
 * Write one PROJECT_SERVICE_ALERT_DIGEST notification per (project admin) for
 * every project that had ≥1 PM-sync failure/conflict in the prior week.
 *
 * Window: `[weekEnd - 7d, weekEnd)`. No-op when no project had alerts.
 * Best-effort: per-row write failures (incl. P2002 dedupe collisions) are
 * swallowed so the weekly cron is never blocked.
 *
 * Dedupe: `project-service-digest:<projectId>:<weekKey>:<userId>` — one row per
 * project admin per ISO week-ending date, coalesced by the live-unread index.
 */
export async function dispatchProjectServiceAlertDigest(
	weekEnd: Date,
): Promise<ProjectServiceAlertDigestResult> {
	const weekStart = new Date(weekEnd);
	weekStart.setUTCDate(weekStart.getUTCDate() - 7);
	const weekKey = weekEnd.toISOString().slice(0, 10);

	// 1) Aggregate the week's failure/conflict sync-log rows per project.
	const logs = await db.pmSyncLog.findMany({
		where: {
			createdAt: { gte: weekStart, lt: weekEnd },
			status: { in: ["FAILURE", "CONFLICT"] },
			projectId: { not: null },
		},
		select: { projectId: true, status: true },
	});

	if (logs.length === 0) {
		return {
			projectsNotified: 0,
			adminsNotified: 0,
			skipped: true,
			skipReason: "no-alerts-this-week",
		};
	}

	const tallyByProject = new Map<string, ProjectAlertTally>();
	for (const row of logs) {
		if (!row.projectId) {
			continue;
		}
		const tally = tallyByProject.get(row.projectId) ?? {
			syncFailureCount: 0,
			conflictCount: 0,
			total: 0,
		};
		if (row.status === "CONFLICT") {
			tally.conflictCount++;
		} else {
			tally.syncFailureCount++;
		}
		tally.total++;
		tallyByProject.set(row.projectId, tally);
	}

	const projectIds = Array.from(tallyByProject.keys());

	// 2) Resolve project metadata + admin recipients in two batched queries.
	const [projects, members] = await Promise.all([
		db.project.findMany({
			where: { id: { in: projectIds } },
			select: {
				id: true,
				name: true,
				organizationId: true,
				userId: true,
			},
		}),
		db.projectMember.findMany({
			where: {
				projectId: { in: projectIds },
				role: { in: ["OWNER", "PROJECT_ADMIN"] },
				acceptedAt: { not: null },
				// Exclude lapsed temporary admins — parity with access-filter.ts
				// and the AC-7 query, so an expired member isn't sent a digest.
				OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
			},
			select: { projectId: true, userId: true },
		}),
	]);

	const adminsByProject = new Map<string, Set<string>>();
	for (const member of members) {
		const set = adminsByProject.get(member.projectId) ?? new Set<string>();
		set.add(member.userId);
		adminsByProject.set(member.projectId, set);
	}

	// An org project's creator (project.userId) is its de-facto owner but has no
	// ProjectMember row, so the admin query above misses them. Include such a
	// creator ONLY if they still belong to the host org — a creator who left the
	// org must not receive the digest (nor get an unread-count bump from an
	// orphaned row). Resolved in one batched Member lookup. Personal projects
	// (organizationId === null) are handled separately — their owner is always
	// the recipient.
	const orgCreatorCandidates = projects.filter(
		(p) => p.organizationId !== null && p.userId,
	);
	const activeOrgCreators = new Set<string>();
	if (orgCreatorCandidates.length > 0) {
		const memberships = await db.member.findMany({
			where: {
				OR: orgCreatorCandidates.map((p) => ({
					userId: p.userId,
					organizationId: p.organizationId as string,
				})),
			},
			select: { userId: true, organizationId: true },
		});
		for (const m of memberships) {
			activeOrgCreators.add(`${m.organizationId}:${m.userId}`);
		}
	}

	// 3) Fan out one digest row per (project, admin).
	let projectsNotified = 0;
	let adminsNotified = 0;

	for (const project of projects) {
		const tally = tallyByProject.get(project.id);
		if (!tally) {
			continue;
		}

		const recipientIds =
			adminsByProject.get(project.id) ?? new Set<string>();
		// Owner/creator: a personal project's owner is always its admin; an org
		// project's creator only if they still belong to the host org (above).
		if (project.userId) {
			if (project.organizationId === null) {
				recipientIds.add(project.userId);
			} else if (
				activeOrgCreators.has(
					`${project.organizationId}:${project.userId}`,
				)
			) {
				recipientIds.add(project.userId);
			}
		}
		if (recipientIds.size === 0) {
			continue;
		}

		const title = `Weekly service alert summary: ${tally.total} alert${
			tally.total === 1 ? "" : "s"
		} in ${project.name} (week ending ${weekKey})`;
		const snippet = `${tally.syncFailureCount} sync failure${
			tally.syncFailureCount === 1 ? "" : "s"
		} · ${tally.conflictCount} conflict${
			tally.conflictCount === 1 ? "" : "s"
		}`;
		const link = `projects/${project.id}`;
		const payload = {
			projectId: project.id,
			projectName: project.name,
			weekKey,
			weekStart: weekStart.toISOString(),
			weekEnd: weekEnd.toISOString(),
			totalAlerts: tally.total,
			syncFailureCount: tally.syncFailureCount,
			conflictCount: tally.conflictCount,
			link,
		} satisfies Prisma.InputJsonObject;

		let notifiedForProject = 0;
		for (const userId of recipientIds) {
			try {
				await db.notification.create({
					data: {
						userId,
						organizationId: project.organizationId,
						type: "PROJECT_SERVICE_ALERT_DIGEST",
						category: "SYSTEM",
						title,
						snippet,
						link,
						projectId: project.id,
						payload,
						dedupeKey: `project-service-digest:${project.id}:${weekKey}:${userId}`,
					},
				});
				notifiedForProject++;
			} catch (error) {
				// P2002 = already sent this week's digest to this admin; other
				// errors are swallowed (best-effort, like the platform digest).
				const code = (error as { code?: string } | null)?.code;
				if (code !== "P2002") {
					// Intentionally silent: weekly digest is best-effort.
				}
			}
		}

		if (notifiedForProject > 0) {
			projectsNotified++;
			adminsNotified += notifiedForProject;
		}
	}

	return { projectsNotified, adminsNotified, skipped: false };
}
