"use client";

import { RunQualityPanel } from "@saas/run-quality/components/RunQualityPanel";
import { Button } from "@ui/components/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import Link from "next/link";
import { useState } from "react";
import { AgentBuilderTests } from "./AgentBuilderTests";
import { type AgentHistorySelection, AgentRunHistory } from "./AgentRunHistory";
import { AgentRunSession } from "./AgentRunSession";

/** Real paged execution evidence, not aggregate metrics inferred from a sample. */
export function AgentBuilderInsights({
	organizationId,
	instanceId,
	instanceSId,
	agentsHref,
	onImprove,
	hasUnsavedChanges = false,
}: {
	organizationId: string;
	instanceId?: string;
	instanceSId?: string;
	agentsHref: string;
	onImprove?: (message: string) => void;
	hasUnsavedChanges?: boolean;
}) {
	const [section, setSection] = useState("runs");
	const [selected, setSelected] = useState<AgentHistorySelection>();
	if (!instanceId) {
		return (
			<div className="space-y-3 p-5">
				<h2 className="font-semibold">Learn from real runs</h2>
				<p className="text-sm text-muted-foreground">
					Save your agent, then run a task. Return here to inspect its
					outcome, sources, and quality checks.
				</p>
				<p className="text-sm text-muted-foreground">
					Instruction previews are temporary tests and do not appear
					in saved-agent history.
				</p>
			</div>
		);
	}
	return (
		<div className="h-full min-h-0 overflow-y-auto">
			<Tabs
				value={section}
				onValueChange={setSection}
				className="h-full min-h-0"
			>
				<TabsList aria-label="Agent insights" className="mx-5 mt-3">
					<TabsTrigger value="runs">Runs</TabsTrigger>
					<TabsTrigger value="tests">Your tests</TabsTrigger>
				</TabsList>
				<TabsContent value="tests" className="m-0">
					<RunQualityPanel
						key={instanceId}
						organizationId={organizationId}
						targetType="AGENT"
						targetId={instanceId}
						hasUnsavedChanges={hasUnsavedChanges}
						onImprove={onImprove}
						onInspectExecution={(executionId) => {
							setSelected({
								id: executionId,
								instanceId,
								agentName: "Agent",
							});
							setSection("runs");
						}}
					/>

					<AgentBuilderTests
						organizationId={organizationId}
						instanceId={instanceId}
						instanceSId={instanceSId}
						agentsHref={agentsHref}
						onImprove={onImprove}
						hasUnsavedChanges={hasUnsavedChanges}
					/>
				</TabsContent>
				<TabsContent value="runs" className="m-0">
					<div className="space-y-2 border-b border-border p-5">
						<h2 className="font-semibold">Learn from real runs</h2>
						<p className="text-sm text-muted-foreground">
							Inspect outcomes and results from this agent’s saved
							configuration. Unsaved edits apply after you save
							and start a new run.
						</p>
						<Button
							variant="link"
							size="sm"
							className="h-auto p-0"
							asChild
						>
							<Link
								href={`${agentsHref}?tab=tasks&runAgentId=${encodeURIComponent(instanceId)}`}
								target="_blank"
								rel="noopener noreferrer"
							>
								Open full run history (opens a new tab)
							</Link>
						</Button>
					</div>
					{selected ? (
						<AgentRunSession
							key={selected.id}
							organizationId={organizationId}
							instanceId={selected.instanceId}
							executionId={selected.id}
							mode="result"
							editHref={`${agentsHref}/${encodeURIComponent(instanceId)}/edit`}
							onStarted={() => undefined}
							onBack={() => setSelected(undefined)}
						/>
					) : (
						<AgentRunHistory
							organizationId={organizationId}
							instanceId={instanceId}
							compact
							onSelect={setSelected}
						/>
					)}
				</TabsContent>
			</Tabs>
		</div>
	);
}
