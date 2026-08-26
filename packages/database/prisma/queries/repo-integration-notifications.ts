/**
 * Repository-integration credential-expiry notification dispatch.
 *
 * Mirrors the `fanOut.*` helpers in `@repo/api/lib/notification-service`, but
 * lives in `@repo/database` so it can be invoked from `@repo/temporal`
 * activities (`@repo/api` depends on `@repo/temporal`, so the activity cannot
 * import the API-side helper without a circular dependency). This is the same
 * pattern used by `incident-notifications.ts`, `agent-reply-notifications.ts`,
 * and `pm-conflict-notifications.ts`.
 *
 * Emitted by the scheduled repo health check
 * (`packages/temporal/src/activities/repo-health-check.ts`) when a project
 * repository integration transitions into an expired / auth-failed state and
 * auto-refresh cannot recover. Recipients are the user who connected the repo
 * (`configuredByUserId`) PLUS the project's owners/admins — the people with the
 * access to re-authenticate. Callers gate on a present configurer before
 * dispatching; resolving owners/admins broadens the audience beyond just the
 * connector.
 *
 * - Writes one `REPO_INTEGRATION_TOKEN_EXPIRED` notification row PER recipient
 *   (category `PROJECT`, so the inbox renders the project flag icon), deduped
 *   per recipient so a configurer who is also an owner gets a single row.
 * - Never throws — failures are swallowed so the calling activity (and the
 *   health check) is never blocked by notification dispatch. P2002
 *   (dedupe-key collision on the live-unread partial unique index) is also
 *   swallowed — the existing unread row stands.
 *
 * Transition-only firing (i.e. notify on the FIRST cycle that flips the row
 * into expired, not every 30-minute re-check) is the CALLER's responsibility:
 * the health check gates this call on `setIntegrationStatus(...)` reporting a
 * genuine status change away from the expired state. This helper itself just
 * writes the row; the `dedupeKey` is a secondary guard against double-writes
 * within a single transition.
 */
import {
	db,
	NotificationCategory,
	NotificationType,
	ProjectMemberRole,
} from "../client";
import { getEnabledRecipientsForCategory } from "./notification-preferences";

export interface CreateRepoIntegrationCredentialNotificationArgs {
	/**
	 * The user who connected the repo. The notification also fans out to the
	 * project's owners/admins.
	 */
	recipientUserId: string;
	/** Org scope for the notification row; null in personal-project context. */
	organizationId: string | null;
	integrationId: string;
	projectId: string;
	projectName: string;
	/** RepositoryProvider value (e.g. "GITHUB", "GITLAB", "AZURE_DEVOPS"). */
	provider: string;
	repositoryOwner: string;
	repositoryName: string;
	/** The status the integration transitioned into. */
	status: "TOKEN_EXPIRED" | "ERROR" | "REPO_UNAVAILABLE";
	/**
	 * Context-relative deep link to the project's Settings tab (where the
	 * repository integration can be re-authenticated). No leading slash so the
	 * inbox prepends the notification's own org base — see `resolveNotificationLink`.
	 */
	link: string;
}

