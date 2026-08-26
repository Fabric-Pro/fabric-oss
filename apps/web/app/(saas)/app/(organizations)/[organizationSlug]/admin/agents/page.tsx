import { AgentRegistryView } from "@saas/agents/components/AgentRegistryView";

/**
 * Workspace-scoped admin agent registry —
 * `/app/{organizationSlug}/admin/agents`.
 *
 * Mirror of the personal `(account)/admin/agents/page.tsx`. Renders the same
 * platform-wide `AgentRegistryView`; the org slug only keeps the admin in their
 * current workspace (the role guard lives in the parent admin layout).
 */
export const metadata = {
	title: "Agent Registry",
	description: "Manage registered AI agents across all frameworks",
};

export default function OrganizationAdminAgentRegistryPage() {
	return <AgentRegistryView />;
}
