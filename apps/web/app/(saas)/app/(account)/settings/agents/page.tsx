import { AgentRegistryView } from "@saas/agents/components/AgentRegistryView";
import { AgentsHero } from "@saas/agents/components/AgentsHero";
import { getSession } from "@saas/auth/lib/server";
import { redirect } from "next/navigation";

/**
 * Agent Registry Settings Page
 *
 * Allows users to manage their personal agent registry.
 */
export default async function AgentRegistrySettingsPage() {
	const session = await getSession();

	if (!session) {
		redirect("/auth/login");
	}

	return (
		<div className="space-y-8">
			<AgentsHero />
			<AgentRegistryView />
		</div>
	);
}
