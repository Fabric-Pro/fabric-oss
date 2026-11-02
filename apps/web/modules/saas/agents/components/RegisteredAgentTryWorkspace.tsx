"use client";

import { isRetiredSystemAgent } from "@repo/agent-types";
import { config } from "@repo/config";
import { FabricTemporalOrchestratorChat } from "@saas/agents/components/FabricChat/FabricTemporalOrchestratorChat";
import { useFullscreen } from "@saas/shared/contexts/FullscreenContext";
import { useSidebarCollapse } from "@saas/shared/contexts/SidebarCollapseContext";
import {
	SHELL_LAUNCHER_CLEARANCE_CLASS,
	shellDockOffsetClass,
} from "@saas/shared/lib/shell-layout";
import { Spinner } from "@shared/components/Spinner";
import { orpcClient } from "@shared/lib/orpc-client";
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
import { AlertCircle, HomeIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { RetiredAgentNotice } from "./RetiredAgentNotice";

type Props = {
	agentId: string;
	basePath: string;
	organizationId?: string | null;
};

export function RegisteredAgentTryWorkspace({
	agentId,
	basePath,
	organizationId,
}: Props) {
	const router = useRouter();
	const { isFullscreen } = useFullscreen();
	const { isCollapsed } = useSidebarCollapse();
	const agentsPath = `${basePath}/agents`;

	const {
		data: agent,
		isLoading,
		error,
	} = useQuery({
		queryKey: [
			"agent",
			"registry",
			"try-workspace",
			agentId,
			organizationId,
		],
		queryFn: async () =>
			orpcClient.agents.registry.get({
				id: agentId,
				organizationId: organizationId ?? null,
			}),
		retry: false,
	});

	if (agent && isRetiredSystemAgent(agent)) {
		return <RetiredAgentNotice basePath={basePath} />;
	}
	if (isLoading) {
		return (
			<div className="flex min-h-[400px] items-center justify-center">
				<Spinner className="mr-2 size-4 text-primary" />
				<span className="text-sm text-muted-foreground">
					Loading agent...
				</span>
			</div>
		);
	}

	if (error || !agent) {
		return (
			<div className="container py-8">
				<Alert variant="error">
					<AlertCircle className="h-4 w-4" />
					<AlertTitle>Error</AlertTitle>
					<AlertDescription>
						{error instanceof Error
							? error.message
							: "Agent not found"}
					</AlertDescription>
				</Alert>
				<div className="mt-4">
					<Button
						variant="outline"
						onClick={() => router.push(agentsPath)}
					>
						Back to Agents
					</Button>
				</div>
			</div>
		);
	}

	if (!agent.deploymentUrl) {
		return (
			<div className="container py-8">
				<Alert variant="error">
					<AlertCircle className="h-4 w-4" />
					<AlertTitle>Agent Not Available</AlertTitle>
					<AlertDescription>
						This registered agent does not have a deployment URL
						configured.
					</AlertDescription>
				</Alert>
				<div className="mt-4">
					<Button
						variant="outline"
						onClick={() => router.push(`${agentsPath}/${agentId}`)}
					>
						Back to Agent Details
					</Button>
				</div>
			</div>
		);
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
			<div className="flex shrink-0 items-center gap-3 border-b bg-background px-6 py-2.5">
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
								{agent.displayName}
							</BreadcrumbLink>
						</BreadcrumbItem>
						<BreadcrumbSeparator />
						<BreadcrumbItem>
							<BreadcrumbPage className="text-sm">
								Try
							</BreadcrumbPage>
						</BreadcrumbItem>
					</BreadcrumbList>
				</Breadcrumb>
			</div>

			<div className="min-h-0 flex-1">
				<FabricTemporalOrchestratorChat
					organizationId={organizationId ?? undefined}
					reasoningMode="balanced"
					welcomeMode="focused-agent"
					enabledAgentIds={[agent.agentId]}
					prioritizedAgentIds={[agent.agentId]}
					agentName={agent.displayName}
					agentDescription={
						agent.description ||
						"Fabric will keep this run focused on the selected external agent and its capabilities."
					}
				/>
			</div>
		</div>
	);
}
