"use client";

import { AgentDetailsDrawer } from "@saas/agent-templates/components/AgentDetailsDrawer";
import { AgentRunActivityButton } from "@saas/agent-templates/components/AgentRunActivityButton";
import { AgentRunHistory } from "@saas/agent-templates/components/AgentRunHistory";
import { AgentTaskList } from "@saas/agents/components/AgentTaskList";
import { UnifiedAgentView } from "@saas/agents/components/UnifiedAgentView";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";

export default function OrganizationAgentsPage() {
	const t = useTranslations("agentDirectory");
	const [showLegacyWork, setShowLegacyWork] = useState(false);
	const searchParams = useSearchParams();
	const tab = searchParams.get("tab") === "tasks" ? "tasks" : "agents";
	const router = useRouter();
	const pathname = usePathname();
	const agentId = searchParams.get("agentId");
	const runAgentId = searchParams.get("runAgentId") ?? undefined;
	const selectTab = (value: string) => {
		const next = new URLSearchParams(searchParams.toString());
		next.set("tab", value);
		router.replace(`${pathname}?${next}`, { scroll: false });
	};
	const { organizationId, organizationName, basePath } =
		useOrganizationContext();

	return (
		<div className="w-full min-w-0 max-w-full space-y-4 overflow-x-clip py-4">
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

			<Tabs value={tab} onValueChange={selectTab} className="w-full">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<TabsList>
						<TabsTrigger value="agents">{t("agents")}</TabsTrigger>
						<TabsTrigger value="tasks">{t("runs")}</TabsTrigger>
						<TabsTrigger value="inbox" asChild>
							<a href={`${basePath}/agents/inbox`}>
								{t("inbox")}
							</a>
						</TabsTrigger>
					</TabsList>
					{organizationId && (
						<AgentRunActivityButton
							organizationId={organizationId}
							basePath={basePath}
						/>
					)}
				</div>

				<TabsContent value="agents" className="mt-4">
					<UnifiedAgentView />
				</TabsContent>

				<TabsContent value="tasks" className="mt-4">
					{organizationId && (
						<AgentRunHistory
							key={`${organizationId}:${runAgentId ?? "all"}:${searchParams.get("runStatus") ?? "ALL"}`}
							organizationId={organizationId}
							instanceId={runAgentId}
							initialStatus={
								searchParams.get("runStatus") === "ACTIVE"
									? "ACTIVE"
									: "ALL"
							}
							onAgentChange={(instanceId) => {
								const next = new URLSearchParams(
									searchParams.toString(),
								);
								if (instanceId)
									next.set("runAgentId", instanceId);
								else next.delete("runAgentId");
								for (const key of [
									"agentId",
									"agentView",
									"runId",
								])
									next.delete(key);
								router.push(`${pathname}?${next}`, {
									scroll: false,
								});
							}}
							onSelect={(run) => {
								const next = new URLSearchParams(
									searchParams.toString(),
								);
								next.set("agentId", run.instanceId);
								next.set("agentView", "runs");
								next.set("runId", run.id);
								router.push(`${pathname}?${next}`, {
									scroll: false,
								});
							}}
						/>
					)}
					<details
						className="mx-4 border-t border-border py-4"
						onToggle={(event) =>
							setShowLegacyWork(event.currentTarget.open)
						}
					>
						<summary className="cursor-pointer text-sm text-muted-foreground">
							Chats & delegated work
						</summary>
						<div className="mt-4">
							{showLegacyWork && (
								<AgentTaskList
									organizationId={organizationId ?? undefined}
								/>
							)}
						</div>
					</details>
				</TabsContent>
			</Tabs>
			{organizationId && agentId && (
				<AgentDetailsDrawer
					key={`${organizationId}:${agentId}`}
					organizationId={organizationId}
					instanceId={agentId}
					basePath={basePath}
				/>
			)}
		</div>
	);
}
