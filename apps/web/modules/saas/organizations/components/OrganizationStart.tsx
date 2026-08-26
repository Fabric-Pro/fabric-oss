"use client";

import { OrganizationDashboard } from "@saas/dashboard/components/OrganizationDashboard";

interface OrganizationStartProps {
	organizationId: string;
	organizationName: string;
	organizationSlug: string;
	brandColor?: string;
}

export default function OrganizationStart({
	organizationId,
	organizationName,
	organizationSlug,
	brandColor,
}: OrganizationStartProps) {
	return (
		<OrganizationDashboard
			organizationId={organizationId}
			organizationName={organizationName}
			organizationSlug={organizationSlug}
			brandColor={brandColor}
		/>
	);
}
