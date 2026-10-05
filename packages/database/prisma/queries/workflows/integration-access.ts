import { db, type Prisma } from "../../client";
import { OAUTH_APP_ROW_NAMES } from "../lib/oauth-app-row";

/**
 * Providers whose connections are personal and never shared with the
 * organization. A GitLab row is the person's own GitLab connection, owned and
 * refreshed by the GitLab connection service; GitLab workflow steps and PM
 * calls run on the acting person's own connection, so a shared one would
 * hand one person's GitLab identity to another member's run.
 */
export const PERSONAL_ONLY_INTEGRATION_PROVIDERS = ["GITLAB"] as const;

/** Whether connections of `provider` may be shared with the organization. */
export function isShareableIntegrationProvider(provider: string): boolean {
	return !(PERSONAL_ONLY_INTEGRATION_PROVIDERS as readonly string[]).includes(
		provider,
	);
}

/**
 * Identity is independent of tenant context. An org ID is never sharing
 * consent, and a personal-only provider's row is never shared (even one
 * marked shared is returned only to its owner).
 */
export function workflowIntegrationAccessWhere(
	userId: string,
	organizationId?: string | null,
): Prisma.WorkflowIntegrationWhereInput {
	return {
		NOT: { name: { in: OAUTH_APP_ROW_NAMES } },
		...(organizationId
			? {
					organizationId,
					OR: [
						{ userId },
						{
							usageScope: "ORGANIZATION_SHARED",
							NOT: {
								provider: {
									in: [
										...PERSONAL_ONLY_INTEGRATION_PROVIDERS,
									],
								},
							},
						},
					],
				}
			: { organizationId: null, userId }),
	};
}

/** Background execution must revalidate membership, including for shared grants. */
export async function canUseWorkflowIntegrations(
	userId: string,
	organizationId?: string | null,
): Promise<boolean> {
	if (!userId) {
		return false;
	}
	if (!organizationId) {
		return true;
	}
	return !!(await db.member.findFirst({
		where: { userId, organizationId },
		select: { id: true },
	}));
}

/** Select once, then pin this ID for execution and any later approval. */
export async function resolveWorkflowIntegrationForProvider(
	provider: NonNullable<Prisma.WorkflowIntegrationWhereInput["provider"]>,
	userId: string,
	organizationId?: string | null,
) {
	if (!(await canUseWorkflowIntegrations(userId, organizationId))) {
		return null;
	}
	const where = {
		...workflowIntegrationAccessWhere(userId, organizationId),
		provider,
		isActive: true,
	};
	// Prefer the actor's own connection; an explicitly shared connection is a fallback.
	const own = await db.workflowIntegration.findFirst({
		where: { ...where, userId },
		orderBy: [{ lastUsedAt: "desc" }, { id: "asc" }],
	});
	if (own || !organizationId) {
		return own;
	}
	return db.workflowIntegration.findFirst({
		where,
		orderBy: [{ lastUsedAt: "desc" }, { id: "asc" }],
	});
}
