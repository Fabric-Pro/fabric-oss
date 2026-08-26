"use client";

import {
	getAgentSelectionSummary,
	getBuiltInCapability,
} from "@saas/agents/lib/builtin-capabilities";
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
import { formatDistanceToNow } from "date-fns";
import {
	ActivityIcon,
	CheckCircleIcon,
	Edit2Icon,
	LinkIcon,
	LoaderIcon,
	MoreVerticalIcon,
	TrashIcon,
	XCircleIcon,
} from "lucide-react";
import { FrameworkIcon } from "./FrameworkIcon";

interface AgentsListViewProps {
	agents: any[];
	onEdit: (agent: any) => void;
	onDelete: (agent: any) => void;
	onHealthCheck: (agent: any) => void;
	loadingHealthCheck?: boolean;
}

export function AgentsListView({
	agents,
	onEdit,
	onDelete,
	onHealthCheck,
	loadingHealthCheck = false,
}: AgentsListViewProps) {
	return (
		<TooltipProvider>
			<div className="space-y-3">
				{agents.map((agent) => (
					<AgentListItem
						key={agent.id}
						agent={agent}
						onEdit={onEdit}
						onDelete={onDelete}
						onHealthCheck={onHealthCheck}
						loadingHealthCheck={loadingHealthCheck}
					/>
				))}
			</div>
		</TooltipProvider>
	);
}

function AgentListItem({
	agent,
	onEdit,
	onDelete,
	onHealthCheck,
	loadingHealthCheck,
}: {
	agent: any;
	onEdit: (agent: any) => void;
	onDelete: (agent: any) => void;
	onHealthCheck: (agent: any) => void;
	loadingHealthCheck: boolean;
}) {
	const selectionSummary = getAgentSelectionSummary(agent);
	const selectionPreview = [
		...selectionSummary.skillDetails.map((skill) => skill.name),
		...selectionSummary.capabilityIds.map(
			(capabilityId) =>
				getBuiltInCapability(capabilityId)?.name ?? capabilityId,
		),
	];

	const getStatusBadge = () => {
		switch (agent.status) {
			case "ACTIVE":
				return (
					<Badge className="bg-green-500/10 text-green-700 dark:bg-green-500/20 dark:text-green-400 border-0">
						<CheckCircleIcon className="mr-1 size-3" />
						Active
					</Badge>
				);
			case "INACTIVE":
				return (
					<Badge className="bg-gray-500/10 text-gray-700 dark:bg-gray-500/20 dark:text-gray-400 border-0">
						Inactive
					</Badge>
				);
			case "DEPLOYING":
				return (
					<Badge className="bg-blue-500/10 text-blue-700 dark:bg-blue-500/20 dark:text-blue-400 border-0">
						<LoaderIcon className="mr-1 size-3 animate-spin" />
						Deploying
					</Badge>
				);
			case "ERROR":
				return (
					<Badge className="bg-red-500/10 text-red-700 dark:bg-red-500/20 dark:text-red-400 border-0">
						<XCircleIcon className="mr-1 size-3" />
						Error
					</Badge>
				);
			case "MAINTENANCE":
				return (
					<Badge className="bg-yellow-500/10 text-yellow-700 dark:bg-yellow-500/20 dark:text-yellow-400 border-0">
						Maintenance
					</Badge>
				);
			default:
				return <Badge variant="secondary">Unknown</Badge>;
		}
	};

	return (
		<Card className="hover:shadow-md transition-all group">
			<div className="w-full p-4">
				<div className="flex items-start justify-between gap-4">
					<div className="flex-1 min-w-0">
						<div className="flex items-center gap-3 mb-2 flex-wrap">
							<Tooltip delayDuration={500}>
								<TooltipTrigger asChild>
									<span className="inline-block">
										<h3 className="font-semibold text-lg line-clamp-1">
											{agent.displayName}
										</h3>
									</span>
								</TooltipTrigger>
								<TooltipContent>
									<p>{agent.displayName}</p>
								</TooltipContent>
							</Tooltip>
							{getStatusBadge()}
							<FrameworkIcon
								framework={agent.framework}
								size={16}
							/>
						</div>

						{/* Description */}
						{agent.description && (
							<p className="text-sm text-muted-foreground line-clamp-1 mb-2">
								{agent.description}
							</p>
						)}

						{selectionPreview.length > 0 && (
							<div className="mb-3 flex flex-wrap gap-1.5">
								{selectionPreview.slice(0, 3).map((item) => (
									<Badge
										key={item}
										variant="outline"
										className="text-xs"
									>
										{item}
									</Badge>
								))}
								{selectionPreview.length > 3 && (
									<Badge
										variant="outline"
										className="text-xs"
									>
										+{selectionPreview.length - 3} more
									</Badge>
								)}
							</div>
						)}

						<div className="flex items-center gap-6 text-sm text-muted-foreground flex-wrap">
							{/* Deployment URL */}
							{agent.deploymentUrl && (
								<div className="flex items-center gap-2">
									<LinkIcon className="size-3" />
									<span className="text-xs truncate max-w-md">
										{agent.deploymentUrl}
									</span>
								</div>
							)}

							{/* Last Health Check */}
							{agent.lastHealthCheck && (
								<div className="text-xs text-muted-foreground">
									Checked{" "}
									{formatDistanceToNow(
										new Date(agent.lastHealthCheck),
										{
											addSuffix: true,
										},
									)}
								</div>
							)}
						</div>
					</div>

					<div className="flex items-center gap-2">
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button
									variant="ghost"
									size="sm"
									className="md:opacity-0 md:group-hover:opacity-100 transition-opacity focus:opacity-100"
								>
									<MoreVerticalIcon className="h-4 w-4" />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuItem
									onClick={() => onHealthCheck(agent)}
									disabled={loadingHealthCheck}
								>
									{loadingHealthCheck ? (
										<LoaderIcon className="mr-2 h-4 w-4 animate-spin" />
									) : (
										<ActivityIcon className="mr-2 h-4 w-4" />
									)}
									Health Check
								</DropdownMenuItem>
								<DropdownMenuItem onClick={() => onEdit(agent)}>
									<Edit2Icon className="mr-2 h-4 w-4" />
									Edit
								</DropdownMenuItem>
								<DropdownMenuSeparator />
								<DropdownMenuItem
									onClick={() => onDelete(agent)}
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
