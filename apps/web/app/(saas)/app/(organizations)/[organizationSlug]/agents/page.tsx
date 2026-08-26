"use client";

import { AgentTaskList } from "@saas/agents/components/AgentTaskList";
import { UnifiedAgentView } from "@saas/agents/components/UnifiedAgentView";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import { useSearchParams } from "next/navigation";

export default function OrganizationAgentsPage() {
	const searchParams = useSearchParams();
	const defaultTab = searchParams.get("tab") || "agents";
	const { organizationId, organizationName, basePath } =
		useOrganizationContext();

	return (
		<div className="w-full py-8 space-y-6">
			<TopRightControls />
			<PageBreadcrumbs
				items={[
					...(organizationId
						? [
								{
									label: organizationName ?? "Organization",
									href: basePath,
								},
							]
						: []),
					{ label: "Agents" },
				]}
			/>

			<Tabs defaultValue={defaultTab} className="w-full">
				<TabsList>
					<TabsTrigger value="agents">All Agents</TabsTrigger>
					<TabsTrigger value="tasks">Execution History</TabsTrigger>
					<TabsTrigger value="inbox" asChild>
						<a href={`${basePath}/agents/inbox`}>Inbox</a>
					</TabsTrigger>
				</TabsList>

				<TabsContent value="agents" className="mt-6">
					<UnifiedAgentView />
				</TabsContent>

				<TabsContent value="tasks" className="mt-6">
					<AgentTaskList
						organizationId={organizationId ?? undefined}
					/>
				</TabsContent>
			</Tabs>
		</div>
	);
}
