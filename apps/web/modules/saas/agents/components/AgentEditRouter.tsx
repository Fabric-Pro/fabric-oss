"use client";

import { AgentInstanceEdit } from "@saas/agent-templates/components/AgentInstanceEdit";
import { Spinner } from "@shared/components/Spinner";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { XIcon } from "lucide-react";
import Link from "next/link";
import { EditRegisteredAgentPage } from "./EditRegisteredAgentPage";

type Props = {
	agentId: string;
	organizationId?: string | null;
	basePath: string;
};

export function AgentEditRouter({ agentId, organizationId, basePath }: Props) {
	const { data: agent, isLoading } = useQuery({
		queryKey: ["agent", "registry", "edit-router", agentId, organizationId],
		queryFn: async () => {
			try {
				return await orpcClient.agents.registry.get({
					id: agentId,
					organizationId: organizationId ?? null,
				});
			} catch {
				return null;
			}
		},
		retry: false,
	});

	if (isLoading) {
		return (
			<div className="flex justify-center py-12">
				<Spinner className="h-8 w-8" />
			</div>
		);
	}

	const metadata =
		agent?.metadata && typeof agent.metadata === "object"
			? (agent.metadata as Record<string, unknown>)
			: null;
	const linkedInstanceId =
		metadata && typeof metadata.instanceId === "string"
			? metadata.instanceId
			: null;

	if (linkedInstanceId) {
		return (
			<AgentInstanceEdit
				instanceId={linkedInstanceId}
				organizationId={organizationId}
				basePath={basePath}
			/>
		);
	}

	if (agent) {
		return (
			<div
				className="flex h-full min-h-0 flex-1 flex-col"
				data-onboarding-target="agent-builder-workspace"
			>
				<div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-6 py-3">
					<h1 className="font-semibold">Edit external agent</h1>
					<Button variant="ghost" size="icon" asChild>
						<Link
							href={`${basePath}/agents/${encodeURIComponent(agentId)}`}
							aria-label="Close agent editor"
						>
							<XIcon className="size-4" />
						</Link>
					</Button>
				</div>
				<section
					aria-label="External agent configuration"
					className="min-h-0 flex-1 overflow-y-auto p-6"
				>
					<EditRegisteredAgentPage
						agentId={agentId}
						organizationId={organizationId}
						basePath={basePath}
					/>
				</section>
			</div>
		);
	}

	return (
		<AgentInstanceEdit
			instanceId={agentId}
			organizationId={organizationId}
			basePath={basePath}
		/>
	);
}
