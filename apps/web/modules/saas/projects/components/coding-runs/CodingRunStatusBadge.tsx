"use client";

import { Badge } from "@ui/components/badge";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import {
	CheckCircleIcon,
	CircleXIcon,
	ExternalLinkIcon,
	GitPullRequestIcon,
	Loader2Icon,
	MessagesSquareIcon,
	MonitorIcon,
} from "lucide-react";

type CodingRunStatus =
	| "QUEUED"
	| "STARTING"
	| "RUNNING"
	| "AWAITING_REVIEW"
	| "PR_OPENED"
	| "COMPLETED"
	| "FAILED"
	| "CANCELLED"
	| "TERMINATED_STALE";

type Props = {
	status: CodingRunStatus;
	pullRequestUrl?: string | null;
	sessionUrl?: string | null;
	provider?: "BACKGROUND_AGENTS" | "KANBAN_LOCAL" | null;
	externalStatus?: string | null;
	providerMetadata?: unknown;
};

const STATUS_CONFIG: Record<
	CodingRunStatus,
	{
		label: string;
		variant: "default" | "secondary" | "destructive" | "outline";
	}
> = {
	QUEUED: { label: "Queued", variant: "outline" },
	STARTING: { label: "Starting", variant: "outline" },
	RUNNING: { label: "Agent Working", variant: "secondary" },
	AWAITING_REVIEW: { label: "Awaiting Review", variant: "default" },
	PR_OPENED: { label: "PR Opened", variant: "default" },
	COMPLETED: { label: "Completed", variant: "secondary" },
	FAILED: { label: "Failed", variant: "destructive" },
	CANCELLED: { label: "Cancelled", variant: "outline" },
	// Killed by the every-5-minute watchdog after exceeding
	// CODING_RUN_MAX_MINUTES. Render as a FAILED-equivalent.
	TERMINATED_STALE: {
		label: "Stopped — exceeded max duration",
		variant: "destructive",
	},
};

export function CodingRunStatusBadge({
	status,
	pullRequestUrl,
	sessionUrl,
	provider: _provider,
	externalStatus,
	providerMetadata: _providerMetadata,
}: Props) {
	const config = STATUS_CONFIG[status];
	const label = config.label;

	const badge = (
		<Badge
			variant={config.variant}
			className="gap-1 text-[10px] font-medium"
		>
			<StatusIcon status={status} />
			{label}
			{sessionUrl && !pullRequestUrl && (
				<a
					href={sessionUrl}
					target="_blank"
					rel="noopener noreferrer"
					onClick={(e) => e.stopPropagation()}
					className="ml-0.5"
					aria-label="View implementation session"
				>
					<MonitorIcon className="size-2.5" />
				</a>
			)}
			{pullRequestUrl && (
				<a
					href={pullRequestUrl}
					target="_blank"
					rel="noopener noreferrer"
					onClick={(e) => e.stopPropagation()}
					className="ml-0.5"
					aria-label="View pull request"
				>
					<ExternalLinkIcon className="size-2.5" />
				</a>
			)}
		</Badge>
	);

	const tooltipLines = [
		pullRequestUrl
			? "View Pull Request"
			: sessionUrl
				? "View Implementation Session"
				: config.label,
	];
	if (externalStatus) {
		tooltipLines.push(`Runtime: ${externalStatus}`);
	}

	return (
		<Tooltip>
			<TooltipTrigger asChild>{badge}</TooltipTrigger>
			<TooltipContent>
				<div className="space-y-1 text-xs">
					{tooltipLines.map((line, index) => (
						<p key={`${line}-${index}`}>{line}</p>
					))}
				</div>
			</TooltipContent>
		</Tooltip>
	);
}

function StatusIcon({
	status,
	workspaceReview,
}: {
	status: CodingRunStatus;
	workspaceReview?: boolean;
}) {
	if (workspaceReview && status === "AWAITING_REVIEW") {
		return <MessagesSquareIcon className="size-3" />;
	}

	switch (status) {
		case "QUEUED":
		case "STARTING":
		case "RUNNING":
			return <Loader2Icon className="size-3 animate-spin" />;
		case "AWAITING_REVIEW":
			return <MessagesSquareIcon className="size-3" />;
		case "PR_OPENED":
			return <GitPullRequestIcon className="size-3" />;
		case "COMPLETED":
			return <CheckCircleIcon className="size-3" />;
		case "FAILED":
		case "CANCELLED":
		case "TERMINATED_STALE":
			return <CircleXIcon className="size-3" />;
	}
}
