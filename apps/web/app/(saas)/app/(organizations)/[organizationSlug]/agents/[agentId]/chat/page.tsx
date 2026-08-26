"use client";

/**
 * Organization Agent Chat Page
 *
 * CopilotKit-based chat interface for document generator agents within organization context.
 * For CUGA agent, uses specialized CUGA UI with execution view.
 * Features:
 * - Predictive state updates
 * - Sidebar-based chat interface
 * - Document generation with real-time updates
 * - Full-screen layout (hides app sidebar)
 * - CUGA-specific UI for browser automation, code execution, etc.
 */

import { AgentChatCopilotKit } from "@saas/agents/components/AgentChatCopilotKit";
import { CugaAuthenticatedChat } from "@saas/agents/components/cuga";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { Spinner } from "@shared/components/Spinner";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from "@ui/components/breadcrumb";
import { Button } from "@ui/components/button";
import { HomeIcon } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";

// Agent IDs that should use CUGA-specific UI
const CUGA_AGENT_IDS = ["cuga-generalist", "cuga_generalist"];

export default function OrganizationAgentChatPage() {
	const params = useParams();
	const agentId = params.agentId as string;
	const { basePath } = useOrganizationContext();

	// Organization-aware paths
	const agentsPath = `${basePath}/agents`;

	// Fetch agent details for breadcrumb and to determine agent type
	const { data: agent, isLoading } = useQuery({
		queryKey: ["agent", "registry", agentId],
		queryFn: async () => {
			const result = await orpcClient.agents.registry.get({
				id: agentId,
			});
			return result;
		},
		retry: false,
	});

	// Check if this is a CUGA agent
	const isCugaAgent = agent && CUGA_AGENT_IDS.includes(agent.agentId);

	return (
		<div className="fixed inset-0 bg-background">
			{/* Breadcrumbs - Compact header */}
			<div className="flex items-center gap-3 px-6 py-2.5 border-b bg-background">
				<Button
					variant="ghost"
					size="icon"
					className="shrink-0"
					asChild
					title="Go to home"
				>
					<Link href={basePath}>
						<HomeIcon className="size-4" />
					</Link>
				</Button>
				<Breadcrumb>
					<BreadcrumbList>
						<BreadcrumbItem>
							<BreadcrumbLink
								href={agentsPath}
								className="text-sm"
							>
								Agents
							</BreadcrumbLink>
						</BreadcrumbItem>
						<BreadcrumbSeparator />
						<BreadcrumbItem>
							<BreadcrumbLink
								href={`${agentsPath}/${agentId}`}
								className="text-sm"
							>
								{isLoading ? (
									<Spinner className="size-3" />
								) : (
									agent?.displayName || "Agent"
								)}
							</BreadcrumbLink>
						</BreadcrumbItem>
						<BreadcrumbSeparator />
						<BreadcrumbItem>
							<BreadcrumbPage className="text-sm">
								Chat
							</BreadcrumbPage>
						</BreadcrumbItem>
					</BreadcrumbList>
				</Breadcrumb>
			</div>

			{/* Chat Interface - Full height */}
			<div className="h-[calc(100vh-53px)]">
				{isLoading ? (
					<div className="flex items-center justify-center h-full">
						<Spinner className="size-8" />
					</div>
				) : isCugaAgent ? (
					<CugaAuthenticatedChat
						agentUrl={
							agent?.deploymentUrl || "http://localhost:9999"
						}
						className="h-full"
					/>
				) : (
					<AgentChatCopilotKit agentId={agentId} />
				)}
			</div>
		</div>
	);
}
