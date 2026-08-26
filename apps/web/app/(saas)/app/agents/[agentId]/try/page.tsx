"use client";

import { RegisteredAgentTryWorkspace } from "@saas/agents/components/RegisteredAgentTryWorkspace";
import { useParams } from "next/navigation";

export default function AgentTryPage() {
	const params = useParams();
	const agentId = params.agentId as string;

	return <RegisteredAgentTryWorkspace agentId={agentId} basePath="/app" />;
}
