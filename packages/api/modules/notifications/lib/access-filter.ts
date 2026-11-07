/**
 * Read-time RBAC re-check for notifications.
 *
 * A notification is created at write time when the recipient could plausibly
 * access the source resource (mentioned/assigned/replied-to). Membership can
 * change between write and read — a guest may be removed from a project,
 * an org member may lose access. This filter drops rows whose source the
 * caller can no longer see, while keeping system / account-scope rows that
 * carry no projectId.
 */

import {
	db,
	getTemplateInstanceExecution,
	type Notification,
} from "@repo/database";

export async function filterByCurrentAccess(
	notifications: Notification[],
	userId: string,
): Promise<Notification[]> {
	// Report deliveries retain their original admitted audience. Re-check that
	// audience even for company-wide reports with no projectId.
	const executions = new Map<string, Promise<boolean>>();
	const visibility = await Promise.all(
		notifications.map(async (notification) => {
			if (
				notification.type !== "REPORT_COMPLETED" &&
				notification.type !== "REPORT_FAILED"
			) {
				return true;
			}
			const payload = notification.payload;
			if (
				!notification.organizationId ||
				!payload ||
				typeof payload !== "object" ||
				Array.isArray(payload) ||
				typeof payload.executionId !== "string"
			) {
				return false;
			}
			const key = `${notification.organizationId}:${payload.executionId}`;
			let access = executions.get(key);
			if (!access) {
				access = getTemplateInstanceExecution(payload.executionId, {
					userId,
					organizationId: notification.organizationId,
				}).then(
					(execution) =>
						!!execution && execution.status !== "CANCELLED",
				);
				executions.set(key, access);
			}
			return access;
		}),
	);
	const visibleNotifications = notifications.filter(
		(_, index) => visibility[index],
	);
	const projectIds = Array.from(
		new Set(
			visibleNotifications
				.map((n) => n.projectId)
				.filter((id): id is string => typeof id === "string"),
		),
	);
	if (projectIds.length === 0) {
		return visibleNotifications;
	}

	// Single bulk query mirroring `requireProjectPermission` resolution paths:
	//  A. Personal-project owner: project.userId === userId AND no org.
	//  B. Active ProjectMember row (acceptedAt set, not expired).
	//  C. OrgMember of the project's host org.
	// Any project matching one of these is allowed.
	const now = new Date();
	const allowedProjects = await db.project.findMany({
		where: {
			id: { in: projectIds },
			OR: [
				// Path A
				{ userId, organizationId: null },
				// Path B
				{
					members: {
						some: {
							userId,
							acceptedAt: { not: null },
							OR: [
								{ expiresAt: null },
								{ expiresAt: { gt: now } },
							],
						},
					},
				},
				// Path C
				{
					organization: {
						members: { some: { userId } },
					},
				},
			],
		},
		select: { id: true },
	});
	const allowed = new Set(allowedProjects.map((p) => p.id));

	return visibleNotifications.filter(
		(n) => n.projectId === null || allowed.has(n.projectId),
	);
}
