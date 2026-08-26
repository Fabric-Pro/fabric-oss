import { AgentRegistryView } from "@saas/agents/components/AgentRegistryView";

export const metadata = {
	title: "Agent Registry",
	description: "Manage registered AI agents across all frameworks",
};

export default function AgentRegistryPage() {
	return <AgentRegistryView />;
}
