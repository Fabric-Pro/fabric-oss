"use client";

import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { cn } from "@ui/lib";
import {
	ArrowUpDownIcon,
	CalendarIcon,
	ChevronDownIcon,
	ChevronUpIcon,
	Columns3Icon,
	CopyIcon,
	DatabaseIcon,
	DownloadIcon,
	EyeIcon,
	FileSpreadsheetIcon,
	FilterIcon,
	FolderOpenIcon,
	GitMergeIcon,
	HelpCircleIcon,
	HistoryIcon,
	LayersIcon,
	LayoutGridIcon,
	ListFilterIcon,
	Maximize2Icon,
	MoreVerticalIcon,
	PencilIcon,
	PlayIcon,
	PlusIcon,
	Redo2Icon,
	SearchIcon,
	Share2Icon,
	ShieldCheckIcon,
	SlidersHorizontalIcon,
	SparklesIcon,
	SplitIcon,
	StarIcon,
	TableIcon,
	Trash2Icon,
	Undo2Icon,
	WrenchIcon,
	XIcon,
	ZoomInIcon,
	ZoomOutIcon,
} from "lucide-react";
import Link from "next/link";
import { type ComponentType, useMemo, useState } from "react";

export interface VisualOperatorDefinition {
	id: string;
	name: string;
	description: string;
	category: "Input and output" | "Clean" | "Combine" | "Transform";
	badgeBg: string;
	icon: ComponentType<{ className?: string }>;
	defaultStepName: string;
}

export const VISUAL_OPERATORS: VisualOperatorDefinition[] = [
	{
		id: "source",
		name: "Source",
		description: "Import data into Designer",
		category: "Input and output",
		badgeBg: "bg-[#4F46E5] text-white",
		icon: TableIcon,
		defaultStepName: "source_0",
	},
	{
		id: "enter_data",
		name: "Enter Data",
		description: "Manually enter table data",
		category: "Input and output",
		badgeBg: "bg-[#4F46E5] text-white",
		icon: FileSpreadsheetIcon,
		defaultStepName: "enter_data_0",
	},
	{
		id: "output",
		name: "Output",
		description: "Export data out of Designer",
		category: "Input and output",
		badgeBg: "bg-[#4F46E5] text-white",
		icon: DownloadIcon,
		defaultStepName: "output_0",
	},
	{
		id: "filter",
		name: "Filter",
		description: "Select matching rows",
		category: "Clean",
		badgeBg: "bg-[#0D9488] text-white",
		icon: FilterIcon,
		defaultStepName: "filter_1",
	},
	{
		id: "guardrails",
		name: "Guardrails",
		description: "Validate data and stop on failure",
		category: "Clean",
		badgeBg: "bg-[#0D9488] text-white",
		icon: ShieldCheckIcon,
		defaultStepName: "guardrails_1",
	},
	{
		id: "limit",
		name: "Limit",
		description: "Restrict row count",
		category: "Clean",
		badgeBg: "bg-[#0D9488] text-white",
		icon: ListFilterIcon,
		defaultStepName: "limit_1",
	},
	{
		id: "prepare",
		name: "Prepare",
		description: "Cleanse and prepare columns",
		category: "Clean",
		badgeBg: "bg-[#0D9488] text-white",
		icon: WrenchIcon,
		defaultStepName: "prepare_1",
	},
	{
		id: "select",
		name: "Select",
		description: "Pick, rename, and reorder columns",
		category: "Clean",
		badgeBg: "bg-[#0D9488] text-white",
		icon: Columns3Icon,
		defaultStepName: "select_1",
	},
	{
		id: "sort",
		name: "Sort",
		description: "Order rows on a column",
		category: "Clean",
		badgeBg: "bg-[#0D9488] text-white",
		icon: ArrowUpDownIcon,
		defaultStepName: "sort_1",
	},
	{
		id: "unique",
		name: "Unique",
		description: "Remove duplicate rows",
		category: "Clean",
		badgeBg: "bg-[#0D9488] text-white",
		icon: SplitIcon,
		defaultStepName: "unique_1",
	},
	{
		id: "combine",
		name: "Combine",
		description: "Merge data from two or more tables",
		category: "Combine",
		badgeBg: "bg-[#0284C7] text-white",
		icon: LayersIcon,
		defaultStepName: "combine_1",
	},
	{
		id: "join",
		name: "Join",
		description: "Link two tables on a key",
		category: "Combine",
		badgeBg: "bg-[#0284C7] text-white",
		icon: GitMergeIcon,
		defaultStepName: "join_1",
	},
	{
		id: "ai_function",
		name: "AI Function",
		description: "Analyze data with AI",
		category: "Transform",
		badgeBg: "bg-[#8B5CF6] text-white",
		icon: SparklesIcon,
		defaultStepName: "aifunction_1",
	},
	{
		id: "aggregate",
		name: "Aggregate",
		description: "Summarize rows",
		category: "Transform",
		badgeBg: "bg-[#D97706] text-white",
		icon: DatabaseIcon,
		defaultStepName: "aggregate_1",
	},
	{
		id: "pivot",
		name: "Pivot",
		description: "Reshape rows into columns",
		category: "Transform",
		badgeBg: "bg-[#D97706] text-white",
		icon: LayoutGridIcon,
		defaultStepName: "pivot_1",
	},
];

