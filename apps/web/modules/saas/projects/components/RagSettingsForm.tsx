"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { GlassCard } from "@saas/shared/components/GlassCard";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@ui/components/alert-dialog";
import { Button } from "@ui/components/button";
import {
	DestructiveTooltip,
	type DestructiveTooltipCopy,
} from "@ui/components/destructive-tooltip";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Slider } from "@ui/components/slider";
import { Switch } from "@ui/components/switch";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	BrainIcon,
	CodeIcon,
	LayersIcon,
	Loader2Icon,
	RefreshCwIcon,
	RotateCcwIcon,
	SaveIcon,
	SearchIcon,
	SettingsIcon,
	SparklesIcon,
	SplitIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CodeSearchModeSetting } from "./ProjectRepositoryIntegrationSettings";
import { ChunkingCheckPrompt } from "./rag-settings/ChunkingCheckPrompt";
import {
	ChunkingTypesTable,
	type ChunkTypeEntries,
} from "./rag-settings/ChunkingTypesTable";
import {
	RechunkConfirmDialog,
	RechunkStatus,
} from "./rag-settings/ContentTypeChunking";

type Props = {
	projectId: string;
	/** When true, shows a more compact layout without the main header */
	compact?: boolean;
};

type RagSettings = {
	chunkSize: number;
	chunkOverlap: number;
	splitMethod:
		| "PARAGRAPH"
		| "SENTENCE"
		| "FIXED"
		| "RECURSIVE"
		| "DOCUMENT"
		| "SEMANTIC";
	embeddingModel: "TEXT_EMBEDDING_3_SMALL" | "TEXT_EMBEDDING_3_LARGE";
	topK: number;
	rerankTopK: number;
	similarityThreshold: number;
	enableReranking: boolean;
	/** Per-type rows (spec 2026-10-28 §6); a type without one is Custom. */
	chunkProfiles: ChunkTypeEntries;
};

/** Fields whose change re-chunks the whole project (spec 2026-10-28 §6). */
const CHUNKING_KEYS = [
	"chunkProfiles",
	"splitMethod",
	"chunkSize",
	"chunkOverlap",
] as const;

const splitMethodOptions: Array<{
	value: RagSettings["splitMethod"];
	label: string;
	description: string;
	recommended?: boolean;
	badge?: string;
}> = [
	{
		value: "DOCUMENT",
		label: "Document",
		description: "Structure-aware splitting (markdown, code blocks)",
		recommended: true,
	},
	{
		value: "SEMANTIC",
		label: "Semantic",
		description: "AI-powered grouping of similar content",
		badge: "Best Quality",
	},
	{
		value: "PARAGRAPH",
		label: "Paragraph",
		description: "Split by paragraphs for natural text boundaries",
	},
	{
		value: "RECURSIVE",
		label: "Recursive",
		description: "Hierarchical splitting with fallback separators",
	},
	{
		value: "SENTENCE",
		label: "Sentence",
		description: "Split by sentences for finer granularity",
	},
	{
		value: "FIXED",
		label: "Fixed Size",
		description: "Split at fixed character intervals",
	},
];

const embeddingModelOptions = [
	{
		value: "TEXT_EMBEDDING_3_SMALL",
		label: "text-embedding-3-small",
		description: "Faster, more cost-effective (1536 dimensions)",
	},
	{
		value: "TEXT_EMBEDDING_3_LARGE",
		label: "text-embedding-3-large",
		description: "Higher quality, more accurate (3072 dimensions)",
	},
];

/** The saved per-type rows, as the table edits them. */
function savedChunkProfiles(value: unknown): ChunkTypeEntries {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as ChunkTypeEntries)
		: {};
}

/** A size the server would refuse, said before the save. */
function chunkSizeProblem(rows: ChunkTypeEntries): string | null {
	for (const [type, row] of Object.entries(rows)) {
		if (
			row.chunkSize !== undefined &&
			(row.chunkSize < 500 || row.chunkSize > 10000)
		) {
			return `Chunk size for ${type} must be between 500 and 10,000 characters`;
		}
		if (
			row.chunkOverlap !== undefined &&
			(row.chunkOverlap < 0 ||
				row.chunkOverlap > 2000 ||
				(row.chunkSize !== undefined &&
					row.chunkOverlap >= row.chunkSize))
		) {
			return `Chunk overlap for ${type} must be 0–2,000 characters and smaller than its chunk size`;
		}
		for (const size of [row.target, row.max]) {
			if (size !== undefined && (size < 200 || size > 12000)) {
				return `Sizes for ${type} must be between 200 and 12,000 characters`;
			}
		}
		if (
			row.target !== undefined &&
			row.max !== undefined &&
			row.max < row.target
		) {
			return `Max size for ${type} must be at least its target`;
		}
	}
	return null;
}

