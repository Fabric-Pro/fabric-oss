"use client";

import { Button } from "@ui/components/button";
import { cn } from "@ui/lib";
import { Handle, Position } from "@xyflow/react";
import {
	CircleDotIcon,
	CompassIcon,
	FileTextIcon,
	GitBranchIcon,
	GlobeIcon,
	ImageIcon,
	MailIcon,
	MessageSquareIcon,
	PlayIcon,
	SearchIcon,
	SendIcon,
	SparklesIcon,
	TicketPlusIcon,
	TrashIcon,
	VideoIcon,
	WrenchIcon,
} from "lucide-react";
import { getIntegrationByNodeType } from "../../lib/plugins/registry";
import type { WorkflowNodeType } from "../../lib/types";

// Icon mapping for node types
const nodeIcons: Record<
	WorkflowNodeType,
	React.ComponentType<{ className?: string }>
> = {
	trigger: PlayIcon,
	"ai-generate-text": SparklesIcon,
	"ai-generate-image": ImageIcon,
	"http-request": SendIcon,
	condition: GitBranchIcon,
	"firecrawl-scrape": GlobeIcon,
	"firecrawl-search": SearchIcon,
	"linear-create-ticket": TicketPlusIcon,
	"linear-find-issues": SearchIcon,
	"email-send": MailIcon,
	"slack-send": MessageSquareIcon,
	"mcp-tool": WrenchIcon,
	// GitHub nodes
	"github-create-issue": CircleDotIcon,
	"github-search-issues": SearchIcon,
	"github-get-file": FileTextIcon,
	// Perplexity nodes
	"perplexity-search": CompassIcon,
	// fal.ai nodes
	"fal-generate-image": ImageIcon,
	"fal-generate-video": VideoIcon,
};

// Color mapping for node categories
const nodeColors: Record<string, string> = {
	trigger: "border-blue-500 bg-blue-50 dark:bg-blue-950",
	ai: "border-purple-500 bg-purple-50 dark:bg-purple-950",
	web: "border-green-500 bg-green-50 dark:bg-green-950",
	logic: "border-orange-500 bg-orange-50 dark:bg-orange-950",
	integrations: "border-cyan-500 bg-cyan-50 dark:bg-cyan-950",
	notifications: "border-pink-500 bg-pink-50 dark:bg-pink-950",
};

// Get category from node type
function getCategory(type: WorkflowNodeType): string {
	if (type === "trigger") {
		return "trigger";
	}
	if (type.startsWith("ai-")) {
		return "ai";
	}
	if (type.startsWith("firecrawl-")) {
		return "web";
	}
	if (type === "condition") {
		return "logic";
	}
	if (type.startsWith("email-") || type.startsWith("slack-")) {
		return "notifications";
	}
	return "integrations";
}

// Props type for the workflow node component
interface WorkflowNodeComponentProps {
	data: {
		label?: string;
		description?: string;
		isConfigured?: boolean;
		onDelete?: () => void;
	};
	type?: string;
	selected?: boolean;
	id?: string;
}

export function WorkflowNodeComponent({
	data,
	type,
	selected,
}: WorkflowNodeComponentProps) {
	const nodeType = (type || "trigger") as WorkflowNodeType;
	// Prefer the integration's own brand icon. `nodeIcons` only covers the
	// node types that predate the plugin registry; without this every
	// plugin-backed node on the canvas would render the same wrench.
	const pluginIcon = getIntegrationByNodeType(nodeType)?.icon;
	const Icon = pluginIcon ?? nodeIcons[nodeType] ?? WrenchIcon;
	const category = getCategory(nodeType);
	const colorClass = nodeColors[category] || nodeColors.integrations;
	const nodeData = data || { label: "Node" };

	return (
		<div
			className="relative group"
			data-testid={`workflow-node-${nodeType}`}
		>
			<div
				className={cn(
					"px-4 py-4 rounded-lg border-2 shadow-sm min-w-[120px] transition-all",
					colorClass,
					selected && "ring-2 ring-primary ring-offset-2",
				)}
			>
				{/* Input Handle - Left side */}
				{nodeType !== "trigger" && (
					<Handle
						type="target"
						position={Position.Left}
						className="w-2! h-2! bg-muted-foreground! border-2! border-background!"
					/>
				)}

				{/* Node Content */}
				<div className="flex flex-col items-center gap-2 text-center">
					<div className="p-2 rounded-md bg-background/50">
						<Icon className="h-5 w-5" />
					</div>
					<div>
						<div className="font-medium text-sm">
							{nodeData.label || "Untitled"}
						</div>
						{nodeData.description && (
							<div className="text-xs text-muted-foreground">
								{nodeData.description}
							</div>
						)}
					</div>
				</div>

				{/* Output Handle - Right side */}
				{nodeType === "condition" ? (
					<>
						<Handle
							type="source"
							position={Position.Right}
							id="true"
							className="w-2! h-2! bg-green-500! border-2! border-background! top-1/3!"
						/>
						<Handle
							type="source"
							position={Position.Right}
							id="false"
							className="w-2! h-2! bg-red-500! border-2! border-background! top-2/3!"
						/>
					</>
				) : (
					<Handle
						type="source"
						position={Position.Right}
						className="w-2! h-2! bg-muted-foreground! border-2! border-background!"
					/>
				)}
			</div>

			{/* Delete Button - Shows on hover */}
			{selected && nodeData.onDelete && (
				<Button
					variant="destructive"
					size="icon"
					className="absolute -top-2 -right-2 h-6 w-6 rounded-full shadow-lg opacity-0 group-hover:opacity-100 transition-opacity"
					onClick={(e) => {
						e.stopPropagation();
						nodeData.onDelete?.();
					}}
				>
					<TrashIcon className="h-3 w-3" />
				</Button>
			)}
		</div>
	);
}
