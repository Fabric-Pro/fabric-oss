"use client";

/**
 * Report Template Card
 * Modern card design matching Agent Templates style
 */

import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
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
	AlertCircleIcon,
	ArrowRightIcon,
	BarChart3Icon,
	BrainCircuitIcon,
	BriefcaseIcon,
	CalendarClockIcon,
	CheckCircle2Icon,
	CodeIcon,
	EditIcon,
	FileOutputIcon,
	FileTextIcon,
	MessageSquareIcon,
	MoreVerticalIcon,
	ServerIcon,
	TrashIcon,
	VideoIcon,
} from "lucide-react";
import Link from "next/link";

type Integration = {
	name: string;
	mcpServerKey: string | null;
	description: string;
	configUrl: string;
};

type ReportTemplate = {
	id: string;
	name: string;
	description: string | null;
	heroEmojis?: string[];
	templateType: string;
	category?: string;
	tags?: string[];
	outputFormat: string;
	scope: string;
	lastUsedAt: string | null;
	createdAt: string;
	schedule?: { frequency: string } | null;
	definition?: {
		requiredIntegrations?: Integration[];
		aiAgents?: { agentId: string; task: string }[];
		connections?: {
			mcpServers?: unknown[];
			workflows?: unknown[];
			agents?: unknown[];
		};
	};
	_count: {
		executions: number;
	};
};

type Props = {
	template: ReportTemplate;
	onCreateInstance?: (template: ReportTemplate) => void;
	onDelete?: (id: string) => void;
	basePath?: string;
	configuredIntegrations?: string[];
};

// Category-based gradient colors for card icons
const categoryColors: Record<string, string> = {
	"Video & Audio": "from-red-500 to-pink-500",
	"Content Analysis": "from-purple-500 to-indigo-500",
	Development: "from-green-500 to-emerald-500",
	Communication: "from-blue-500 to-cyan-500",
	Business: "from-amber-500 to-orange-500",
	Other: "from-slate-500 to-slate-600",
};

// Category-based icons
const categoryIcons: Record<string, React.ElementType> = {
	"Video & Audio": VideoIcon,
	"Content Analysis": BarChart3Icon,
	Development: CodeIcon,
	Communication: MessageSquareIcon,
	Business: BriefcaseIcon,
	Other: FileTextIcon,
};

// Solid background colors for category dot indicators
const categoryDotColors: Record<string, string> = {
	"Video & Audio": "bg-red-500",
	"Content Analysis": "bg-purple-500",
	Development: "bg-green-500",
	Communication: "bg-blue-500",
	Business: "bg-amber-500",
	Other: "bg-slate-500",
};

