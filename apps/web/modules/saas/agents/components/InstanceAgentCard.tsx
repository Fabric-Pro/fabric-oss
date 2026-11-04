"use client";

import {
	buildAgentDetailsHref,
	buildAgentInstanceChatHref,
} from "@saas/agents/lib/fabric-agent-links";
import { useFeatureFlag } from "@saas/shared/components/FeatureFlagProvider";
import { Button } from "@ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { formatDistanceToNow } from "date-fns";
import {
	CopyIcon,
	EditIcon,
	MoreVerticalIcon,
	PlayIcon,
	TrashIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AgentTile, type AgentTileStatus, kindLabel } from "./AgentTile";

interface InstanceAgentCardProps {
	instance: {
		id: string;
		name: string;
		description?: string | null;
		status: string;
		runCount?: number | null;
		lastRunAt?: Date | string | null;
		updatedAt?: Date | string | null;
		heroEmojis?: string[] | null;
		scope?: string | null;
		template?: {
			displayName?: string | null;
			category?: string | null;
		} | null;
	};
	basePath: string;
	onDelete: (id: string) => void;
	directoryQuery?: string;
}

const STATUS: Record<string, AgentTileStatus> = {
	ACTIVE: { label: "Active", tone: "good" },
	DRAFT: { label: "Draft", tone: "muted" },
	PENDING: { label: "Setting up", tone: "busy" },
	ARCHIVED: { label: "Archived", tone: "muted" },
};

function ago(value: Date | string | null | undefined): string | null {
	if (!value) {
		return null;
	}
	const d = typeof value === "string" ? new Date(value) : value;
	return Number.isNaN(d.getTime())
		? null
		: formatDistanceToNow(d, { addSuffix: true });
}

export function InstanceAgentCard({
	instance,
	basePath,
	onDelete,
	directoryQuery,
}: InstanceAgentCardProps) {
	const router = useRouter();
	const status = STATUS[instance.status] ?? STATUS.DRAFT;
	const editHref = `${basePath}/agents/${instance.id}/edit`;
	const detailHref = buildAgentDetailsHref({
		basePath,
		instanceId: instance.id,
		directoryQuery,
	});
	const unifiedAgentInterface = useFeatureFlag("UNIFIED_AGENT_INTERFACE");
	const chatbotHref = buildAgentInstanceChatHref({
		basePath,
		instance,
		unifiedAgentInterface,
	});
	const category = instance.template?.category
		? instance.template.category.toLowerCase().replace(/_/g, " ")
		: null;

	return (
		<AgentTile
			name={instance.name}
			description={instance.description}
			emoji={instance.heroEmojis?.[0]}
			status={status}
			meta={[
				kindLabel(instance.scope ?? "PERSONAL"),
				instance.template?.displayName,
				category,
			]}
			footer={[
				"Run & results",
				instance.updatedAt
					? `updated ${ago(instance.updatedAt)}`
					: null,
			]}
			ariaLabel={`Open ${instance.name}`}
			onOpen={() => router.push(detailHref)}
			menu={
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							variant="ghost"
							size="icon-sm"
							className="h-6 w-6 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
							aria-label={`Actions for ${instance.name}`}
						>
							<MoreVerticalIcon className="h-3.5 w-3.5" />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						<DropdownMenuItem asChild>
							<Link
								href={buildAgentDetailsHref({
									basePath,
									instanceId: instance.id,
									directoryQuery,
									view: "runs",
								})}
							>
								<PlayIcon className="mr-2 h-4 w-4" />
								Run & results
							</Link>
						</DropdownMenuItem>
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
			}
		/>
	);
}
