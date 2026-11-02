"use client";

import { getCategoryIcon } from "@saas/agents/lib/category-icons";
import { buildAgentInstanceChatHref } from "@saas/agents/lib/fabric-agent-links";
import { useFeatureFlag } from "@saas/shared/components/FeatureFlagProvider";
import { Button } from "@ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ui/components/table";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { formatDistanceToNow } from "date-fns";
import {
	BarChart2,
	Columns3,
	CopyIcon,
	EditIcon,
	MessageSquare,
	MoreVerticalIcon,
	PlayIcon,
	TrashIcon,
	User,
} from "lucide-react";
import Link from "next/link";
import { FrameworkIcon } from "./FrameworkIcon";

interface UnifiedAgentListViewProps {
	items: any[];
	basePath: string;
	onDeleteInstance: (id: string) => void;
}

export function UnifiedAgentListView({
	items,
	basePath,
	onDeleteInstance,
}: UnifiedAgentListViewProps) {
	return (
		<TooltipProvider>
			<div className="overflow-hidden rounded-lg border border-border bg-card">
				<Table>
					<TableHeader>
						<TableRow className="hover:bg-transparent">
							<TableHead className="w-[32%]">Name</TableHead>
							<TableHead className="w-[30%]">
								Description
							</TableHead>
							<TableHead className="w-[14%]">Modified</TableHead>
							<TableHead className="w-[14%]">Owner</TableHead>
							<TableHead className="w-[10%]">Tags</TableHead>
							<TableHead className="w-10 text-right">
								<span className="inline-flex items-center justify-end text-muted-foreground">
									<Columns3
										aria-hidden="true"
										className="h-3.5 w-3.5"
									/>
									<span className="sr-only">Actions</span>
								</span>
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{items.map((item: any) =>
							item._type === "instance" ? (
								<InstanceTableRow
									key={item.id}
									instance={item}
									basePath={basePath}
									onDelete={onDeleteInstance}
								/>
							) : (
								<SystemAgentTableRow
									key={item.id}
									agent={item}
								/>
							),
						)}
					</TableBody>
				</Table>
			</div>
		</TooltipProvider>
	);
}

function SystemAgentTableRow({ agent }: { agent: any }) {
	const AgentIcon = agent.icon || MessageSquare;
	const agentHref = agent.href || `/app/agents/${agent.id}/try`;
	const modifiedLabel = agent.updatedAt
		? formatDistanceToNow(new Date(agent.updatedAt), { addSuffix: true })
		: "Recently";

	return (
		<TableRow className="group">
			<TableCell className="py-2.5">
				<div className="flex items-center gap-2.5 min-w-0">
					<div className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-border/70 bg-muted/40 text-muted-foreground">
						<AgentIcon className="h-3.5 w-3.5 text-primary" />
					</div>
					<Tooltip delayDuration={400}>
						<TooltipTrigger asChild>
							<Link
								href={agentHref}
								className="truncate text-[13px] font-medium text-foreground hover:text-primary hover:underline"
							>
								{agent.displayName}
							</Link>
						</TooltipTrigger>
						<TooltipContent>
							<p>{agent.displayName}</p>
						</TooltipContent>
					</Tooltip>
					<BarChart2
						aria-hidden="true"
						className="h-3.5 w-3.5 shrink-0 text-emerald-600/80 dark:text-emerald-400/80"
					/>
				</div>
			</TableCell>
			<TableCell className="py-2.5 text-[13px] text-muted-foreground">
				<span className="line-clamp-1">{agent.description || "-"}</span>
			</TableCell>
			<TableCell className="py-2.5 text-[13px] text-muted-foreground whitespace-nowrap">
				{modifiedLabel}
			</TableCell>
			<TableCell className="py-2.5 text-[13px] text-muted-foreground whitespace-nowrap">
				<span className="inline-flex items-center gap-1.5">
					<User className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
					<span>System</span>
				</span>
			</TableCell>
			<TableCell className="py-2.5">
				<div className="flex items-center gap-1.5">
					{agent.framework ? (
						<span className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
							<FrameworkIcon
								framework={agent.framework}
								size={12}
							/>
							{agent.framework}
						</span>
					) : (
						<span className="text-[13px] text-muted-foreground">
							-
						</span>
					)}
				</div>
			</TableCell>
			<TableCell className="py-2.5 text-right">
				<Button
					asChild
					variant="ghost"
					size="sm"
					className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
				>
					<Link href={agentHref}>Try Agent</Link>
				</Button>
			</TableCell>
		</TableRow>
	);
}