export function ReportTemplateCard({
	template,
	onCreateInstance,
	onDelete,
	basePath = "/app/report-templates",
	configuredIntegrations = [],
}: Props) {
	const requiredIntegrations =
		template.definition?.requiredIntegrations || [];
	const integrationStatus = requiredIntegrations.map((integration) => ({
		...integration,
		isConfigured: integration.mcpServerKey
			? configuredIntegrations.includes(integration.mcpServerKey)
			: true,
	}));
	const _allConfigured = integrationStatus.every((i) => i.isConfigured);

	// Get category-based styling
	const category = template.category || "Other";
	const CategoryIcon = categoryIcons[category] || FileTextIcon;
	const categoryGradient = categoryColors[category] || categoryColors.Other;
	const categoryDot = categoryDotColors[category] || categoryDotColors.Other;

	// Compute capabilities
	const hasAiAgents = (template.definition?.aiAgents?.length ?? 0) > 0;
	const hasSchedule = !!template.schedule;
	const hasDataSources =
		(template.definition?.connections?.mcpServers?.length ?? 0) > 0 ||
		(template.definition?.connections?.workflows?.length ?? 0) > 0 ||
		(template.definition?.connections?.agents?.length ?? 0) > 0;

	// Output format labels
	const formatLabels: Record<string, string> = {
		MARKDOWN: "MD",
		HTML: "HTML",
		PDF: "PDF",
		EVIDENCE_EMBED: "Dashboard",
		MULTI_FORMAT: "Multi",
	};

	return (
		<div
			className="group relative flex flex-col h-full p-5 rounded-2xl border bg-card hover:border-primary/50 hover:shadow-lg transition-all duration-300"
			data-onboarding-target="reports-template-card"
		>
			{/* Header with icon and title */}
			<div className="flex items-start gap-4">
				{/* Modern category-based avatar */}
				<div
					className={cn(
						"w-14 h-14 rounded-2xl bg-gradient-to-br flex items-center justify-center shadow-lg flex-shrink-0",
						categoryGradient,
					)}
				>
					<CategoryIcon className="h-7 w-7 text-white" />
				</div>

				<div className="flex-1 min-w-0">
					<div className="flex items-start justify-between gap-2">
						<Link
							href={`${basePath}/${template.id}`}
							className="font-semibold text-lg hover:text-primary transition-colors line-clamp-1"
						>
							{template.name}
						</Link>
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button
									variant="ghost"
									size="icon"
									className="h-7 w-7 opacity-0 group-hover:opacity-100 -mt-1 -mr-1"
								>
									<MoreVerticalIcon className="h-4 w-4" />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuItem asChild>
									<Link href={`${basePath}/${template.id}`}>
										<EditIcon className="mr-2 h-4 w-4" />
										View Details
									</Link>
								</DropdownMenuItem>
								{template.scope !== "SYSTEM" && (
									<>
										<DropdownMenuSeparator />
										<DropdownMenuItem
											onClick={() =>
												onDelete?.(template.id)
											}
											className="text-destructive"
										>
											<TrashIcon className="mr-2 h-4 w-4" />
											Delete
										</DropdownMenuItem>
									</>
								)}
							</DropdownMenuContent>
						</DropdownMenu>
					</div>

					{/* Category indicator */}
					<div className="flex items-center gap-2 mt-1.5">
						<div
							className={cn("w-2 h-2 rounded-full", categoryDot)}
						/>
						<span className="text-xs text-muted-foreground font-medium">
							{category}
						</span>
					</div>
				</div>
			</div>

			{/* Description */}
			{template.description && (
				<p className="text-sm text-muted-foreground line-clamp-2 mt-4 flex-1">
					{template.description}
				</p>
			)}

			{/* Capability badges */}
			<div className="flex flex-wrap gap-1.5 mt-4">
				<TooltipProvider>
					{hasAiAgents && (
						<Tooltip>
							<TooltipTrigger asChild>
								<Badge
									variant="secondary"
									className="text-xs bg-purple-50 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400 border-0"
								>
									<BrainCircuitIcon className="w-3 h-3 mr-1" />
									AI
								</Badge>
							</TooltipTrigger>
							<TooltipContent>
								Uses AI agents for analysis
							</TooltipContent>
						</Tooltip>
					)}
					{hasSchedule && (
						<Tooltip>
							<TooltipTrigger asChild>
								<Badge
									variant="secondary"
									className="text-xs bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 border-0"
								>
									<CalendarClockIcon className="w-3 h-3 mr-1" />
									Scheduled
								</Badge>
							</TooltipTrigger>
							<TooltipContent>Runs on a schedule</TooltipContent>
						</Tooltip>
					)}
					{hasDataSources && (
						<Tooltip>
							<TooltipTrigger asChild>
								<Badge
									variant="secondary"
									className="text-xs bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-400 border-0"
								>
									<ServerIcon className="w-3 h-3 mr-1" />
									Data Sources
								</Badge>
							</TooltipTrigger>
							<TooltipContent>
								Uses external data sources
							</TooltipContent>
						</Tooltip>
					)}
					<Badge
						variant="outline"
						className="text-xs px-2 py-0 font-normal"
					>
						<FileOutputIcon className="w-3 h-3 mr-1" />
						{formatLabels[template.outputFormat] ||
							template.outputFormat}
					</Badge>
				</TooltipProvider>
			</div>

			{/* Integration badges */}
			{integrationStatus.length > 0 && (
				<div className="flex flex-wrap gap-1.5 mt-3">
					<TooltipProvider>
						{integrationStatus.slice(0, 3).map((integration) => (
							<Tooltip key={integration.name}>
								<TooltipTrigger asChild>
									<Badge
										variant="outline"
										className={cn(
											"text-xs",
											integration.isConfigured
												? "border-green-200 text-green-700 dark:border-green-800 dark:text-green-400"
												: "border-amber-200 text-amber-700 dark:border-amber-800 dark:text-amber-400",
										)}
									>
										{integration.isConfigured ? (
											<CheckCircle2Icon className="w-3 h-3 mr-1" />
										) : (
											<AlertCircleIcon className="w-3 h-3 mr-1" />
										)}
										{integration.name}
									</Badge>
								</TooltipTrigger>
								<TooltipContent>
									<p>{integration.description}</p>
									{!integration.isConfigured && (
										<p className="text-highlight text-xs mt-1">
											Needs configuration
										</p>
									)}
								</TooltipContent>
							</Tooltip>
						))}
						{integrationStatus.length > 3 && (
							<span className="text-xs text-muted-foreground">
								+{integrationStatus.length - 3}
							</span>
						)}
					</TooltipProvider>
				</div>
			)}

			{/* Footer */}
			<div className="flex items-center justify-between mt-5 pt-4 border-t">
				<span className="text-xs text-muted-foreground">
					{template._count.executions > 0
						? `${template._count.executions} runs`
						: template.lastUsedAt
							? `Last ${formatDistanceToNow(new Date(template.lastUsedAt), { addSuffix: true })}`
							: "New"}
				</span>
				<Button
					size="sm"
					onClick={() => onCreateInstance?.(template)}
					className="bg-emerald-500 hover:bg-emerald-600 text-white gap-1.5 shadow-sm"
				>
					Use Template
					<ArrowRightIcon className="w-3.5 h-3.5" />
				</Button>
			</div>
		</div>
	);
}
