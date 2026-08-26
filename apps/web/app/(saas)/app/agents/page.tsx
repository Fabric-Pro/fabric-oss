"use client";

import { AgentTaskList } from "@saas/agents/components/AgentTaskList";
import { UnifiedAgentView } from "@saas/agents/components/UnifiedAgentView";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import { useSearchParams } from "next/navigation";

export default function AgentsPage() {
	const searchParams = useSearchParams();
	const defaultTab = searchParams.get("tab") || "agents";

	return (
		<div className="w-full py-8 space-y-6">
			<TopRightControls />
			<PageBreadcrumbs items={[{ label: "Agents" }]} />

			<Tabs defaultValue={defaultTab} className="w-full">
				<TabsList>
					<TabsTrigger value="agents">All Agents</TabsTrigger>
					<TabsTrigger value="tasks">Execution History</TabsTrigger>
					<TabsTrigger value="inbox" asChild>
						<a href="/app/agents/inbox">Inbox</a>
					</TabsTrigger>
				</TabsList>

				<TabsContent value="agents" className="mt-6">
					<UnifiedAgentView />
				</TabsContent>

				<TabsContent value="tasks" className="mt-6">
					<AgentTaskList />
				</TabsContent>
			</Tabs>
		</div>
	);
}