function InstanceTableRow({
	instance,
	basePath,
	onDelete,
}: {
	instance: any;
	basePath: string;
	onDelete: (id: string) => void;
}) {
	const { icon: CategoryIcon } = getCategoryIcon(instance.template?.category);
	const editHref = `${basePath}/agents/${instance.id}/edit`;
	const unifiedAgentInterface = useFeatureFlag("UNIFIED_AGENT_INTERFACE");
	const chatbotHref = buildAgentInstanceChatHref({
		basePath,
		instance,
		unifiedAgentInterface,
	});
	const modifiedSource = instance.lastRunAt || instance.updatedAt;
	const modifiedLabel = modifiedSource
		? formatDistanceToNow(new Date(modifiedSource), { addSuffix: true })
		: "Never";
	const ownerLabel =
		instance.createdBy?.name ||
		(instance.organizationId ? "Organization" : "Personal");
	const tagLabel = instance.template?.displayName;

	return (
		<TableRow className="group">
			<TableCell className="py-2.5">
				<div className="flex items-center gap-2.5 min-w-0">
					<div className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-border/70 bg-muted/40 text-muted-foreground">
						<CategoryIcon className="h-3.5 w-3.5 text-primary" />
					</div>
					<Link
						href={chatbotHref}
						className="truncate text-[13px] font-medium text-foreground hover:text-primary hover:underline"
					>
						{instance.name}
					</Link>
					<BarChart2
						aria-hidden="true"
						className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60"
					/>
				</div>
			</TableCell>
			<TableCell className="py-2.5 text-[13px] text-muted-foreground">
				<span className="line-clamp-1">
					{instance.description || "-"}
				</span>
			</TableCell>
			<TableCell className="py-2.5 text-[13px] text-muted-foreground whitespace-nowrap">
				{modifiedLabel}
			</TableCell>
			<TableCell className="py-2.5 text-[13px] text-muted-foreground whitespace-nowrap">
				<span className="inline-flex items-center gap-1.5">
					<User className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
					<span>{ownerLabel}</span>
				</span>
			</TableCell>
			<TableCell className="py-2.5">
				{tagLabel ? (
					<span className="inline-flex items-center rounded bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
						{tagLabel}
					</span>
				) : (
					<span className="text-[13px] text-muted-foreground">-</span>
				)}
			</TableCell>
			<TableCell className="py-2.5 text-right">
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label={`Actions for ${instance.name}`}
							className="h-7 w-7"
						>
							<MoreVerticalIcon className="h-3.5 w-3.5" />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						<DropdownMenuItem asChild>
							<Link href={editHref}>
								<EditIcon className="mr-2 h-4 w-4" />
								Edit
							</Link>
						</DropdownMenuItem>
						<DropdownMenuItem asChild>
							<Link href={chatbotHref}>
								<PlayIcon className="mr-2 h-4 w-4" />
								Try Agent
							</Link>
						</DropdownMenuItem>
						<DropdownMenuItem asChild>
							<Link
								href={editHref.replace("/edit", "/duplicate")}
							>
								<CopyIcon className="mr-2 h-4 w-4" />
								Duplicate
							</Link>
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							onClick={() => onDelete(instance.id)}
							className="text-destructive"
						>
							<TrashIcon className="mr-2 h-4 w-4" />
							Delete
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</TableCell>
		</TableRow>
	);
}
