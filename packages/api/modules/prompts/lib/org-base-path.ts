import { db } from "@repo/database";

/**
 * `/app/{slug}` inside an organization, `/app` in personal context.
 *
 * Notification deep-links must land in the context the notification is about:
 * an organization's review queue and prompt catalog live under the org's pages,
 * and the personal-context URL shows a different tier's view entirely.
 */
export async function resolveOrgBasePath(
	organizationId: string | null | undefined,
): Promise<string> {
	if (!organizationId) {
		return "/app";
	}
	const org = await db.organization.findUnique({
		where: { id: organizationId },
		select: { slug: true },
	});
	return org?.slug ? `/app/${org.slug}` : "/app";
}
