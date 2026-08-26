"use client";

import { FrameViewer } from "@saas/frames/components/FrameViewer";
import { useOrganizationId } from "@saas/organizations/hooks/use-organization-context";

export default function OrganizationFramePage({
	params,
}: {
	params: { frameId: string };
}) {
	const organizationId = useOrganizationId();
	return (
		<FrameViewer frameId={params.frameId} organizationId={organizationId} />
	);
}
