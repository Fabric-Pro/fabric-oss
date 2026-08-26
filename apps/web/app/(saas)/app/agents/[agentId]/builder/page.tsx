import { AgentBuilderPage } from "@saas/agents/sidekick/AgentBuilderPage";

type Props = {
	params: Promise<{
		agentId: string;
	}>;
};

export const metadata = {
	title: "Agent Builder - Fabric",
	description: "Build and configure your agent with Sidekick assistance",
};

export default async function BuilderPage({ params }: Props) {
	const { agentId } = await params;
	return <AgentBuilderPage agentId={agentId} />;
}
