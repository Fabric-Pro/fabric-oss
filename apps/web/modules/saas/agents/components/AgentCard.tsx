"use client";

import {
	getAgentSelectionSummary,
	getBuiltInCapability,
} from "@saas/agents/lib/builtin-capabilities";
import { useContextPath } from "@saas/organizations/hooks/use-organization-context";
import { Button } from "@ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { formatDistanceToNow } from "date-fns";
import {
	ActivityIcon,
	PencilIcon,
	SparklesIcon,
	Trash2Icon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { AgentTile, type AgentTileStatus, kindLabel } from "./AgentTile";

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

function toDate(value: Date | string | null | undefined): Date | null {
	if (!value) {
		return null;
	}
	const d = typeof value === "string" ? new Date(value) : value;
	return Number.isNaN(d.getTime()) ? null : d;
}

function ago(value: Date | string | null | undefined): string | null {
	const d = toDate(value);
	return d ? formatDistanceToNow(d, { addSuffix: true }) : null;
}

/**
 * Registry status → what the tile says. The registry stores "ERROR" when the
 * health probe fails; to the reader that is an agent it cannot reach, so the
 * word is "Unreachable" and the probe's reason rides along as the detail.
 */
export function registryStatus(agent: {
	status: string;
	lastHealthError?: string | null;
	lastHealthCheck?: Date | string | null;
}): AgentTileStatus {
	const checked = ago(agent.lastHealthCheck);
	switch (agent.status) {
		case "ACTIVE":
			return {
				label: "Active",
				tone: "good",
				detail: checked ? `Healthy, checked ${checked}` : null,
			};
		case "DEPLOYING":
			return { label: "Deploying", tone: "busy" };
		case "MAINTENANCE":
			return { label: "Maintenance", tone: "warn" };
		case "STALE":
			return {
				label: "Stale",
				tone: "warn",
				detail: checked ? `Last seen ${checked}` : null,
			};
		case "ERROR":
			return {
				label: "Unreachable",
				tone: "bad",
				detail:
					[
						agent.lastHealthError,
						checked ? `Checked ${checked}` : null,
					]
						.filter(Boolean)
						.join(" · ") || "The last health check failed.",
			};
		default:
			return { label: "Inactive", tone: "muted" };
	}
}

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
	const chips = [
		...selectionSummary.skillDetails.map((skill) => skill.name),
		...selectionSummary.capabilityIds.map(
			(capabilityId) =>
				getBuiltInCapability(capabilityId)?.name ?? capabilityId,
		),
	];

	const status = registryStatus(agent);
	// Localised copy for the failure detail where a translation exists.
	if (agent.status === "ERROR" && agent.lastHealthError) {
		status.detail = t("healthError", { error: agent.lastHealthError });
	}

	const runCount = agent.conversationCount ?? 0;
	const internalHref =
		typeof agent.href === "string" && agent.href.startsWith("/")
			? agent.href
			: null;
	const detailHref = internalHref ?? `${baseAgentsPath}/${agent.id}`;
	const editHref = `${baseAgentsPath}/${agent.id}/edit`;

	const hasActions = Boolean(
		onHealthCheck || onEdit || onDelete || onViewInsights,
	);

	return (
		<AgentTile
			name={agent.displayName}
			description={agent.description}
			emoji={agent.heroEmojis?.[0]}
			status={status}
			// Who this agent belongs to and what it is for. The framework
			// it runs on is an implementation detail and lives on the
			// detail page, not the tile.
			meta={[kindLabel(agent.scope), agent.category]}
			footer={[
				runCount === 0
					? "No runs yet"
					: `${runCount} ${runCount === 1 ? "run" : "runs"}`,
				ago(agent.updatedAt),
			]}
			chips={chips}
			ariaLabel={`Open ${agent.displayName}`}
			onOpen={() => router.push(detailHref)}
			actions={
				hasActions ? (
					<TooltipProvider>
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
					</TooltipProvider>
				) : null
			}
		/>
	);
}
