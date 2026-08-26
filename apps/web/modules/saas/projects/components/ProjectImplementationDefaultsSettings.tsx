"use client";

import { Card } from "@ui/components/card";
import {
	LaptopIcon,
	ServerCogIcon,
	TerminalIcon,
	WorkflowIcon,
} from "lucide-react";
import {
	getExecutionProviderDescription,
	getExecutionProviderLabel,
	getExecutionProviderPlatformLabel,
} from "../lib/implementation-session-labels";

interface ProjectImplementationDefaultsSettingsProps {
	project: {
		id: string;
		organizationId?: string | null;
		repositoryOwner?: string | null;
		repositoryName?: string | null;
	};
}

export function ProjectImplementationDefaultsSettings({
	project,
}: ProjectImplementationDefaultsSettingsProps) {
	const hasRepositoryContext =
		!!project.repositoryOwner && !!project.repositoryName;

	return (
		<Card className="border-foreground/5 shadow-sm">
			<div className="p-6 sm:p-8">
				{/* Header */}
				<div className="mb-8 flex items-start gap-4">
					<div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/20">
						<WorkflowIcon className="size-5" />
					</div>
					<div className="flex-1 space-y-2">
						<h3 className="text-lg font-semibold tracking-tight">
							Local Development
						</h3>
						<p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
							Queue features for local implementation using Fabric
							Kanban. Run{" "}
							<code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
								fabric-kanban
							</code>{" "}
							in your repository to pull queued items.
						</p>
					</div>
				</div>

				<div className="grid items-stretch gap-5 xl:grid-cols-2">
					{/* Background Agents Card */}
					<div className="group relative flex h-full flex-col overflow-hidden rounded-2xl border border-border/50 bg-gradient-to-br from-background to-muted/30 p-6 shadow-sm">
						<div className="mb-4 flex items-center gap-3">
							<div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted ring-1 ring-border/50">
								<ServerCogIcon className="size-4 text-primary" />
							</div>
							<h4 className="font-semibold text-foreground">
								{getExecutionProviderLabel("BACKGROUND_AGENTS")}
							</h4>
						</div>
						<p className="mb-3 text-sm leading-relaxed text-muted-foreground">
							{getExecutionProviderDescription(
								"BACKGROUND_AGENTS",
							)}
						</p>
						<p className="mt-auto text-xs leading-relaxed text-muted-foreground/80">
							Available for all projects regardless of local
							development setup.
						</p>
					</div>

					{/* Fabric Kanban Card */}
					<div className="group relative flex h-full flex-col overflow-hidden rounded-2xl border border-primary/20 bg-gradient-to-br from-primary/[0.03] to-primary/[0.06] p-6 shadow-sm">
						<div className="absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-primary/40 via-primary to-primary/40" />
						<div className="mb-4 flex items-center gap-3">
							<div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 ring-1 ring-primary/20">
								<LaptopIcon className="size-4 text-primary" />
							</div>
							<h4 className="font-semibold text-foreground">
								{getExecutionProviderLabel("KANBAN_LOCAL")}
							</h4>
						</div>
						<p className="mb-3 text-sm leading-relaxed text-muted-foreground">
							Queues features for local development through{" "}
							{getExecutionProviderPlatformLabel("KANBAN_LOCAL")}.
							The fabric-kanban CLI pulls queued items from this
							project using the connected repository&apos;s git
							remote URL.
						</p>

						{hasRepositoryContext ? (
							<p className="mt-auto text-xs leading-relaxed text-primary/80">
								Connected repository:{" "}
								<span className="font-medium">
									{project.repositoryOwner}/
									{project.repositoryName}
								</span>
							</p>
						) : (
							<p className="mt-auto text-xs leading-relaxed text-amber-600 dark:text-amber-400">
								Connect a repository to enable{" "}
								{getExecutionProviderLabel("KANBAN_LOCAL")}{" "}
								through{" "}
								{getExecutionProviderPlatformLabel(
									"KANBAN_LOCAL",
								)}{" "}
								for this project.
							</p>
						)}

						<div className="mt-4 space-y-2 rounded-xl border border-primary/15 bg-background/60 p-3">
							<div className="flex items-center gap-2">
								<TerminalIcon className="size-3.5 text-muted-foreground" />
								<p className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
									Install &amp; run
								</p>
							</div>
							<code className="block font-mono text-xs text-foreground">
								npm install -g @fabriccode/kanban@latest
							</code>
							<code className="block font-mono text-xs text-foreground">
								fabric-kanban
							</code>
						</div>
					</div>
				</div>
			</div>
		</Card>
	);
}
