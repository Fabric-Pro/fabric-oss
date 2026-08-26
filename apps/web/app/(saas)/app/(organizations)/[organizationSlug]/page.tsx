import {
	getActiveOrganization,
	getSession,
	isGuestInOrg,
} from "@saas/auth/lib/server";
import OrganizationStart from "@saas/organizations/components/OrganizationStart";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { db } from "@repo/database";
import { notFound, redirect } from "next/navigation";

// Helper to safely parse organization metadata
function getOrganizationBrandColor(
	metadata: string | null | undefined,
): string | undefined {
	if (!metadata) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(metadata);
		return parsed.brandColor;
	} catch {
		return undefined;
	}
}

export async function generateMetadata({
	params,
}: {
	params: Promise<{ organizationSlug: string }>;
}) {
	const { organizationSlug } = await params;

	const activeOrganization = await getActiveOrganization(
		organizationSlug as string,
	);

	return {
		title: activeOrganization?.name,
	};
}

export default async function OrganizationPage({
	params,
}: {
	params: Promise<{ organizationSlug: string }>;
}) {
	const { organizationSlug } = await params;

	const activeOrganization = await getActiveOrganization(
		organizationSlug as string,
	);

	if (!activeOrganization) {
		return notFound();
	}

	// Guests land on their first invited project rather than the org start page.
	const session = await getSession();
	if (session?.user) {
		const guest = await isGuestInOrg(
			session.user.id,
			activeOrganization.id,
		);
		if (guest) {
			const firstProject = await db.projectMember.findFirst({
				where: {
					userId: session.user.id,
					acceptedAt: { not: null },
					OR: [
						{ expiresAt: null },
						{ expiresAt: { gt: new Date() } },
					],
					project: { organizationId: activeOrganization.id },
				},
				select: { projectId: true },
				orderBy: { acceptedAt: "desc" },
			});
			if (firstProject) {
				redirect(
					`/app/${organizationSlug}/projects/${firstProject.projectId}`,
				);
			}
			// Guest with no active project — shouldn't happen, but fall through.
		}
	}

	const brandColor = getOrganizationBrandColor(activeOrganization.metadata);

	return (
		<div className="w-full py-6">
			<TopRightControls />
			<OrganizationStart
				organizationId={activeOrganization.id}
				organizationName={activeOrganization.name}
				organizationSlug={organizationSlug as string}
				brandColor={brandColor}
			/>
		</div>
	);
}
