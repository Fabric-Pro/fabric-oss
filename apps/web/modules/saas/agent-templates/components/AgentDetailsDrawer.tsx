"use client";

import { getAgentImplementationAvailability } from "@repo/agent-types/agent-implementation";
import { getBuiltInCapability } from "@saas/agents/lib/builtin-capabilities";
import { buildAgentInstanceChatHref } from "@saas/agents/lib/fabric-agent-links";
import { useSession } from "@saas/auth/hooks/use-session";
import { useFeatureFlag } from "@saas/shared/components/FeatureFlagProvider";
import { RobotIcon } from "@saas/shared/components/icons/RobotIcon";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@ui/components/sheet";
import { Skeleton } from "@ui/components/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import {
	CopyIcon,
	EditIcon,
	MessageSquareIcon,
	MoreHorizontalIcon,
	PlayIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useRef } from "react";
import { toast } from "sonner";
import { AgentDefinitionExportDialog } from "./AgentDefinitionDialog";
import { AgentImplementationNotice } from "./AgentImplementationNotice";
import { AgentRunHistory } from "./AgentRunHistory";
import { runRecord } from "./AgentRunResult";
import { AgentRunSession } from "./AgentRunSession";

export function AgentDetailsDrawer({
	organizationId,
	instanceId,
	basePath,
}: {
	organizationId: string;
	instanceId: string;
	basePath: string;
}) {
	const router = useRouter();
	const pathname = usePathname();
	const params = useSearchParams();
	const { user } = useSession();
	const unified = useFeatureFlag("UNIFIED_AGENT_INTERFACE");
	const titleRef = useRef<HTMLHeadingElement>(null);
	const returnFocus = useRef(
		typeof document === "undefined"
			? null
			: (document.activeElement as HTMLElement | null),
	);
	const section = params.get("agentView") ?? "overview";
	const runId = params.get("runId") ?? undefined;
	const tab =
		section === "new"
			? "runs"
			: section === "schedule"
				? "triggers"
				: ["overview", "runs"].includes(section)
					? section
					: "overview";
	const query = useQuery({
		...orpc.agentTemplates.instances.get.queryOptions({
			input: { organizationId, id: instanceId },
		}),
		retry: false,
	});
	const agent = query.data?.instance;
	const config = runRecord(agent?.customInstructions);
	const templateName = runRecord(runRecord(agent).template).displayName;
	const availability = getAgentImplementationAvailability(config);
	const ownsRuns = !!agent && agent.userId === user?.id;
	const runnable =
		ownsRuns && availability.available && agent?.status === "ACTIVE";
	const editHref = `${basePath}/agents/${instanceId}/edit`;
	const navigate = (view: string, executionId?: string) => {
		const next = new URLSearchParams(params.toString());
		next.set("agentView", view);
		if (executionId) {
			next.set("runId", executionId);
		} else {
			next.delete("runId");
		}
		router.replace(`${pathname}?${next}`, { scroll: false });
	};
	const close = () => {
		const next = new URLSearchParams(params.toString());
		for (const key of ["agentId", "agentView", "runId"]) {
			next.delete(key);
		}
		router.replace(`${pathname}${next.size ? `?${next}` : ""}`, {
			scroll: false,
		});
	};
	const instructions =
		typeof config.additionalContext === "string"
			? config.additionalContext
			: typeof config.role === "string"
				? config.role
				: "";
	const tools = Object.entries(runRecord(agent?.toolConnections))
		.filter(([, value]) => runRecord(value).enabled !== false)
		.map(
			([key]) =>
				getBuiltInCapability(key)?.name ??
				(key.startsWith("mcp:")
					? "MCP connection"
					: key.replace(/[_-]/g, " ")),
		);
	async function copy(value: string) {
		try {
			await navigator.clipboard.writeText(value);
			toast.success("Copied");
		} catch {
			toast.error("Could not copy. Try again.");
		}
	}
	return (
		<Sheet
			open
			onOpenChange={(open) => {
				if (!open) {
					close();
				}
			}}
		>
			<SheetContent
				className="flex w-full flex-col gap-0 p-0 sm:max-w-3xl"
				onOpenAutoFocus={(e) => {
					e.preventDefault();
					titleRef.current?.focus();
				}}
				onCloseAutoFocus={(e) => {
					e.preventDefault();
					if (returnFocus.current?.isConnected) {
						returnFocus.current.focus();
					} else {
						document
							.querySelector<HTMLInputElement>(
								'input[placeholder="Search agents..."]',
							)
							?.focus();
					}
				}}
			>
				<SheetHeader className="shrink-0 border-b border-border p-6 text-left">
					<div className="flex items-center gap-3 pr-8">
						<div className="flex size-12 shrink-0 items-center justify-center rounded-lg border border-border bg-muted">
							<RobotIcon className="size-6" />
						</div>
						<div className="min-w-0">
							<SheetTitle
								ref={titleRef}
								tabIndex={-1}
								className="break-words focus:outline-none"
							>
								{agent?.name ?? "Agent details"}
							</SheetTitle>
							{agent && (
								<p className="mt-1 text-xs text-muted-foreground">
									{typeof templateName === "string"
										? `Based on ${templateName} · `
										: ""}
									Version {agent.version} ·{" "}
									{agent.status === "ACTIVE"
										? "Active"
										: agent.status.toLowerCase()}
								</p>
							)}
						</div>
					</div>
					<SheetDescription className="break-words">
						{agent?.description ||
							"Inspect this agent’s instructions, knowledge and activity."}
					</SheetDescription>
					{agent && (
						<div className="flex flex-wrap items-center gap-1 pt-2 sm:gap-2">
							{runnable && section !== "new" && (
								<Button
									type="button"
									size="sm"
									onClick={() => navigate("new")}
								>
									<PlayIcon className="size-4" />
									Run agent
								</Button>
							)}
							{availability.available && (
								<>
									<Button asChild variant="outline" size="sm">
										<Link
											href={buildAgentInstanceChatHref({
												basePath,
												instance: agent,
												unifiedAgentInterface: unified,
											})}
										>
											<MessageSquareIcon className="size-4" />
											Try in chat
										</Link>
									</Button>
									<Button asChild variant="outline" size="sm">
										<Link href={editHref}>
											<EditIcon className="size-4" />
											Edit
										</Link>
									</Button>
								</>
							)}
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<Button
										variant="ghost"
										size="icon-sm"
										aria-label="More agent actions"
									>
										<MoreHorizontalIcon
											strokeWidth={2.5}
											className="size-4"
										/>
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end">
									<DropdownMenuItem
										onClick={() =>
											void copy(window.location.href)
										}
									>
										<CopyIcon className="mr-2 size-4" />
										Copy link
									</DropdownMenuItem>
									<DropdownMenuItem
										onClick={() => void copy(instanceId)}
									>
										Copy agent ID
									</DropdownMenuItem>
									<DropdownMenuItem asChild>
										<Link
											href={`${basePath}/agents/${instanceId}/duplicate`}
										>
											Duplicate
										</Link>
									</DropdownMenuItem>
									<DropdownMenuItem asChild>
										<Link
											href={`${basePath}/agents/${instanceId}/memory`}
										>
											Memory
										</Link>
									</DropdownMenuItem>
								</DropdownMenuContent>
							</DropdownMenu>
						</div>
					)}
				</SheetHeader>
				{query.isPending ? (
					<div
						className="space-y-4 p-6"
						role="status"
						aria-label="Loading agent details"
					>
						<Skeleton className="h-8 w-48" />
						<Skeleton className="h-32 w-full" />
					</div>
				) : query.error || !agent ? (
					<div className="p-6">
						<Alert variant="error">
							<AlertTitle>Could not load this agent</AlertTitle>
							<AlertDescription>
								{query.error?.message ??
									"The agent is unavailable."}
							</AlertDescription>
						</Alert>
						<Button
							variant="outline"
							className="mt-4"
							onClick={() => void query.refetch()}
						>
							Try again
						</Button>
					</div>
				) : (
					<Tabs
						value={
							tab === "triggers" && !runnable ? "overview" : tab
						}
						onValueChange={(value) =>
							navigate(value === "triggers" ? "schedule" : value)
						}
						className="flex min-h-0 flex-1 flex-col"
					>
						<TabsList className="w-full shrink-0 justify-start rounded-none border-b border-border px-4">
							<TabsTrigger value="overview">Overview</TabsTrigger>
							<TabsTrigger value="runs">Runs</TabsTrigger>
							{runnable && (
								<TabsTrigger value="triggers">
									Triggers
								</TabsTrigger>
							)}
						</TabsList>
						<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
							<TabsContent
								value="overview"
								className="m-0 space-y-6 p-6"
								data-onboarding-target="agent-details-overview"
							>
								{!availability.available && (
									<AgentImplementationNotice
										customInstructions={config}
										organizationId={organizationId}
										instanceId={instanceId}
										basePath={basePath}
									/>
								)}
								<section>
									<h3 className="text-sm font-semibold">
										Instructions
									</h3>
									<p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6">
										{instructions ||
											"No instructions saved. Open Edit to describe how this agent should work."}
									</p>
								</section>
								{typeof config.expectedOutput === "string" &&
									config.expectedOutput && (
										<section>
											<h3 className="text-sm font-semibold">
												Expected output
											</h3>
											<p className="mt-3 whitespace-pre-wrap break-words text-sm text-muted-foreground">
												{config.expectedOutput}
											</p>
										</section>
									)}
								<section className="space-y-3 border-t border-border pt-5">
									<h3 className="text-sm font-semibold">
										Knowledge & connections
									</h3>
									<p className="text-sm text-muted-foreground">
										{agent.workspaceIds.length
											? `${agent.workspaceIds.length} Workspace${agent.workspaceIds.length === 1 ? "" : "s"} selected for retrieval.`
											: "No Workspaces selected."}{" "}
										{typeof config.projectId === "string"
											? "Project context is attached."
											: ""}
									</p>
									{tools.length > 0 && (
										<div className="flex flex-wrap gap-2">
											{tools.map((tool, index) => (
												<Badge
													variant="secondary"
													key={`${tool}-${index}`}
												>
													{tool}
												</Badge>
											))}
										</div>
									)}
									<Link
										className="inline-block text-sm underline underline-offset-4"
										href={editHref}
									>
										Edit knowledge and connections
									</Link>
								</section>
								<section className="space-y-2 border-t border-border pt-5">
									<h3 className="text-sm font-semibold">
										Execution
									</h3>
									<p className="text-sm text-muted-foreground">
										{agent.executionMode === "goal_oriented"
											? `Goal-oriented · up to ${agent.maxIterations} iterations`
											: "Single turn · one response to each task"}
									</p>
									{agent.executionMode === "goal_oriented" &&
										agent.goal && (
											<p className="whitespace-pre-wrap break-words text-sm">
												{agent.goal}
											</p>
										)}
								</section>
								<details className="border-t border-border pt-4">
									<summary className="cursor-pointer text-sm text-muted-foreground">
										Definition & portability
									</summary>
									<div className="mt-3">
										<AgentDefinitionExportDialog
											organizationId={organizationId}
											instanceId={instanceId}
										/>
									</div>
								</details>
							</TabsContent>
							<TabsContent value="runs" className="m-0">
								{!ownsRuns ? (
									<p className="p-6 text-sm text-muted-foreground">
										Background runs use the owner’s saved
										credentials. Only the agent owner can
										view and manage them.
									</p>
								) : section === "new" && !runnable ? (
									<Alert className="m-4 w-auto">
										<AlertTitle>
											Execution unavailable
										</AlertTitle>
										<AlertDescription>
											{availability.reason ??
												"Restore this agent before starting work."}
										</AlertDescription>
									</Alert>
								) : section === "new" || runId ? (
									<AgentRunSession
										key={`${instanceId}:${runId ?? "new"}`}
										organizationId={organizationId}
										instanceId={instanceId}
										executionId={runId}
										mode={
											section === "new" ? "new" : "result"
										}
										goal={agent.goal}
										editHref={editHref}
										onStarted={(id) => navigate("runs", id)}
										onBack={() => navigate("runs")}
									/>
								) : (
									<AgentRunHistory
										organizationId={organizationId}
										instanceId={instanceId}
										compact
										onSelect={(run) =>
											navigate("runs", run.id)
										}
										historyHref={`${basePath}/agents?tab=tasks&runAgentId=${encodeURIComponent(instanceId)}`}
									/>
								)}
							</TabsContent>
							<TabsContent value="triggers" className="m-0">
								{runnable && (
									<>
										<p className="px-4 pt-4 text-sm text-muted-foreground">
											Schedule recurring tasks here.
											Configure other event triggers in{" "}
											<Link
												className="underline underline-offset-4"
												href={editHref}
											>
												Edit agent
											</Link>
											.
										</p>
										<AgentRunSession
											key={instanceId}
											organizationId={organizationId}
											instanceId={instanceId}
											mode="schedule"
											goal={agent.goal}
											editHref={editHref}
											onStarted={(id) =>
												navigate("runs", id)
											}
											onBack={() => navigate("runs")}
										/>
									</>
								)}
							</TabsContent>
						</div>
					</Tabs>
				)}
			</SheetContent>
		</Sheet>
	);
}
