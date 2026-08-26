"use client";

import { AuthorityDashboard } from "@saas/mcp/components/authority";
import { useOrganizationId } from "@saas/organizations/hooks/use-organization-context";

export default function OrgAuthorityPage() {
	const organizationId = useOrganizationId();

	return (
		<div className="space-y-6">
			<AuthorityDashboard organizationId={organizationId} />
		</div>
	);
}
