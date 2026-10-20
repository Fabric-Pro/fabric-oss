"use client";

import { FrameViewer } from "@saas/frames/components/FrameViewer";
import { useOrganizationId } from "@saas/organizations/hooks/use-organization-context";
import { use } from "react";

export default function OrganizationFramePage({
	params,
}: {
	params: Promise<{ frameId: string }>;
}) {
	const { frameId } = use(params);
	const organizationId = useOrganizationId();
	return <FrameViewer frameId={frameId} organizationId={organizationId} />;
}
