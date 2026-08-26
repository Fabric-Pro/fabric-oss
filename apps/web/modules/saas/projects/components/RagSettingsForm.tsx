"use client";

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
	AlertTriangleIcon,
	BrainIcon,
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
	similarityThreshold: number;
	enableReranking: boolean;
};

const splitMethodOptions = [
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

export function RagSettingsForm({ projectId, compact = false }: Props) {
	const queryClient = useQueryClient();
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
		topK: 5,
		similarityThreshold: 0.5,
		enableReranking: false,
	});

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
				similarityThreshold: data.settings.similarityThreshold,
				enableReranking: data.settings.enableReranking,
			});
			setHasChanges(false);
		}
	}, [data?.settings]);

	const updateMutation = useMutation(
		orpc.projects.ragSettings.update.mutationOptions({
			onSuccess: () => {
				toast.success("RAG settings saved successfully");
				queryClient.invalidateQueries({
					queryKey: orpc.projects.ragSettings.get.queryKey({
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
		setSettings((prev) => ({ ...prev, [key]: value }));
		setHasChanges(true);
	};

	const handleSave = () => {
		updateMutation.mutate({
			projectId,
			...settings,
		});
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
				similarityThreshold: data.settings.similarityThreshold,
				enableReranking: data.settings.enableReranking,
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
						className="h-32 animate-pulse rounded-xl bg-foreground/5"
					/>
				))}
			</div>
		);
	}

	return (
		<div className={compact ? "space-y-4" : "space-y-6"}>
			{/* Header - only shown when not compact */}
			{!compact && (
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-3">
						<div className="rounded-xl bg-primary/10 p-2.5">
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
				{/* Chunking Strategy */}
				<GlassCard gradient="from-primary/3 to-primary/2">
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
									{splitMethodOptions.map((option) => (
										<SelectItem
											key={option.value}
											value={option.value}
											className="py-2"
										>
											<div className="flex flex-col gap-0.5">
												<div className="flex items-center gap-2">
													<span className="font-medium">
														{option.label}
													</span>
													{"badge" in option &&
														option.badge && (
															<span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
																{option.badge}
															</span>
														)}
													{"recommended" in option &&
														option.recommended && (
															<span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
																Recommended
															</span>
														)}
												</div>
												<span className="text-foreground/50 text-xs">
													{option.description}
												</span>
											</div>
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							{settings.splitMethod === "SEMANTIC" && (
								<p className="text-amber-600 dark:text-amber-400 text-xs">
									⚠️ Semantic chunking uses AI embeddings and
									may incur additional API costs
								</p>
							)}
						</div>

						{/* Chunk Size */}
						<div className={compact ? "space-y-2" : "space-y-3"}>
							<div className="flex items-center justify-between">
								<Label className={compact ? "text-xs" : ""}>
									Chunk Size
								</Label>
								<span className="font-mono text-primary text-sm">
									{settings.chunkSize.toLocaleString()} chars
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
								Larger chunks preserve more context but may
								reduce precision
							</p>
						</div>

						{/* Chunk Overlap */}
						<div className={compact ? "space-y-2" : "space-y-3"}>
							<div className="flex items-center justify-between">
								<Label className={compact ? "text-xs" : ""}>
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
								max={Math.min(2000, settings.chunkSize - 100)}
								step={50}
								className="py-2"
							/>
							<p className="text-foreground/50 text-xs">
								Overlap helps maintain context continuity
								between chunks
							</p>
						</div>
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
									"w-full rounded-xl border p-4 text-left transition-all",
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
									Top K Results
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
								max={20}
								step={1}
								className="py-2"
							/>
							<p className="text-foreground/50 text-xs">
								Number of most relevant chunks to retrieve
							</p>
						</div>

						{/* Similarity Threshold */}
						<div className={compact ? "space-y-2" : "space-y-3"}>
							<div className="flex items-center justify-between">
								<Label className={compact ? "text-xs" : ""}>
									Similarity Threshold
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
								Minimum similarity score for retrieved chunks
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
						<div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-foreground/10 p-4">
							<div className="flex min-w-0 items-center gap-3">
								<div className="rounded-lg bg-muted/60 p-2">
									<LayersIcon className="size-4 text-foreground/60" />
								</div>
								<div className="min-w-0">
									<p className="font-medium">
										Enable Reranking
									</p>
									<p className="break-words text-foreground/50 text-sm">
										Reorder results using a cross-encoder
										model
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

				{/* Re-process Documents Section */}
				<GlassCard className={compact ? "p-4" : "p-6"}>
					<div
						className={`flex items-center gap-2 ${compact ? "mb-3" : "mb-4"}`}
					>
						<div
							className={`rounded-lg bg-primary/10 ${compact ? "p-1.5" : "p-2"}`}
						>
							<RotateCcwIcon
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
							Re-process Documents
						</h3>
					</div>

					<div className="space-y-4">
						<p className="text-foreground/60 text-sm">
							Re-process all existing documents with the current
							RAG settings. This will delete existing embeddings
							and create new ones using the current chunk size,
							overlap, and split method.
						</p>

						<div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
							<AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-highlight" />
							<div className="text-sm">
								<p className="font-medium text-amber-600 dark:text-amber-400">
									This operation may take a while
								</p>
								<p className="mt-1 text-foreground/60">
									Processing time depends on the number of
									documents. Semantic chunking uses AI and may
									incur additional API costs.
								</p>
							</div>
						</div>

						<AlertDialog>
							<DestructiveTooltip copy={reprocessCopy}>
								<AlertDialogTrigger asChild>
									<Button
										variant="outline"
										className="w-full gap-2"
										disabled={reprocessMutation.isPending}
									>
										{reprocessMutation.isPending ? (
											<>
												<Loader2Icon className="size-4 animate-spin" />
												Re-processing...
											</>
										) : (
											<>
												<RotateCcwIcon className="size-4" />
												Re-process All Documents
											</>
										)}
									</Button>
								</AlertDialogTrigger>
							</DestructiveTooltip>
							<AlertDialogContent>
								<AlertDialogHeader>
									<AlertDialogTitle>
										Re-process all documents?
									</AlertDialogTitle>
									<AlertDialogDescription className="space-y-2">
										<span className="block">
											This will delete all existing
											embeddings and re-chunk all
											documents using your current RAG
											settings.
										</span>
										<span className="block font-medium text-amber-600 dark:text-amber-400">
											This operation cannot be undone and
											may take several minutes depending
											on the number of documents.
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
										Re-process Documents
									</AlertDialogAction>
								</AlertDialogFooter>
							</AlertDialogContent>
						</AlertDialog>
					</div>
				</GlassCard>
			</div>
		</div>
	);
}
