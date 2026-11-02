"use client";

/**
 * Organization Agent Chat Page
 *
 * CopilotKit-based chat interface for document generator agents within organization context.
 * Features:
 * - Predictive state updates
 * - Sidebar-based chat interface
 * - Document generation with real-time updates
 * - Full-height workspace clear of app navigation
 */

import { isRetiredSystemAgent } from "@repo/agent-types";
import { config } from "@repo/config";
import { AgentChatCopilotKit } from "@saas/agents/components/AgentChatCopilotKit";
import { RetiredAgentNotice } from "@saas/agents/components/RetiredAgentNotice";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { useFullscreen } from "@saas/shared/contexts/FullscreenContext";
import { useSidebarCollapse } from "@saas/shared/contexts/SidebarCollapseContext";
import {
	SHELL_LAUNCHER_CLEARANCE_CLASS,
	shellDockOffsetClass,
} from "@saas/shared/lib/shell-layout";
import { Spinner } from "@shared/components/Spinner";
import { useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from "@ui/components/breadcrumb";
import { Button } from "@ui/components/button";
import { cn } from "@ui/lib";
import { HomeIcon } from "lucide-react";
import Link from "next/link";
import { registeredAgentChatQueryOptions } from "../lib/agent-chat-queries";

export function OrganizationAgentChatView({ agentId }: { agentId: string }) {
	const { basePath, organizationId } = useOrganizationContext();
	const { isFullscreen } = useFullscreen();
	const { isCollapsed } = useSidebarCollapse();

	// Organization-aware paths
	const agentsPath = `${basePath}/agents`;

	// Fetch agent details for breadcrumb and to determine agent type
	const {
		data: agent,
		isLoading,
		error,
	} = useQuery({
		...registeredAgentChatQueryOptions(agentId, organizationId),
		retry: false,
	});

	if (agent && isRetiredSystemAgent(agent)) {
		return <RetiredAgentNotice basePath={basePath} />;
	}

	return (
		<div
			className={cn(
				"fixed inset-y-0 right-0 left-0 flex min-h-0 flex-col bg-background",
				SHELL_LAUNCHER_CLEARANCE_CLASS,
				config.ui.saas.useSidebarLayout && [
					"top-16 md:top-0",
					shellDockOffsetClass(isFullscreen || isCollapsed),
				],
			)}
		>
			{/* Breadcrumbs - Compact header */}
			<div className="flex shrink-0 items-center gap-3 px-6 py-2.5 border-b bg-background">
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
			<div className="min-h-0 flex-1">
				{isLoading ? (
					<div className="flex items-center justify-center h-full">
						<Spinner className="size-8" />
					</div>
				) : error || !agent ? (
					<Alert variant="error">
						<AlertTitle>Failed to load agent</AlertTitle>
						<AlertDescription>
							Agent not found or unavailable.
						</AlertDescription>
					</Alert>
				) : (
					<AgentChatCopilotKit agentId={agentId} />
				)}
			</div>
		</div>
	);
}
