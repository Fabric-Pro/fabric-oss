"use client";

import { getCategoryIcon } from "@saas/agents/lib/category-icons";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { formatDistanceToNow } from "date-fns";
import {
	Activity,
	CheckCircle2,
	CopyIcon,
	EditIcon,
	MessageSquare,
	MoreVerticalIcon,
	PlayIcon,
	TrashIcon,
	XCircle,
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
			<div className="space-y-3">
				{items.map((item: any) =>
					item._type === "instance" ? (
						<InstanceListRow
							key={item.id}
							instance={item}
							basePath={basePath}
							onDelete={onDeleteInstance}
						/>
					) : (
						<SystemAgentListRow key={item.id} agent={item} />
					),
				)}
			</div>
		</TooltipProvider>
	);
}

function SystemAgentListRow({ agent }: { agent: any }) {
	const AgentIcon = agent.icon || MessageSquare;
	const agentHref = agent.href || `/app/agents/${agent.id}/try`;

	return (
		<Card className="hover:shadow-md transition-all group">
			<div className="p-4">
				<div className="flex items-center justify-between gap-4">
					<div className="flex items-center gap-3 flex-1 min-w-0">
						<div className="p-2 rounded-lg bg-primary/10 shrink-0">
							<AgentIcon className="h-5 w-5 text-primary" />
						</div>
						<div className="flex-1 min-w-0">
							<Tooltip delayDuration={500}>
								<TooltipTrigger asChild>
									<h3 className="font-semibold text-base line-clamp-1 mb-1">
										{agent.displayName}
									</h3>
								</TooltipTrigger>
								<TooltipContent>
									<p>{agent.displayName}</p>
								</TooltipContent>
							</Tooltip>
							<p className="text-sm text-muted-foreground line-clamp-1">
								{agent.description ||
									"No description available"}
							</p>
						</div>
					</div>

					<div className="flex items-center gap-6 shrink-0">
						<StatusBadge status={agent.status} />
						<ScopeBadge scope={agent.scope} />
						{agent.framework && (
							<div className="min-w-[24px] flex justify-center">
								<FrameworkIcon
									framework={agent.framework}
									size={20}
								/>
							</div>
						)}
						<Link href={agentHref}>
							<Button variant="outline" size="sm">
								Try Agent
							</Button>
						</Link>
					</div>
				</div>
			</div>
		</Card>
	);
}

function InstanceListRow({
	instance,
	basePath,
	onDelete,
}: {
	instance: any;
	basePath: string;
	onDelete: (id: string) => void;
}) {
	const { icon: CategoryIcon, gradient } = getCategoryIcon(
		instance.template?.category,
	);
	const editHref = `${basePath}/agents/${instance.id}/edit`;
	const chatbotHref = `${basePath}/nexus?agent=${encodeURIComponent(
		JSON.stringify({
			agentId: `template-instance:${instance.id}`,
			name: instance.name,
			description: instance.description ?? "",
		}),
	)}`;

	return (
		<Card className="hover:shadow-md transition-all group">
			<div className="p-4">
				<div className="flex items-center justify-between gap-4">
					<div className="flex items-center gap-3 flex-1 min-w-0">
						<div
							className={cn(
								"w-10 h-10 rounded-xl bg-gradient-to-br flex items-center justify-center shadow-sm shrink-0",
								gradient,
							)}
						>
							<CategoryIcon className="h-5 w-5 text-white" />
						</div>
						<div className="flex-1 min-w-0">
							<Link
								href={chatbotHref}
								className="font-semibold text-base line-clamp-1 mb-1 hover:text-primary block"
							>
								{instance.name}
							</Link>
							<p className="text-sm text-muted-foreground line-clamp-1">
								{instance.description ||
									"No description available"}
							</p>
						</div>
					</div>

					<div className="flex items-center gap-6 shrink-0">
						<Badge variant="secondary" className="text-xs">
							{instance.template?.displayName || "Custom"}
						</Badge>
						<Badge
							variant="default"
							className={
								instance.status === "ACTIVE"
									? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400 text-xs"
									: "text-xs"
							}
						>
							{instance.status === "ACTIVE"
								? "Active"
								: instance.status === "ARCHIVED"
									? "Archived"
									: instance.status === "DRAFT"
										? "Draft"
										: (instance.status ?? "Unknown")}
						</Badge>
						<span className="text-xs text-muted-foreground min-w-[60px] text-right">
							{instance.runCount || 0} runs
						</span>
						<span className="text-xs text-muted-foreground min-w-[80px] text-right">
							{instance.lastRunAt
								? formatDistanceToNow(
										new Date(instance.lastRunAt),
										{ addSuffix: true },
									)
								: "Never"}
						</span>
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button
									variant="ghost"
									size="icon-sm"
									className="h-8 w-8"
								>
									<MoreVerticalIcon className="h-4 w-4" />
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
										href={editHref.replace(
											"/edit",
											"/duplicate",
										)}
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
					</div>
				</div>
			</div>
		</Card>
	);
}

function ScopeBadge({ scope }: { scope: string }) {
	const variants: Record<
		string,
		{ variant: "default" | "secondary" | "outline"; label: string }
	> = {
		SYSTEM: { variant: "default", label: "System" },
		ORGANIZATION: { variant: "secondary", label: "Organization" },
		PERSONAL: { variant: "outline", label: "Personal" },
	};

	const config = variants[scope] || { variant: "outline", label: scope };

	return (
		<Badge
			variant={config.variant}
			className="text-xs min-w-[100px] justify-center"
		>
			{config.label}
		</Badge>
	);
}

function StatusBadge({ status }: { status: string }) {
	const getStatusIcon = () => {
		switch (status) {
			case "ACTIVE":
				return <CheckCircle2 className="h-3 w-3 mr-1" />;
			case "ERROR":
				return <XCircle className="h-3 w-3 mr-1" />;
			default:
				return <Activity className="h-3 w-3 mr-1" />;
		}
	};

	const variants: Record<string, "default" | "secondary" | "destructive"> = {
		ACTIVE: "default",
		INACTIVE: "secondary",
		DEPLOYING: "secondary",
		ERROR: "destructive",
		MAINTENANCE: "secondary",
	};

	return (
		<Badge
			variant={variants[status] || "secondary"}
			className="text-xs flex items-center min-w-[100px] justify-center"
		>
			{getStatusIcon()}
			{status}
		</Badge>
	);
}
