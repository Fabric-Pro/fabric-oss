"use client";

import {
	getAgentSelectionSummary,
	getBuiltInCapability,
} from "@saas/agents/lib/builtin-capabilities";
import { useContextPath } from "@saas/organizations/hooks/use-organization-context";
import { RobotIcon } from "@saas/shared/components/icons/RobotIcon";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { formatDistanceToNow } from "date-fns";
import {
	ActivityIcon,
	ArrowRightIcon,
	PencilIcon,
	SparklesIcon,
	Trash2Icon,
	ZapIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

interface AgentCardProps {
	agent: {
		id: string;
		name: string;
		displayName: string;
		description?: string | null;
		framework: string;
		status: string;
		deploymentUrl?: string | null;
		lastHealthCheck?: Date | string | null;
		lastHealthError?: string | null;
		iconUrl?: string | null;
		author?: string | null;
		category?: string | null;
		config?: Record<string, unknown> | null;
		metadata?: Record<string, unknown> | null;
		scope?: string;
		heroEmojis?: string[];
		heroImageUrl?: string | null;
		href?: string;
		updatedAt?: Date | string | null;
		conversationCount?: number;
	};
	onEdit?: (agent: any) => void;
	onDelete?: (agent: any) => void;
	onHealthCheck?: (agent: any) => void;
	loadingHealthCheck?: boolean;
	disabled?: boolean;
	isPublic?: boolean;
	onViewInsights?: (agent: any) => void;
}

const statusConfig: Record<
	string,
	{ label: string; className: string; dot: string }
> = {
	ACTIVE: {
		label: "Active",
		className: "bg-success/10 text-success",
		dot: "bg-success",
	},
	DEPLOYING: {
		label: "Deploying",
		className: "bg-highlight/10 text-highlight",
		dot: "bg-highlight animate-pulse",
	},
	ERROR: {
		label: "Error",
		className: "bg-destructive/10 text-destructive",
		dot: "bg-destructive",
	},
	STALE: {
		label: "Stale",
		className: "bg-highlight/10 text-highlight",
		dot: "bg-highlight",
	},
	INACTIVE: {
		label: "Inactive",
		className: "bg-muted text-muted-foreground",
		dot: "bg-muted-foreground/50",
	},
};

const frameworkColors: Record<string, string> = {
	LANGGRAPH: "bg-primary/10 text-primary",
	CREWAI: "bg-secondary/10 text-secondary",
	AUTOGEN: "bg-highlight/10 text-highlight",
	CUSTOM: "bg-muted text-muted-foreground",
};

export function AgentCard({
	agent,
	onEdit,
	onDelete,
	onHealthCheck,
	onViewInsights,
}: AgentCardProps) {
	const router = useRouter();
	const t = useTranslations("tooltips.agents");
	const baseAgentsPath = useContextPath("agents");
	const selectionSummary = getAgentSelectionSummary(agent);
	const selectionPreview = [
		...selectionSummary.skillDetails.map((skill) => ({
			id: skill.id,
			label: skill.name,
		})),
		...selectionSummary.capabilityIds.map((capabilityId) => ({
			id: capabilityId,
			label: getBuiltInCapability(capabilityId)?.name ?? capabilityId,
		})),
	];

	const statusInfo = statusConfig[agent.status] ?? statusConfig.INACTIVE;
	const frameworkClass =
		frameworkColors[agent.framework?.toUpperCase()] ??
		frameworkColors.CUSTOM;
	const runCount = agent.conversationCount ?? 0;
	const tags = agent.category ? [agent.category] : [];
	const internalHref =
		typeof agent.href === "string" && agent.href.startsWith("/")
			? agent.href
			: null;
	const detailHref = internalHref ?? `${baseAgentsPath}/${agent.id}`;
	const editHref = `${baseAgentsPath}/${agent.id}/edit`;
	const isCardNavigable = Boolean(detailHref);

	const handleViewAgent = () => {
		if (detailHref) {
			router.push(detailHref);
		}
	};

	// Only surfaced when a health check actually failed — an empty tooltip on
	// every healthy card would be noise.
	const healthErrorCopy =
		agent.status === "ERROR" && agent.lastHealthError
			? t("healthError", { error: agent.lastHealthError })
			: null;

	// The chip already names itself with visible text (`statusInfo.label`), so
	// the failure detail rides along as an `sr-only` child rather than an
	// `aria-label` that would replace that name.
	const statusChip = (
		<span
			className={cn(
				"text-[10px] px-1.5 py-0.5 rounded font-medium leading-tight flex items-center gap-1",
				statusInfo.className,
			)}
		>
			<span className={cn("h-1.5 w-1.5 rounded-full", statusInfo.dot)} />
			{statusInfo.label}
			{healthErrorCopy ? (
				<span className="sr-only">{healthErrorCopy}</span>
			) : null}
		</span>
	);

	return (
		<div className="group relative flex flex-col w-full rounded-xl border bg-card transition-colors hover:border-primary/30 hover:bg-muted/20">
			{/* Status badge — absolute top-right, matches ProjectCard */}
			<div className="absolute top-3 right-3 z-10 flex items-center gap-1">
				{healthErrorCopy ? (
					<Tooltip>
						<TooltipTrigger asChild>{statusChip}</TooltipTrigger>
						<TooltipContent>{healthErrorCopy}</TooltipContent>
					</Tooltip>
				) : (
					statusChip
				)}
			</div>

			{/* Header */}
			<button
				type="button"
				className={cn(
					"flex gap-3 p-4 pb-3 text-left",
					isCardNavigable ? "cursor-pointer" : "cursor-default",
				)}
				onClick={handleViewAgent}
				disabled={!isCardNavigable}
			>
				{/* Icon — matches ProjectCard h-9 w-9 rounded-lg */}
				<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
					<RobotIcon className="h-4.5 w-4.5 text-primary" />
				</div>

				{/* Content — pr-16 clears the absolute status badge */}
				<div className="flex-1 min-w-0 pr-16">
					<h3 className="font-semibold text-sm leading-snug line-clamp-2 group-hover:text-primary transition-colors">
						{agent.displayName}
					</h3>
					<p className="mt-1 text-xs text-muted-foreground line-clamp-2 leading-relaxed">
						{agent.description || "No description provided"}
					</p>
				</div>
			</button>

			{/* Badges — compact to match ProjectCard tags */}
			{(tags.length > 0 ||
				agent.framework ||
				selectionPreview.length > 0 ||
				agent.scope) && (
				<div className="px-4 pb-3 flex flex-wrap gap-1">
					{agent.scope ? (
						<Badge
							variant={
								agent.scope === "SYSTEM" ? "default" : "outline"
							}
							className="text-[10px] px-1.5 py-0 font-normal h-4"
						>
							{agent.scope === "SYSTEM"
								? "System Agent"
								: agent.scope}
						</Badge>
					) : null}
					{tags.map((tag) => (
						<Badge
							key={tag}
							variant="secondary"
							className="text-[10px] px-1.5 py-0 font-normal h-4"
						>
							{tag}
						</Badge>
					))}
					<span
						className={cn(
							"text-[10px] px-1.5 py-0 rounded font-medium h-4 flex items-center",
							frameworkClass,
						)}
					>
						{agent.framework}
					</span>
					{selectionPreview.slice(0, 2).map((item) => (
						<Badge
							key={item.id}
							variant="outline"
							className="text-[10px] px-1.5 py-0 font-normal h-4"
						>
							{item.label}
						</Badge>
					))}
					{selectionPreview.length > 2 && (
						<span className="text-[10px] text-muted-foreground">
							+{selectionPreview.length - 2}
						</span>
					)}
				</div>
			)}

			{/* Footer — matches ProjectCard pattern */}
			<div className="mt-auto flex items-center justify-between border-t px-4 py-2.5">
				<div className="flex items-center gap-3 text-[11px] text-muted-foreground">
					<span className="flex items-center gap-1">
						<ZapIcon className="h-3 w-3" />
						{runCount} {runCount === 1 ? "run" : "runs"}
					</span>
					{agent.updatedAt && (
						<span>
							{formatDistanceToNow(
								typeof agent.updatedAt === "string"
									? new Date(agent.updatedAt)
									: agent.updatedAt,
								{ addSuffix: true },
							)}
						</span>
					)}
				</div>
				<ArrowRightIcon className="h-3.5 w-3.5 text-primary opacity-0 group-hover:opacity-100 group-hover:translate-x-0.5 transition-[opacity,transform] duration-150" />
			</div>
			{(onHealthCheck || onEdit || onDelete || onViewInsights) && (
				<TooltipProvider>
					<div className="flex items-center gap-2 border-t px-4 py-3">
						{onViewInsights && (
							<Tooltip delayDuration={500}>
								<TooltipTrigger asChild>
									<Button
										size="icon-sm"
										variant="outline"
										onClick={() => onViewInsights(agent)}
										aria-label="Insights"
									>
										<SparklesIcon className="h-4 w-4" />
									</Button>
								</TooltipTrigger>
								<TooltipContent>Insights</TooltipContent>
							</Tooltip>
						)}
						{onHealthCheck && (
							<Tooltip delayDuration={500}>
								<TooltipTrigger asChild>
									<Button
										size="icon-sm"
										variant="outline"
										onClick={() => onHealthCheck(agent)}
										aria-label="Health Check"
									>
										<ActivityIcon className="h-4 w-4" />
									</Button>
								</TooltipTrigger>
								<TooltipContent>Health Check</TooltipContent>
							</Tooltip>
						)}
						{onEdit && (
							<Tooltip delayDuration={500}>
								<TooltipTrigger asChild>
									<Button
										size="icon-sm"
										variant="outline"
										onClick={() => router.push(editHref)}
										aria-label="Edit"
									>
										<PencilIcon className="h-4 w-4" />
									</Button>
								</TooltipTrigger>
								<TooltipContent>Edit</TooltipContent>
							</Tooltip>
						)}
						{onDelete && (
							<Tooltip delayDuration={500}>
								<TooltipTrigger asChild>
									<Button
										size="icon-sm"
										variant="outline"
										onClick={() => onDelete(agent)}
										aria-label="Delete"
									>
										<Trash2Icon className="h-4 w-4" />
									</Button>
								</TooltipTrigger>
								<TooltipContent>Delete</TooltipContent>
							</Tooltip>
						)}
					</div>
				</TooltipProvider>
			)}
		</div>
	);
}
