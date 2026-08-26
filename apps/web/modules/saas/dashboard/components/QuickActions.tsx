"use client";

import { McpLogo } from "@saas/mcp/components/McpLogo";
import { ChatBubbleLeftRightIcon } from "@saas/shared/components/icons/ChatBubbleLeftRightIcon";
import { FolderOpenIcon } from "@saas/shared/components/icons/FolderOpenIcon";
import { PuzzleIcon } from "@saas/shared/components/icons/PuzzleIcon";
import { RobotIcon } from "@saas/shared/components/icons/RobotIcon";
import { TemporalLogo } from "@saas/workflows/components/TemporalLogo";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { FileTextIcon } from "lucide-react";
import { useRouter } from "next/navigation";

function McpIcon({ className }: { className?: string }) {
	return <McpLogo className={className} size={16} />;
}

function TemporalIcon({ className }: { className?: string }) {
	return <TemporalLogo className={className} size={16} />;
}

interface QuickActionsProps {
	organizationSlug?: string;
}

export function QuickActions({ organizationSlug }: QuickActionsProps) {
	const router = useRouter();
	const basePath = organizationSlug ? `/app/${organizationSlug}` : "/app";

	const actions = [
		{
			title: "New Project",
			icon: FolderOpenIcon,
			onClick: () => router.push(`${basePath}/projects/new`),
		},
		{
			title: "New Agent",
			icon: RobotIcon,
			onClick: () => router.push(`${basePath}/agents`),
		},
		{
			title: "New Workflow",
			icon: TemporalIcon,
			onClick: () => router.push(`${basePath}/workflows/new`),
		},
		{
			title: "New Prompt",
			icon: FileTextIcon,
			onClick: () => router.push(`${basePath}/prompts/new`),
		},
		{
			title: "Start Chat",
			icon: ChatBubbleLeftRightIcon,
			onClick: () => router.push(`${basePath}/nexus`),
		},
		{
			title: "New Skill",
			icon: PuzzleIcon,
			onClick: () => router.push(`${basePath}/skills/new`),
		},
		{
			title: "Connect MCP",
			icon: McpIcon,
			onClick: () => router.push(`${basePath}/mcp-servers`),
		},
	];

	return (
		<Card>
			<CardHeader className="pb-3 pt-4 px-5">
				<CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
					Quick Actions
				</CardTitle>
			</CardHeader>
			<CardContent className="px-5 pb-4">
				<div className="flex flex-wrap gap-2">
					{actions.map((action) => {
						const Icon = action.icon;
						return (
							<button
								key={action.title}
								type="button"
								onClick={action.onClick}
								className="flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm font-medium text-foreground transition-colors duration-150 cursor-pointer hover:bg-muted hover:border-primary/20"
							>
								<Icon
									className="h-4 w-4 shrink-0 text-primary"
									aria-hidden="true"
								/>
								<span className="whitespace-nowrap">
									{action.title}
								</span>
							</button>
						);
					})}
				</div>
			</CardContent>
		</Card>
	);
}