export function RagSettingsForm({ projectId, compact = false }: Props) {
	const queryClient = useQueryClient();
	const { organizationId } = useOrganizationContext();
	const t = useTranslations("tooltips.projectSettings");
	const reprocessCopy = t.raw(
		"reprocessAllDocuments",
	) as DestructiveTooltipCopy;

	const { data, isLoading } = useQuery(
		orpc.projects.ragSettings.get.queryOptions({
			input: { projectId },
		}),
	);

	const [settings, setSettings] = useState<RagSettings>({
		chunkSize: 3000,
		chunkOverlap: 500,
		splitMethod: "DOCUMENT",
		embeddingModel: "TEXT_EMBEDDING_3_SMALL",
		topK: 50,
		rerankTopK: 10,
		similarityThreshold: 0.5,
		enableReranking: false,
		chunkProfiles: {},
	});
	const [confirmRechunk, setConfirmRechunk] = useState(false);

	const [hasChanges, setHasChanges] = useState(false);

	// Sync settings from API
	useEffect(() => {
		if (data?.settings) {
			setSettings({
				chunkSize: data.settings.chunkSize,
				chunkOverlap: data.settings.chunkOverlap,
				splitMethod: data.settings
					.splitMethod as RagSettings["splitMethod"],
				embeddingModel: data.settings
					.embeddingModel as RagSettings["embeddingModel"],
				topK: data.settings.topK,
				rerankTopK: Math.min(
					data.settings.rerankTopK ?? 10,
					data.settings.topK,
				),
				similarityThreshold: data.settings.similarityThreshold,
				enableReranking: data.settings.enableReranking,
				chunkProfiles: savedChunkProfiles(data.settings.chunkProfiles),
			});
			setHasChanges(false);
		}
	}, [data?.settings]);

	const updateMutation = useMutation(
		orpc.projects.ragSettings.update.mutationOptions({
			onSuccess: (result) => {
				toast.success(
					result.rechunk
						? "RAG settings saved; re-chunking the project"
						: "RAG settings saved successfully",
				);
				queryClient.invalidateQueries({
					queryKey: orpc.projects.ragSettings.get.queryKey({
						input: { projectId },
					}),
				});
				queryClient.invalidateQueries({
					queryKey: orpc.projects.ragSettings.chunkingRuns.queryKey({
						input: { projectId },
					}),
				});
				setHasChanges(false);
			},
			onError: (error) => {
				toast.error(`Failed to save settings: ${error.message}`);
			},
		}),
	);

	const reprocessMutation = useMutation(
		orpc.projects.ragSettings.reprocess.mutationOptions({
			onSuccess: (result) => {
				toast.success(result.message);
			},
			onError: (error) => {
				toast.error(`Failed to start re-processing: ${error.message}`);
			},
		}),
	);

	const handleReprocess = () => {
		reprocessMutation.mutate({ projectId });
	};

	const updateSetting = <K extends keyof RagSettings>(
		key: K,
		value: RagSettings[K],
	) => {
		setSettings((prev) => ({
			...prev,
			[key]: value,
			...(key === "topK"
				? { rerankTopK: Math.min(prev.rerankTopK, value as number) }
				: {}),
		}));
		setHasChanges(true);
	};

	const contentAwareChunkingEnabled =
		data?.contentAwareChunkingEnabled ?? false;

	const saveSettings = () => {
		// Per-type rows are sent only while they are offered, so a project
		// never moves by a save made while the flag is off.
		const { chunkProfiles, ...rest } = settings;
		updateMutation.mutate({
			projectId,
			...rest,
			...(contentAwareChunkingEnabled ? { chunkProfiles } : {}),
		});
	};

	const handleSave = () => {
		const saved = data?.settings;
		const chunkingChanged =
			saved &&
			CHUNKING_KEYS.some((key) =>
				key === "chunkProfiles"
					? contentAwareChunkingEnabled &&
						JSON.stringify(settings.chunkProfiles) !==
							JSON.stringify(
								savedChunkProfiles(saved.chunkProfiles),
							)
					: settings[key] !== saved[key],
			);
		const sizeProblem = chunkSizeProblem(settings.chunkProfiles);
		if (sizeProblem) {
			toast.error(sizeProblem);
			return;
		}
		if (chunkingChanged) {
			setConfirmRechunk(true);
			return;
		}
		saveSettings();
	};

	const handleReset = () => {
		if (data?.settings) {
			setSettings({
				chunkSize: data.settings.chunkSize,
				chunkOverlap: data.settings.chunkOverlap,
				splitMethod: data.settings
					.splitMethod as RagSettings["splitMethod"],
				embeddingModel: data.settings
					.embeddingModel as RagSettings["embeddingModel"],
				topK: data.settings.topK,
				rerankTopK: Math.min(
					data.settings.rerankTopK ?? 10,
					data.settings.topK,
				),
				similarityThreshold: data.settings.similarityThreshold,
				enableReranking: data.settings.enableReranking,
				chunkProfiles: savedChunkProfiles(data.settings.chunkProfiles),
			});
			setHasChanges(false);
		}
	};

	if (isLoading) {
		return (
			<div className="space-y-4">
				{[1, 2, 3].map((i) => (
					<div
						key={i}
						className="h-32 animate-pulse rounded-lg bg-foreground/5"
					/>
				))}
			</div>
		);
	}

	return (
		<div className={compact ? "space-y-4" : "space-y-6"}>
			<ChunkingCheckPrompt projectId={projectId} />
			{/* Header - only shown when not compact */}
			{!compact && (
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-3">
						<div className="rounded-lg bg-primary/10 p-2.5">
							<SettingsIcon className="size-5 text-primary" />
						</div>
						<div>
							<h2 className="font-semibold text-xl">
								RAG Settings
							</h2>
							<p className="text-foreground/50 text-sm">
								Configure how context is processed and retrieved
							</p>
						</div>
					</div>

					<div className="flex items-center gap-2">
						{hasChanges && (
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										variant="outline"
										size="sm"
										onClick={handleReset}
									>
										<RefreshCwIcon className="mr-2 size-4" />
										Reset
									</Button>
								</TooltipTrigger>
								<TooltipContent>{t("ragReset")}</TooltipContent>
							</Tooltip>
						)}
						<Button
							size="sm"
							onClick={handleSave}
							disabled={!hasChanges || updateMutation.isPending}
							className="gap-2"
						>
							<SaveIcon className="size-4" />
							{updateMutation.isPending
								? "Saving..."
								: "Save Changes"}
						</Button>
					</div>
				</div>
			)}

			{/* Compact mode: show save button at top */}
			{compact && hasChanges && (
				<div className="flex items-center justify-end gap-2">
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="outline"
								size="sm"
								onClick={handleReset}
							>
								<RefreshCwIcon className="mr-2 size-4" />
								Reset
							</Button>
						</TooltipTrigger>
						<TooltipContent>{t("ragReset")}</TooltipContent>
					</Tooltip>
					<Button
						size="sm"
						onClick={handleSave}
						disabled={updateMutation.isPending}
						className="gap-2"
					>
						<SaveIcon className="size-4" />
						{updateMutation.isPending
							? "Saving..."
							: "Save Changes"}
					</Button>
				</div>
			)}

			<div
				className={cn("grid gap-4", !compact && "gap-6 lg:grid-cols-2")}
			>
				{/* Code search first: it decides whether repository code is indexed
				    at all, and so whether the code row below shows (spec 2026-10-29
				    §5, §6a). The same switch as Development. */}
				<GlassCard
					gradient="from-primary/3 to-primary/2"
					className={cn(!compact && "lg:col-span-2")}
				>
					<div
						className={`flex items-center gap-2 ${compact ? "mb-3" : "mb-4"}`}
					>
						<div
							className={`rounded-lg bg-primary/10 ${compact ? "p-1.5" : "p-2"}`}
						>
							<CodeIcon
								className={
									compact
										? "size-3.5 text-primary"
										: "size-4 text-primary"
								}
							/>
						</div>
						<h3
							className={
								compact
									? "font-medium text-sm"
									: "font-semibold"
							}
						>
							Code search
						</h3>
					</div>
					<CodeSearchModeSetting
						projectId={projectId}
						organizationId={organizationId ?? null}
						anchor={false}
					/>
				</GlassCard>

				{/* Chunking Strategy: full width once it holds the per-type table */}
				<GlassCard
					gradient="from-primary/3 to-primary/2"
					className={cn(
						contentAwareChunkingEnabled &&
							!compact &&
							"lg:col-span-2",
					)}
				>
					<div
						className={`flex items-center gap-2 ${compact ? "mb-3" : "mb-4"}`}
					>
						<div
							className={`rounded-lg bg-primary/10 ${compact ? "p-1.5" : "p-2"}`}
						>
							<SplitIcon
								className={
									compact
										? "size-3.5 text-primary"
										: "size-4 text-primary"
								}
							/>
						</div>
						<h3
							className={
								compact
									? "font-medium text-sm"
									: "font-semibold"
							}
						>
							Chunking Strategy
						</h3>
					</div>

					<div className={compact ? "space-y-4" : "space-y-6"}>
						<ChunkingTypesTable
							projectId={projectId}
							organizationId={organizationId ?? null}
							value={settings.chunkProfiles}
							chunkByContentType={
								data?.settings?.chunkByContentType ?? false
							}
							onChange={(next) =>
								updateSetting("chunkProfiles", next)
							}
							customDefaults={{
								splitMethod: settings.splitMethod,
								chunkSize: settings.chunkSize,
								chunkOverlap: settings.chunkOverlap,
							}}
							splitMethodOptions={splitMethodOptions}
							editable={contentAwareChunkingEnabled}
							compact={compact}
						/>
						<div className="flex flex-wrap items-center gap-3">
							<RechunkStatus projectId={projectId} />
							{/* Saving a chunking change re-chunks by itself; this runs
							    it again, as after a failed run. */}
							<AlertDialog>
								<DestructiveTooltip copy={reprocessCopy}>
									<AlertDialogTrigger asChild>
										<Button
											type="button"
											variant="link"
											size="sm"
											className="h-auto gap-1 p-0 text-xs"
											disabled={
												reprocessMutation.isPending
											}
										>
											{reprocessMutation.isPending ? (
												<Loader2Icon className="size-3 animate-spin" />
											) : (
												<RotateCcwIcon className="size-3" />
											)}
											Re-chunk now
										</Button>
									</AlertDialogTrigger>
								</DestructiveTooltip>
								<AlertDialogContent>
									<AlertDialogHeader>
										<AlertDialogTitle>
											Re-chunk the whole project?
										</AlertDialogTitle>
										<AlertDialogDescription className="space-y-2">
											<span className="block">
												This will delete all existing
												embeddings and re-chunk all
												documents using your current RAG
												settings.
											</span>
											<span className="block font-medium text-amber-600 dark:text-amber-400">
												This operation cannot be undone
												and may take several minutes
												depending on the number of
												documents.
											</span>
										</AlertDialogDescription>
									</AlertDialogHeader>
									<AlertDialogFooter>
										<AlertDialogCancel>
											Cancel
										</AlertDialogCancel>
										<AlertDialogAction
											onClick={handleReprocess}
										>
											Re-chunk
										</AlertDialogAction>
									</AlertDialogFooter>
								</AlertDialogContent>
							</AlertDialog>
						</div>
						{/* Per-type rows carry their own split method, size and
						    overlap (Custom); these project values are only where
						    a Custom type starts. Without per-type chunking they
						    are the project's chunking. */}
						{!contentAwareChunkingEnabled && (
							<>
								{/* Split Method */}
								<div className="space-y-2">
									<Label className={compact ? "text-xs" : ""}>
										Split Method
									</Label>
									<Select
										value={settings.splitMethod}
										onValueChange={(value) =>
											updateSetting(
												"splitMethod",
												value as RagSettings["splitMethod"],
											)
										}
									>
										<SelectTrigger className="w-full">
											<SelectValue>
												{
													splitMethodOptions.find(
														(o) =>
															o.value ===
															settings.splitMethod,
													)?.label
												}
											</SelectValue>
										</SelectTrigger>
										<SelectContent>
											{splitMethodOptions.map(
												(option) => (
													<SelectItem
														key={option.value}
														value={option.value}
														className="py-2"
													>
														<div className="flex flex-col gap-0.5">
															<div className="flex items-center gap-2">
																<span className="font-medium">
																	{
																		option.label
																	}
																</span>
																{"badge" in
																	option &&
																	option.badge && (
																		<span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
																			{
																				option.badge
																			}
																		</span>
																	)}
																{"recommended" in
																	option &&
																	option.recommended && (
																		<span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
																			Recommended
																		</span>
																	)}
															</div>
															<span className="text-foreground/50 text-xs">
																{
																	option.description
																}
															</span>
														</div>
													</SelectItem>
												),
											)}
										</SelectContent>
									</Select>
									{settings.splitMethod === "SEMANTIC" && (
										<p className="text-amber-600 dark:text-amber-400 text-xs">
											⚠️ Semantic chunking uses AI
											embeddings and may incur additional
											API costs
										</p>
									)}
								</div>

								{/* Chunk Size */}
								<div
									className={
										compact ? "space-y-2" : "space-y-3"
									}
								>
									<div className="flex items-center justify-between">
										<Label
											className={compact ? "text-xs" : ""}
										>
											Chunk Size
										</Label>
										<span className="font-mono text-primary text-sm">
											{settings.chunkSize.toLocaleString()}{" "}
											chars
										</span>
									</div>
									<Slider
										value={[settings.chunkSize]}
										onValueChange={([value]) =>
											updateSetting("chunkSize", value)
										}
										min={500}
										max={10000}
										step={100}
										className="py-2"
									/>
									<p className="text-foreground/50 text-xs">
										Larger chunks preserve more context but
										may reduce precision
									</p>
								</div>

								{/* Chunk Overlap */}
								<div
									className={
										compact ? "space-y-2" : "space-y-3"
									}
								>
									<div className="flex items-center justify-between">
										<Label
											className={compact ? "text-xs" : ""}
										>
											Chunk Overlap
										</Label>
										<span className="font-mono text-primary text-sm">
											{settings.chunkOverlap.toLocaleString()}{" "}
											chars
										</span>
									</div>
									<Slider
										value={[settings.chunkOverlap]}
										onValueChange={([value]) =>
											updateSetting("chunkOverlap", value)
										}
										min={0}
										max={Math.min(
											2000,
											settings.chunkSize - 100,
										)}
										step={50}
										className="py-2"
									/>
									<p className="text-foreground/50 text-xs">
										Overlap helps maintain context
										continuity between chunks
									</p>
								</div>
							</>
						)}
					</div>
				</GlassCard>

				{/* Embedding Model */}
				<GlassCard gradient="from-primary/3 to-primary/2">
					<div
						className={`flex items-center gap-2 ${compact ? "mb-3" : "mb-4"}`}
					>
						<div
							className={`rounded-lg bg-primary/10 ${compact ? "p-1.5" : "p-2"}`}
						>
							<BrainIcon
								className={
									compact
										? "size-3.5 text-primary"
										: "size-4 text-primary"
								}
							/>
						</div>
						<h3
							className={
								compact
									? "font-medium text-sm"
									: "font-semibold"
							}
						>
							Embedding Model
						</h3>
					</div>

					<div className="space-y-4">
						{embeddingModelOptions.map((option) => (
							<button
								key={option.value}
								type="button"
								onClick={() =>
									updateSetting(
										"embeddingModel",
										option.value as RagSettings["embeddingModel"],
									)
								}
								className={cn(
									"w-full rounded-lg border p-4 text-left transition-all",
									settings.embeddingModel === option.value
										? "border-primary bg-primary/5"
										: "border-foreground/10 hover:border-foreground/20",
								)}
							>
								<div className="flex items-start gap-3">
									<div
										className={cn(
											"mt-0.5 size-4 shrink-0 rounded-full border-2",
											settings.embeddingModel ===
												option.value
												? "border-primary bg-primary"
												: "border-foreground/20",
										)}
									/>
									<div className="min-w-0">
										<p className="font-medium">
											{option.label}
										</p>
										<p className="break-words text-foreground/50 text-sm">
											{option.description}
										</p>
									</div>
								</div>
							</button>
						))}
					</div>
				</GlassCard>

				{/* Retrieval Settings */}
				<GlassCard gradient="from-primary/3 to-primary/2">
					<div
						className={`flex items-center gap-2 ${compact ? "mb-3" : "mb-4"}`}
					>
						<div
							className={`rounded-lg bg-primary/10 ${compact ? "p-1.5" : "p-2"}`}
						>
							<SearchIcon
								className={
									compact
										? "size-3.5 text-primary"
										: "size-4 text-primary"
								}
							/>
						</div>
						<h3
							className={
								compact
									? "font-medium text-sm"
									: "font-semibold"
							}
						>
							Retrieval Settings
						</h3>
					</div>

					<div className={compact ? "space-y-4" : "space-y-6"}>
						{/* Top K */}
						<div className={compact ? "space-y-2" : "space-y-3"}>
							<div className="flex items-center justify-between">
								<Label className={compact ? "text-xs" : ""}>
									Candidate chunks
								</Label>
								<span className="font-mono text-primary text-sm">
									{settings.topK} chunks
								</span>
							</div>
							<Slider
								value={[settings.topK]}
								onValueChange={([value]) =>
									updateSetting("topK", value)
								}
								min={1}
								max={100}
								step={1}
								className="py-2"
							/>
							<p className="text-foreground/50 text-xs">
								Matching chunks searched before sources are
								chosen
							</p>
						</div>

						<div className="space-y-3">
							<Label>Maximum sources returned</Label>
							<span>{settings.rerankTopK} sources</span>
							<Slider
								aria-label="Maximum sources returned"
								value={[settings.rerankTopK]}
								onValueChange={([value]) =>
									updateSetting("rerankTopK", value)
								}
								min={1}
								max={Math.min(50, settings.topK)}
								step={1}
							/>
						</div>

						{/* Minimum semantic similarity */}
						<div className={compact ? "space-y-2" : "space-y-3"}>
							<div className="flex items-center justify-between">
								<Label className={compact ? "text-xs" : ""}>
									Minimum semantic similarity
								</Label>
								<span className="font-mono text-primary text-sm">
									{(
										settings.similarityThreshold * 100
									).toFixed(0)}
									%
								</span>
							</div>
							<Slider
								value={[settings.similarityThreshold]}
								onValueChange={([value]) =>
									updateSetting("similarityThreshold", value)
								}
								min={0.3}
								max={0.9}
								step={0.05}
								className="py-2"
							/>
							<p className="text-foreground/50 text-xs">
								Minimum similarity for semantic matches. Keyword
								matches are kept regardless.
							</p>
						</div>
					</div>
				</GlassCard>

				{/* Advanced Settings */}
				<GlassCard gradient="from-primary/3 to-primary/2">
					<div
						className={`flex items-center gap-2 ${compact ? "mb-3" : "mb-4"}`}
					>
						<div
							className={`rounded-lg bg-primary/10 ${compact ? "p-1.5" : "p-2"}`}
						>
							<SparklesIcon
								className={
									compact
										? "size-3.5 text-primary"
										: "size-4 text-primary"
								}
							/>
						</div>
						<h3
							className={
								compact
									? "font-medium text-sm"
									: "font-semibold"
							}
						>
							Reranking
						</h3>
					</div>

					<div className="space-y-4">
						{/* Reranking */}
						<div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-foreground/10 p-4">
							<div className="flex min-w-0 items-center gap-3">
								<div className="rounded-lg bg-muted/60 p-2">
									<LayersIcon className="size-4 text-foreground/60" />
								</div>
								<div className="min-w-0">
									<p className="font-medium">
										Enable Reranking
									</p>
									<p className="break-words text-foreground/50 text-sm">
										Matches are reordered by a reranking
										model using the organization's Vercel AI
										Gateway key. Without one, sources are
										chosen by search score.
									</p>
								</div>
							</div>
							<Switch
								checked={settings.enableReranking}
								onCheckedChange={(checked) =>
									updateSetting("enableReranking", checked)
								}
							/>
						</div>

						<p className="text-foreground/50 text-xs">
							Reranking can improve result quality but adds
							latency. Recommended for complex queries.
						</p>
					</div>
				</GlassCard>
			</div>
			<RechunkConfirmDialog
				projectId={projectId}
				open={confirmRechunk}
				onOpenChange={setConfirmRechunk}
				onConfirm={() => {
					setConfirmRechunk(false);
					saveSettings();
				}}
			/>
		</div>
	);
}