const GETTING_STARTED_STEPS = [
	{
		title: "Add operators",
		description:
			"Drag operators onto the canvas or click the + icon on a node to add a connected operator.",
	},
	{
		title: "Configure & preview live rows",
		description:
			"Select any operator node on the canvas to inspect its schema, filter conditions, and first 1,000 rows in real time.",
	},
	{
		title: "Transform with AI Functions",
		description:
			"Add an AI Function operator to classify, summarize, extract entities, or run Genie Agents over your dataset.",
	},
	{
		title: "Connect to external sources",
		description:
			"Pull live data from Google Drive, SharePoint, GitHub, Slack, Jira, or Unity Catalog & Lakebase tables.",
	},
	{
		title: "Run & schedule pipelines",
		description:
			"Click Run all to execute the pipeline immediately or attach a cron schedule for automated execution.",
	},
];

interface CanvasNodeItem {
	id: string;
	operatorId: string;
	name: string;
	subtitle: string;
}

interface VisualDataPrepStudioProps {
	connectionsHref: string;
	onCreateWorkflow?: () => void;
	onOpenWorkflow?: (workflowId: string) => void;
	workflows?: Array<{
		id: string;
		name: string;
		status: string;
		triggerType: string;
	}>;
}

export function VisualDataPrepStudio({
	connectionsHref,
	onCreateWorkflow,
	onOpenWorkflow,
	workflows = [],
}: VisualDataPrepStudioProps) {
	const [operatorSearch, setOperatorSearch] = useState("");
	const [popoverSearch, setPopoverSearch] = useState("");
	const [popoverTab, setPopoverTab] = useState<"add" | "connect">("add");
	const [openPopoverNodeId, setOpenPopoverNodeId] = useState<string | null>(
		"node-enter-data",
	);
	const [selectedNodeId, setSelectedNodeId] =
		useState<string>("node-enter-data");
	const [showOperatorsPanel, setShowOperatorsPanel] = useState(true);
	const [showPreviewDrawer, setShowPreviewDrawer] = useState(false);
	const [showGettingStarted, setShowGettingStarted] = useState(false);
	const [gettingStartedStep, setGettingStartedStep] = useState(0);
	const [collapsedCategories, setCollapsedCategories] = useState<
		Record<string, boolean>
	>({});

	const [canvasNodes, setCanvasNodes] = useState<CanvasNodeItem[]>([
		{
			id: "node-enter-data",
			operatorId: "enter_data",
			name: "enter_data_0",
			subtitle: "Manually enter table data",
		},
	]);

	const filterOperators = (search: string) => {
		const q = search.trim().toLowerCase();
		const filtered = q
			? VISUAL_OPERATORS.filter(
					(op) =>
						op.name.toLowerCase().includes(q) ||
						op.description.toLowerCase().includes(q) ||
						op.category.toLowerCase().includes(q),
				)
			: VISUAL_OPERATORS;

		const categories: Array<VisualOperatorDefinition["category"]> = [
			"Input and output",
			"Clean",
			"Combine",
			"Transform",
		];

		return categories
			.map((category) => ({
				category,
				items: filtered.filter((item) => item.category === category),
			}))
			.filter((group) => group.items.length > 0);
	};

	const sidebarGroups = useMemo(
		() => filterOperators(operatorSearch),
		[operatorSearch],
	);
	const popoverGroups = useMemo(
		() => filterOperators(popoverSearch),
		[popoverSearch],
	);

	const handleAddOperatorNode = (op: VisualOperatorDefinition) => {
		const index = canvasNodes.length;
		const newId = `node-${op.id}-${Date.now()}`;
		const stepName = `${op.id}_${index}`;
		setCanvasNodes((prev) => [
			...prev,
			{
				id: newId,
				operatorId: op.id,
				name: stepName,
				subtitle: op.description,
			},
		]);
		setSelectedNodeId(newId);
		setOpenPopoverNodeId(null);
	};

	const handleDeleteCanvasNode = (id: string) => {
		setCanvasNodes((prev) =>
			prev.length > 1 ? prev.filter((n) => n.id !== id) : prev,
		);
		if (openPopoverNodeId === id) {
			setOpenPopoverNodeId(null);
		}
	};

	const handleDuplicateCanvasNode = (node: CanvasNodeItem) => {
		const newId = `${node.id}-copy-${Date.now()}`;
		setCanvasNodes((prev) => [
			...prev,
			{
				...node,
				id: newId,
				name: `${node.name}_copy`,
			},
		]);
		setSelectedNodeId(newId);
	};

	const toggleCategory = (cat: string) => {
		setCollapsedCategories((prev) => ({
			...prev,
			[cat]: !prev[cat],
		}));
	};

	return (
		<div className="relative flex flex-col overflow-hidden rounded-xl border border-border bg-background shadow-xs">
			{/* Top Databricks Visual Data Prep Studio Tab Bar */}
			<div className="flex h-10 items-center justify-between border-b border-border bg-muted/35 px-2.5">
				<div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto no-scrollbar">
					<div className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold text-foreground">
						<TableIcon className="size-3.5 text-[#0284C7]" />
						<span>Visual Workflow Studio</span>
						<ChevronDownIcon className="size-3 text-muted-foreground" />
					</div>

					<div className="h-4 w-px bg-border mx-1" />

					{/* Active Visual Data Prep Tab */}
					<div className="flex h-8 items-center gap-2 rounded-t-md border border-b-0 border-border bg-background px-3 text-xs font-medium text-foreground shadow-2xs">
						<GitMergeIcon className="size-3.5 text-[#0284C7]" />
						<span className="truncate max-w-[200px]">
							Visual data prep{" "}
							{new Date().toISOString().slice(0, 10)}
						</span>
						<span className="ml-1 rounded px-1 py-0.5 text-[10px] text-muted-foreground hover:bg-muted">
							×
						</span>
					</div>

					{/* Secondary studio query tab (Databricks Visual Data Prep style) */}
					<button
						type="button"
						onClick={() => {
							if (workflows[0]) {
								onOpenWorkflow?.(workflows[0].id);
							} else {
								onCreateWorkflow?.();
							}
						}}
						className="flex h-8 items-center gap-1.5 rounded-t-md px-3 text-xs text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground"
					>
						<FileSpreadsheetIcon className="size-3.5 shrink-0" />
						<span className="truncate max-w-[160px]">
							New Query {new Date().toISOString().slice(0, 10)}
						</span>
					</button>

					<button
						type="button"
						onClick={onCreateWorkflow}
						title="Create new workflow"
						aria-label="Create new workflow tab"
						className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
					>
						<PlusIcon className="size-3.5" />
					</button>
				</div>

				{/* Right Studio Action Buttons */}
				<div className="flex shrink-0 items-center gap-1.5 pl-2">
					<button
						type="button"
						onClick={() => setShowGettingStarted(true)}
						className="hidden sm:inline-flex h-7 items-center gap-1 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
					>
						<HelpCircleIcon className="size-3.5 text-[#0284C7]" />
						Getting started
					</button>
					<button
						type="button"
						aria-label="More options"
						className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
					>
						<MoreVerticalIcon className="size-3.5" />
					</button>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={onCreateWorkflow}
						className="h-7 gap-1.5 rounded-md px-2.5 text-xs font-medium"
					>
						<PlayIcon className="size-3 fill-current" />
						Run all
					</Button>
					<span
						title="Cluster / Engine Ready"
						className="flex size-7 items-center justify-center rounded-md border border-border bg-background"
					>
						<span className="size-2.5 rounded-full border-2 border-[#16A34A]" />
					</span>
					<button
						type="button"
						title="Schedule workflow"
						aria-label="Schedule workflow"
						onClick={onCreateWorkflow}
						className="flex size-7 items-center justify-center rounded-md border border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground"
					>
						<CalendarIcon className="size-3.5" />
					</button>
					<button
						type="button"
						title="Export / Share workflow"
						aria-label="Export or share workflow"
						onClick={onCreateWorkflow}
						className="flex size-7 items-center justify-center rounded-md bg-[#1B6EC2] text-white hover:bg-[#155a9e]"
					>
						<Share2Icon className="size-3.5" />
					</button>
				</div>
			</div>

			{/* Main Studio Workspace Area */}
			<div className="relative flex h-[540px] min-h-[480px] w-full overflow-hidden">
				{/* Far-left Mini Icon Rail */}
				<div className="flex w-10 shrink-0 flex-col items-center gap-1.5 border-r border-border bg-muted/20 py-2.5">
					<button
						type="button"
						onClick={() => setShowOperatorsPanel((v) => !v)}
						title="Operators"
						aria-label="Toggle Operators panel"
						className={cn(
							"flex size-7 items-center justify-center rounded-md transition-colors",
							showOperatorsPanel
								? "bg-[#E0F2FE] text-[#0284C7] dark:bg-[#0284C7]/25 dark:text-[#38BDF8]"
								: "text-muted-foreground hover:bg-muted hover:text-foreground",
						)}
					>
						<PlusIcon className="size-4" />
					</button>
					<button
						type="button"
						onClick={() => setShowPreviewDrawer((v) => !v)}
						title="Schema & Preview"
						aria-label="Toggle Schema and Preview"
						className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
					>
						<TableIcon className="size-4" />
					</button>
					<button
						type="button"
						onClick={onCreateWorkflow}
						title="Workspace files"
						aria-label="Workspace files"
						className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
					>
						<FolderOpenIcon className="size-4" />
					</button>
					<button
						type="button"
						onClick={onCreateWorkflow}
						title="Catalog & Lakebase"
						aria-label="Catalog and Lakebase"
						className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
					>
						<DatabaseIcon className="size-4" />
					</button>
					<button
						type="button"
						onClick={() => setShowOperatorsPanel(true)}
						title="Filter operators"
						aria-label="Filter operators"
						className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
					>
						<FilterIcon className="size-4" />
					</button>
				</div>

				{/* Left Docked Operators Panel (Databricks Visual Data Prep style) */}
				{showOperatorsPanel && (
					<div className="flex w-[248px] shrink-0 flex-col border-r border-border bg-background">
						<div className="flex h-9 items-center justify-between border-b border-border px-3">
							<span className="text-xs font-semibold text-foreground">
								Operators
							</span>
							<button
								type="button"
								onClick={() => setShowOperatorsPanel(false)}
								aria-label="Close Operators panel"
								className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
							>
								<XIcon className="size-3.5" />
							</button>
						</div>

						<div className="flex items-center gap-1.5 p-2.5">
							<div className="relative flex-1">
								<SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
								<Input
									type="search"
									value={operatorSearch}
									onChange={(e) =>
										setOperatorSearch(e.target.value)
									}
									placeholder="Search for an operator..."
									className="h-7 pl-8 text-xs"
								/>
							</div>
							<button
								type="button"
								onClick={() =>
									handleAddOperatorNode(VISUAL_OPERATORS[0])
								}
								title="Add operator to canvas"
								aria-label="Add operator to canvas"
								className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
							>
								<PlusIcon className="size-3.5" />
							</button>
						</div>

						<div className="flex-1 overflow-y-auto px-2 pb-3 space-y-3">
							{sidebarGroups.map((group) => {
								const isCollapsed =
									!!collapsedCategories[group.category];
								return (
									<div
										key={group.category}
										className="space-y-1"
									>
										<button
											type="button"
											onClick={() =>
												toggleCategory(group.category)
											}
											className="flex w-full items-center justify-between px-1.5 py-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
										>
											<span>{group.category}</span>
											<ChevronDownIcon
												className={cn(
													"size-3.5 transition-transform",
													isCollapsed && "-rotate-90",
												)}
											/>
										</button>
										{!isCollapsed && (
											<div className="space-y-0.5">
												{group.items.map((op) => {
													const Icon = op.icon;
													return (
														<button
															key={op.id}
															type="button"
															onClick={() =>
																handleAddOperatorNode(
																	op,
																)
															}
															className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/60"
														>
															<span
																className={cn(
																	"flex size-7 shrink-0 items-center justify-center rounded-[6px] shadow-2xs",
																	op.badgeBg,
																)}
															>
																<Icon className="size-3.5" />
															</span>
															<span className="min-w-0 flex-1">
																<span className="block truncate text-xs font-semibold text-foreground">
																	{op.name}
																</span>
																<span className="block truncate text-[11px] text-muted-foreground">
																	{
																		op.description
																	}
																</span>
															</span>
														</button>
													);
												})}
											</div>
										)}
									</div>
								);
							})}
						</div>
					</div>
				)}

				{/* Center Dotted Visual Canvas + Sub-toolbar */}
				<div className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
					{/* Canvas Sub-Toolbar */}
					<div className="flex h-9 shrink-0 items-center justify-between border-b border-border bg-background px-3 text-xs">
						<div className="flex items-center gap-1.5">
							<button
								type="button"
								onClick={() => setShowPreviewDrawer((v) => !v)}
								className="inline-flex items-center gap-1 rounded px-2 py-1 font-medium text-foreground hover:bg-muted"
							>
								<span>Preview: First 1000 rows</span>
								<ChevronDownIcon className="size-3.5 text-muted-foreground" />
							</button>
							<div className="h-4 w-px bg-border mx-1" />
							<button
								type="button"
								aria-label="Undo"
								className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
							>
								<Undo2Icon className="size-3.5" />
							</button>
							<button
								type="button"
								aria-label="Redo"
								className="rounded p-1 text-muted-foreground/50"
							>
								<Redo2Icon className="size-3.5" />
							</button>
							<div className="h-4 w-px bg-border mx-1" />
							<button
								type="button"
								aria-label="Fit view"
								className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
							>
								<Maximize2Icon className="size-3.5" />
							</button>
							<button
								type="button"
								aria-label="Zoom in"
								className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
							>
								<ZoomInIcon className="size-3.5" />
							</button>
							<button
								type="button"
								aria-label="Zoom out"
								className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
							>
								<ZoomOutIcon className="size-3.5" />
							</button>
							<button
								type="button"
								aria-label="Auto layout"
								className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
							>
								<GitMergeIcon className="size-3.5" />
							</button>
							<button
								type="button"
								aria-label="Favorite workflow"
								className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
							>
								<StarIcon className="size-3.5" />
							</button>
						</div>
					</div>

					{/* Dotted Canvas Body */}
					<div className="relative flex flex-1 items-center justify-center overflow-auto bg-[radial-gradient(#cbd5e1_1px,transparent_1px)] dark:bg-[radial-gradient(#334155_1px,transparent_1px)] [background-size:16px_16px] p-8">
						{/* Connected Operator Nodes Flow */}
						<div className="flex flex-wrap items-center gap-8">
							{canvasNodes.map((node, idx) => {
								const op =
									VISUAL_OPERATORS.find(
										(o) => o.id === node.operatorId,
									) ?? VISUAL_OPERATORS[1];
								const Icon = op.icon;
								const isSelected = selectedNodeId === node.id;
								const isPopoverOpen =
									openPopoverNodeId === node.id;

								return (
									<div
										key={node.id}
										className="relative flex items-center"
									>
										{idx > 0 && (
											<div className="mr-3 h-0.5 w-6 bg-[#0284C7]/60" />
										)}

										<div className="relative">
											{/* Floating Edit / Copy / Delete Pill Above Selected Node */}
											{isSelected && (
												<div className="absolute -top-9 left-1/2 -translate-x-1/2 flex items-center gap-0.5 rounded-md border border-border bg-background px-1.5 py-0.5 shadow-xs">
													<button
														type="button"
														onClick={
															onCreateWorkflow
														}
														title="Open full workflow editor"
														aria-label="Edit operator"
														className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
													>
														<PencilIcon className="size-3" />
													</button>
													<button
														type="button"
														onClick={() =>
															handleDuplicateCanvasNode(
																node,
															)
														}
														title="Duplicate operator"
														aria-label="Duplicate operator"
														className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
													>
														<CopyIcon className="size-3" />
													</button>
													<button
														type="button"
														onClick={() =>
															handleDeleteCanvasNode(
																node.id,
															)
														}
														title="Delete operator"
														aria-label="Delete operator"
														className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
													>
														<Trash2Icon className="size-3" />
													</button>
												</div>
											)}

											{/* Databricks Dashed Sky-Blue Operator Node */}
											<button
												type="button"
												onClick={() =>
													setSelectedNodeId(node.id)
												}
												className={cn(
													"flex w-[196px] flex-col items-start gap-1.5 rounded-[8px] border-2 border-dashed px-4 py-3.5 text-left transition-all",
													isSelected
														? "border-[#0284C7] bg-[#E0F2FE]/80 dark:bg-[#0284C7]/20 shadow-xs"
														: "border-[#0284C7]/50 bg-[#E0F2FE]/45 dark:bg-[#0284C7]/10 hover:border-[#0284C7]",
												)}
											>
												<div className="flex items-center gap-2">
													<Icon className="size-4 text-muted-foreground" />
													<span className="truncate text-xs font-semibold text-foreground">
														{node.name}
													</span>
												</div>
												<span className="line-clamp-1 text-[11px] text-muted-foreground">
													{node.subtitle}
												</span>
											</button>

											{/* Right-Edge "+" Anchor Button */}
											<button
												type="button"
												onClick={() =>
													setOpenPopoverNodeId(
														isPopoverOpen
															? null
															: node.id,
													)
												}
												aria-label={`Add connected operator after ${node.name}`}
												className="absolute -right-3 top-1/2 -translate-y-1/2 flex size-6 items-center justify-center rounded-[5px] border border-[#0284C7]/60 bg-background text-[#0284C7] shadow-xs transition-colors hover:bg-[#E0F2FE]"
											>
												<PlusIcon className="size-3.5" />
											</button>

											{/* Databricks Inline Operator Picker Popover (Image 6) */}
											{isPopoverOpen && (
												<div className="absolute left-[212px] top-1/2 z-30 -translate-y-1/2 flex h-[380px] w-[248px] flex-col rounded-lg border border-border bg-popover shadow-lg">
													{/* Add new | Connect to segmented control */}
													<div className="p-2 pb-1.5">
														<div className="grid grid-cols-2 rounded-md border border-border bg-muted/40 p-0.5 text-xs">
															<button
																type="button"
																onClick={() =>
																	setPopoverTab(
																		"add",
																	)
																}
																className={cn(
																	"rounded-[4px] py-1 font-medium transition-colors",
																	popoverTab ===
																		"add"
																		? "bg-background text-foreground shadow-2xs"
																		: "text-muted-foreground hover:text-foreground",
																)}
															>
																Add new
															</button>
															<button
																type="button"
																onClick={() =>
																	setPopoverTab(
																		"connect",
																	)
																}
																className={cn(
																	"rounded-[4px] py-1 font-medium transition-colors",
																	popoverTab ===
																		"connect"
																		? "bg-background text-foreground shadow-2xs"
																		: "text-muted-foreground hover:text-foreground",
																)}
															>
																Connect to
															</button>
														</div>
													</div>

													{/* Search input */}
													<div className="px-2 pb-2">
														<div className="relative">
															<SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
															<Input
																type="search"
																value={
																	popoverSearch
																}
																onChange={(e) =>
																	setPopoverSearch(
																		e.target
																			.value,
																	)
																}
																placeholder="Search for an operator..."
																className="h-7 pl-8 text-xs"
															/>
														</div>
													</div>

													{/* Scrollable operator list */}
													<div className="flex-1 overflow-y-auto px-1.5 pb-2 space-y-2">
														{popoverGroups.map(
															(group) => (
																<div
																	key={
																		group.category
																	}
																	className="space-y-0.5"
																>
																	<div className="flex items-center justify-between px-2 py-1 text-[11px] font-medium text-muted-foreground">
																		<span>
																			{
																				group.category
																			}
																		</span>
																		<ChevronDownIcon className="size-3" />
																	</div>
																	{group.items.map(
																		(
																			item,
																		) => {
																			const ItemIcon =
																				item.icon;
																			return (
																				<button
																					key={
																						item.id
																					}
																					type="button"
																					onClick={() =>
																						handleAddOperatorNode(
																							item,
																						)
																					}
																					className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-xs font-medium text-foreground transition-colors hover:bg-[#E0F2FE]/60 dark:hover:bg-[#0284C7]/20"
																				>
																					<span
																						className={cn(
																							"flex size-6 shrink-0 items-center justify-center rounded-[5px]",
																							item.badgeBg,
																						)}
																					>
																						<ItemIcon className="size-3.5" />
																					</span>
																					<span className="truncate">
																						{
																							item.name
																						}
																					</span>
																				</button>
																			);
																		},
																	)}
																</div>
															),
														)}
													</div>
												</div>
											)}
										</div>
									</div>
								);
							})}
						</div>

						{/* Right-side "Connect to external source" Card (Image 5) */}
						<div className="hidden xl:flex w-[228px] shrink-0 flex-col gap-2.5 rounded-xl border border-border/80 bg-muted/35 p-4 shadow-2xs ml-auto">
							<h3 className="text-center text-xs font-semibold text-foreground">
								Connect to external source
							</h3>
							<Link
								href={connectionsHref}
								className="flex items-center justify-center gap-2 rounded-lg border border-border bg-card px-3 py-2.5 text-xs font-medium text-foreground shadow-2xs transition-colors hover:border-foreground/25 hover:bg-muted/30"
							>
								<span className="size-2.5 rounded-full bg-[#16A34A]" />
								Google Drive
							</Link>
							<Link
								href={connectionsHref}
								className="flex items-center justify-center gap-2 rounded-lg border border-border bg-card px-3 py-2.5 text-xs font-medium text-foreground shadow-2xs transition-colors hover:border-foreground/25 hover:bg-muted/30"
							>
								<span className="flex size-4 items-center justify-center rounded bg-[#038387] text-[10px] font-bold text-white">
									S
								</span>
								Microsoft SharePoint
							</Link>
							<div className="flex flex-wrap items-center justify-center gap-1.5 pt-1">
								{[
									{ label: "SQL", bg: "bg-[#0284C7]" },
									{ label: "DBX", bg: "bg-[#FF3621]" },
									{ label: "PG", bg: "bg-[#336791]" },
									{ label: "GH", bg: "bg-[#24292F]" },
									{ label: "SLK", bg: "bg-[#4A154B]" },
									{ label: "SNOW", bg: "bg-[#29B5E8]" },
								].map((badge) => (
									<span
										key={badge.label}
										className={cn(
											"flex h-5 items-center justify-center rounded px-1.5 text-[9px] font-bold text-white",
											badge.bg,
										)}
									>
										{badge.label}
									</span>
								))}
							</div>
							<Link
								href={connectionsHref}
								className="mt-1 text-center text-xs font-medium text-[#1B6EC2] hover:underline dark:text-[#38BDF8]"
							>
								Connect to other sources ›
							</Link>
						</div>

						{/* Databricks "Getting started: Add operators" Pastel Gradient Modal (Image 5) */}
						{showGettingStarted && (
							<div className="absolute inset-0 z-40 flex items-center justify-center bg-background/40 backdrop-blur-[1px] p-4">
								<div className="relative flex w-full max-w-[660px] flex-col justify-between rounded-xl border border-border bg-gradient-to-br from-[#DDF0FF] via-[#F3E8FF] to-[#FFE8E5] dark:from-[#16283A] dark:via-[#241B35] dark:to-[#331D24] p-6 shadow-xl">
									<button
										type="button"
										onClick={() =>
											setShowGettingStarted(false)
										}
										aria-label="Close Getting started modal"
										className="absolute right-4 top-4 rounded-md p-1 text-foreground/70 hover:bg-black/5 hover:text-foreground"
									>
										<XIcon className="size-4" />
									</button>

									<div className="grid grid-cols-1 gap-6 md:grid-cols-12 items-center pt-2">
										<div className="md:col-span-5 space-y-2.5">
											<div className="font-mono text-xs text-foreground/70">
												Getting started
											</div>
											<h3 className="text-xl font-bold text-foreground">
												{
													GETTING_STARTED_STEPS[
														gettingStartedStep
													].title
												}
											</h3>
											<p className="text-xs leading-relaxed text-foreground/80">
												{
													GETTING_STARTED_STEPS[
														gettingStartedStep
													].description
												}
											</p>
										</div>

										<div className="md:col-span-7 rounded-lg border border-border/80 bg-background/95 p-4 shadow-md">
											<div className="flex items-center gap-3">
												<div className="rounded-md border-2 border-dashed border-[#0284C7] bg-[#E0F2FE]/60 p-2.5 text-xs">
													<div className="font-semibold text-foreground">
														source_1
													</div>
													<div className="text-[10px] text-muted-foreground">
														Select all columns from
														table
													</div>
												</div>
												<div className="h-0.5 w-5 bg-[#0284C7]" />
												<div className="rounded-md border-2 border-dashed border-[#8B5CF6] bg-[#F3E8FF]/70 p-2.5 text-xs">
													<div className="font-semibold text-foreground">
														aifunction_2
													</div>
													<div className="text-[10px] text-muted-foreground">
														Analyze & enrich rows
														with AI
													</div>
												</div>
											</div>
										</div>
									</div>

									<div className="mt-6 flex items-center justify-between pt-3">
										<span className="text-xs font-medium text-foreground/75">
											{gettingStartedStep + 1} of{" "}
											{GETTING_STARTED_STEPS.length}
										</span>
										<div className="flex items-center gap-2">
											<Button
												type="button"
												variant="outline"
												size="sm"
												disabled={
													gettingStartedStep === 0
												}
												onClick={() =>
													setGettingStartedStep((s) =>
														Math.max(0, s - 1),
													)
												}
												className="h-8 bg-background/90 text-xs"
											>
												Previous
											</Button>
											<Button
												type="button"
												size="sm"
												onClick={() => {
													if (
														gettingStartedStep <
														GETTING_STARTED_STEPS.length -
															1
													) {
														setGettingStartedStep(
															(s) => s + 1,
														);
													} else {
														setShowGettingStarted(
															false,
														);
													}
												}}
												className="h-8 bg-[#1B6EC2] text-white hover:bg-[#155a9e] text-xs"
											>
												{gettingStartedStep <
												GETTING_STARTED_STEPS.length - 1
													? "Next"
													: "Done"}
											</Button>
										</div>
									</div>
								</div>
							</div>
						)}
					</div>

					{/* Bottom Preview Drawer Bar */}
					<div className="border-t border-border bg-background">
						<div className="flex h-8 items-center justify-between px-3">
							<button
								type="button"
								onClick={() => setShowPreviewDrawer((v) => !v)}
								className="flex items-center gap-1.5 text-xs font-semibold text-foreground hover:text-primary"
							>
								<span>Preview</span>
								<span className="text-[11px] font-normal text-muted-foreground">
									({canvasNodes.length}{" "}
									{canvasNodes.length === 1
										? "operator"
										: "operators"}{" "}
									in pipeline)
								</span>
							</button>
							<div className="flex items-center gap-1">
								<button
									type="button"
									onClick={() =>
										setShowPreviewDrawer((v) => !v)
									}
									aria-label="Toggle preview drawer"
									className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
								>
									{showPreviewDrawer ? (
										<ChevronDownIcon className="size-3.5" />
									) : (
										<ChevronUpIcon className="size-3.5" />
									)}
								</button>
								<button
									type="button"
									onClick={() => setShowPreviewDrawer(false)}
									aria-label="Close preview drawer"
									className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
								>
									<XIcon className="size-3.5" />
								</button>
							</div>
						</div>
						{showPreviewDrawer && (
							<div className="border-t border-border bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
								Run the pipeline or select an operator node to
								preview output rows and execution metrics.
							</div>
						)}
					</div>
				</div>

				{/* Far-right Utility Rail */}
				<div className="hidden sm:flex w-9 shrink-0 flex-col items-center gap-2 border-l border-border bg-muted/20 py-2.5">
					<button
						type="button"
						onClick={onCreateWorkflow}
						title="Run history"
						aria-label="Run history"
						className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
					>
						<HistoryIcon className="size-4" />
					</button>
					<button
						type="button"
						onClick={() => setShowPreviewDrawer((v) => !v)}
						title="Parameters"
						aria-label="Parameters"
						className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
					>
						<SlidersHorizontalIcon className="size-4" />
					</button>
					<button
						type="button"
						onClick={() => setShowGettingStarted((v) => !v)}
						title="Getting started"
						aria-label="Getting started guide"
						className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
					>
						<EyeIcon className="size-4" />
					</button>
				</div>
			</div>
		</div>
	);
}