export async function createRepoIntegrationCredentialNotification(
	args: CreateRepoIntegrationCredentialNotificationArgs,
): Promise<void> {
	// Best-effort: recipient resolution and preference lookup must never bubble
	// into the calling activity (the module contract is "never throws"). The
	// per-write swallow below additionally isolates one bad write from the rest.
	try {
		const recipientUserIds = await resolveCredentialNotificationRecipients(
			args.projectId,
			args.recipientUserId,
		);
		if (recipientUserIds.length === 0) {
			return;
		}

		// Write-time preference filter (Notification Center Preferences, AC-4):
		// one batched query drops recipients who disabled the Sync/Project
		// category (PROJECT → `syncProject` toggle); no-preference recipients
		// stay enabled. Mirrors the fan-out in `pm-conflict-notifications.ts`.
		const enabled = await getEnabledRecipientsForCategory(
			recipientUserIds,
			NotificationCategory.PROJECT,
		);
		const allowed = recipientUserIds.filter((id) => enabled.has(id));
		if (allowed.length === 0) {
			return;
		}

		const repoSlug = `${args.repositoryOwner}/${args.repositoryName}`;
		const [title, snippet] =
			args.status === "REPO_UNAVAILABLE"
				? [
						"Repository not accessible",
						`${repoSlug} in ${args.projectName} can't be read by the connected credentials — install the provider app on the repository, or connect it with a personal access token from its row menu (Settings ▸ Development).`,
					]
				: [
						"Repository credentials expired",
						`${repoSlug} in ${args.projectName} needs re-authentication to restore access.`,
					];

		await Promise.all(
			allowed.map((recipientUserId) =>
				writeCredentialNotificationRow(
					args,
					recipientUserId,
					title,
					snippet,
				),
			),
		);
	} catch (error) {
		// Best-effort: never block the calling activity. Log so operators can
		// detect a sustained failure (e.g. DB connectivity during a health-check
		// sweep) instead of the whole fan-out failing silently.
		console.warn(
			"[RepoIntegrationNotification] credential-expiry dispatch failed",
			{ integrationId: args.integrationId },
			error,
		);
	}
}

/**
 * Resolve the recipient set for a credential-expiry notification: the
 * connecting user plus the project's owners/admins — the people with the access
 * to re-authenticate. Deduped by userId so a configurer who is also an owner
 * receives a single notification.
 */
async function resolveCredentialNotificationRecipients(
	projectId: string,
	configuredByUserId: string,
): Promise<string[]> {
	const recipients = new Set<string>([configuredByUserId]);

	const project = await db.project.findUnique({
		where: { id: projectId },
		select: {
			// The project creator is always the OWNER (schema invariant).
			userId: true,
			members: {
				where: {
					role: {
						in: [
							ProjectMemberRole.OWNER,
							ProjectMemberRole.PROJECT_ADMIN,
						],
					},
					acceptedAt: { not: null },
					OR: [
						{ expiresAt: null },
						{ expiresAt: { gt: new Date() } },
					],
				},
				select: { userId: true },
			},
		},
	});

	if (project?.userId) {
		recipients.add(project.userId);
	}
	for (const member of project?.members ?? []) {
		recipients.add(member.userId);
	}

	return [...recipients];
}

/**
 * Write one credential-expiry notification row for an already preference-checked
 * recipient. The dedupe key is per (integration, recipient) so the fan-out does
 * not collide on the live-unread partial unique index; combined with the
 * caller's transition gate, the scheduled re-check still cannot stack duplicates
 * for one recipient. P2002 coalescing and a silent catch keep one bad write from
 * failing the rest of the fan-out.
 */
async function writeCredentialNotificationRow(
	args: CreateRepoIntegrationCredentialNotificationArgs,
	recipientUserId: string,
	title: string,
	snippet: string,
): Promise<void> {
	// Status is part of the key: an unread "credentials expired" row must not
	// silently suppress the later "not accessible" notification for the same
	// integration — its remedy is a different one.
	const dedupeKey = `repoIntegrationExpired:${args.integrationId}:${args.status}:${recipientUserId}`;

	try {
		await db.notification.create({
			data: {
				userId: recipientUserId,
				organizationId: args.organizationId,
				type: NotificationType.REPO_INTEGRATION_TOKEN_EXPIRED,
				category: NotificationCategory.PROJECT,
				title,
				snippet,
				link: args.link,
				projectId: args.projectId,
				payload: {
					integrationId: args.integrationId,
					projectId: args.projectId,
					projectName: args.projectName,
					provider: args.provider,
					repositoryOwner: args.repositoryOwner,
					repositoryName: args.repositoryName,
					status: args.status,
				},
				dedupeKey,
			},
		});
	} catch (error) {
		// Coalesce on dedupe-key collision; swallow other errors so the calling
		// activity is never blocked by notification writes. Mirrors the
		// best-effort discipline in incident/agent-reply notification helpers.
		const code = (error as { code?: string } | null)?.code;
		if (code === "P2002") {
			return;
		}
		// Intentionally silent: notification dispatch is best-effort.
	}
}
