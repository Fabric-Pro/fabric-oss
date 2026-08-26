"use client";

import type {
	GraphMode,
	NodeOverrideHistoryEntry,
	AtlasNodeNeighbor,
} from "@repo/atlas/types";
/**
 * Compact detail card for the currently-selected graph node (floats over the
 * map). Modelled on the reference `.ctx-card`: a category icon-chip + uppercase
 * category label header, the node title, a clamped description (Show more/less),
 * two stat pills (files / links), and "Depends on" / "Used by" neighbour chips —
 * each tinted by the NEIGHBOUR's category, clickable to pin it.
 *
 * The card stays SHORT by default: the heavier affordances are tucked away —
 * "Regenerate with AI" sits behind a small icon toggle, documentation + the full
 * metrics grid behind a "More details" disclosure, and "Ask AI about this" is the
 * footer CTA. It only grows when the user expands a section.
 *
 * Data + behaviour are preserved from the original panel: the `atlas
 * .node` query, `describeNode` mutation (incl. the FILE "Describe with AI" empty
 * state and free-text regeneration), `onSelectNode`, `onAskAi`, and the
 * focus-to-heading-on-select. Escape-to-close + focus-return are handled by the
 * floating wrapper in `ProjectAtlas`.
 */
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ui/components/popover";
import { ScrollArea } from "@ui/components/scroll-area";
import { Skeleton } from "@ui/components/skeleton";
import { Textarea } from "@ui/components/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	CheckIcon,
	ChevronDownIcon,
	ClockIcon,
	FilesIcon,
	FileTextIcon,
	LinkIcon,
	Loader2Icon,
	MessageSquarePlusIcon,
	PencilIcon,
	RefreshCwIcon,
	SparklesIcon,
	Undo2Icon,
	XIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import {
	type CSSProperties,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import { CATEGORY_DESC_KEY, resolveNodeCategory } from "./atlas-categories";
import { formatRelativeTime } from "./atlas-utils";

interface AtlasNodePanelProps {
	projectId: string;
	analysisId: string;
	mode: GraphMode;
	nodeKey: string;
	onClose: () => void;
	onSelectNode: (key: string) => void;
	onAskAi: (nodeKey: string, nodeLabel: string) => void;
}

const NO_AI_PROVIDER_HINT = "NO_AI_PROVIDER";
// Description longer than this (chars) collapses behind a "Show more" toggle.
// Sized to roughly the clamped line budget below so the toggle only appears
// when the text would actually be cut off.
const DESCRIPTION_CLAMP_CHARS = 360;
// Neighbour chips shown before the "+N more" disclosure.
const CHIP_VISIBLE_LIMIT = 8;

export function AtlasNodePanel({
	projectId,
	analysisId,
	mode,
	nodeKey,
	onClose,
	onSelectNode,
	onAskAi,
}: AtlasNodePanelProps) {
	const t = useTranslations("projects.atlas.node");
	const tCat = useTranslations("projects.atlas.category");
	const { organizationId } = useOrganizationContext();
	const queryClient = useQueryClient();
	const headingRef = useRef<HTMLHeadingElement>(null);
	const [showRegenerate, setShowRegenerate] = useState(false);
	const [regenerateInstructions, setRegenerateInstructions] = useState("");
	const [descExpanded, setDescExpanded] = useState(false);
	const [showAllDeps, setShowAllDeps] = useState(false);
	const [showAllUsedBy, setShowAllUsedBy] = useState(false);
	const [showDetails, setShowDetails] = useState(false);
	// Inline description editor (pencil → Textarea over the rendered markdown).
	const [editingDescription, setEditingDescription] = useState(false);
	const [descDraft, setDescDraft] = useState("");
	// Lazy edit-history popover.
	const [historyOpen, setHistoryOpen] = useState(false);

	// Move focus to the panel heading whenever a new node is selected so
	// keyboard/screen-reader users are oriented immediately, and reset the
	// per-node disclosures + edit affordances so the next card opens compact.
	useEffect(() => {
		headingRef.current?.focus();
		setDescExpanded(false);
		setShowAllDeps(false);
		setShowAllUsedBy(false);
		setShowDetails(false);
		setShowRegenerate(false);
		setRegenerateInstructions("");
		setEditingDescription(false);
		setDescDraft("");
		setHistoryOpen(false);
	}, [nodeKey]);

	// Tenant-scoped identity for this node — reused by the detail query, the
	// override mutation, and the (lazy) history query, and to build the exact
	// query keys we hand-update / invalidate on a successful edit.
	const nodeInput = useMemo(
		() => ({
			projectId,
			analysisId,
			mode,
			key: nodeKey,
			organizationId: organizationId ?? null,
		}),
		[projectId, analysisId, mode, nodeKey, organizationId],
	);

	const nodeQuery = useQuery(
		orpc.atlas.node.queryOptions({ input: nodeInput }),
	);

	// Edit history is read only when the popover opens (lazy), and re-fetched
	// after each override edit (invalidated below).
	const historyQuery = useQuery({
		...orpc.atlas.nodeHistory.queryOptions({
			input: nodeInput,
		}),
		enabled: historyOpen,
	});

	const describeMutation = useMutation(
		orpc.atlas.describeNode.mutationOptions({
			onSuccess: () => {
				// Re-read the node so a user description/category override still
				// WINS over the freshly-regenerated AI text — regenerate updates
				// the AI version behind the override, it never silently wipes it.
				// Refresh the graph too: a node with no category override re-colours
				// to the new AI category across the map / legend / overview.
				queryClient.invalidateQueries({
					queryKey: orpc.atlas.node.queryKey({
						input: nodeInput,
					}),
				});
				queryClient.invalidateQueries({
					queryKey: orpc.atlas.graph.key(),
				});
				toast.success(t("describeSuccess"));
				setShowRegenerate(false);
				setRegenerateInstructions("");
			},
			onError: (error) => {
				const msg =
					error instanceof Error ? error.message : String(error);
				if (msg.includes(NO_AI_PROVIDER_HINT)) {
					toast.error(t("noAiProvider"));
				} else {
					toast.error(t("describeError"), { description: msg });
				}
			},
		}),
	);

	// Save / clear a stable user override (description or category). The returned
	// effective detail is adopted immediately; the graph + this node's history are
	// invalidated so every surface reflects the new override.
	const updateNodeMutation = useMutation(
		orpc.atlas.updateNode.mutationOptions({
			onSuccess: (detail) => {
				queryClient.setQueryData(
					orpc.atlas.node.queryKey({ input: nodeInput }),
					detail,
				);
				queryClient.invalidateQueries({
					queryKey: orpc.atlas.graph.key(),
				});
				queryClient.invalidateQueries({
					queryKey: orpc.atlas.nodeHistory.queryKey({
						input: nodeInput,
					}),
				});
				toast.success(t("editSaved"));
			},
			onError: (error) => {
				toast.error(t("editError"), {
					description:
						error instanceof Error ? error.message : String(error),
				});
			},
		}),
	);

	const detail = nodeQuery.data;

	// The EFFECTIVE description for the current mode. `getNodeDetail` already
	// resolves this per-mode AND overlays any user override, so we use it directly
	// — falling back to the raw AI columns here would hide a user override.
	const description = detail?.description ?? null;

	// EFFECTIVE category (a persisted user override / the AI value, else keyword
	// fallback) drives the header chip's accent + glyph; a custom value reads with
	// a neutral token + tag glyph.
	const resolvedCategory = useMemo(
		() =>
			detail
				? resolveNodeCategory({
						label: detail.label,
						filePath: detail.filePath,
						description,
						kind: detail.kind,
						category: detail.category,
					})
				: null,
		[detail, description],
	);
	const accent = resolvedCategory?.colorVar ?? "var(--primary)";
	const CategoryIcon = resolvedCategory?.Icon ?? SparklesIcon;
	const categoryLabel = resolvedCategory
		? resolvedCategory.known
			? tCat(resolvedCategory.known)
			: resolvedCategory.value
		: "";
	// One-line meaning for a known preset category (null for a custom value) —
	// shown as a hover tooltip on the read-only category chip.
	const categoryDescription = resolvedCategory?.known
		? tCat(CATEGORY_DESC_KEY[resolvedCategory.known])
		: null;

	const isUserDescription = detail?.isUserDescription ?? false;
	const canEdit = detail?.editable ?? false;

	// ── Override edit handlers (description + category) ──────────────────────────
	const startEditingDescription = () => {
		// Prefill with the current EFFECTIVE text (the override when one applies,
		// otherwise the AI/structural description).
		setDescDraft(description ?? "");
		setShowRegenerate(false);
		setHistoryOpen(false);
		setEditingDescription(true);
	};
	const saveDescription = () => {
		if (!descDraft.trim()) {
			return;
		}
		updateNodeMutation.mutate(
			{ ...nodeInput, userDescription: descDraft },
			{ onSuccess: () => setEditingDescription(false) },
		);
	};
	const clearDescription = () => {
		updateNodeMutation.mutate(
			{ ...nodeInput, userDescription: null },
			{ onSuccess: () => setEditingDescription(false) },
		);
	};
	const isSavingOverride = updateNodeMutation.isPending;

	// Split neighbours into outgoing (Depends on) and incoming (Used by).
	const { dependsOn, usedBy } = useMemo(() => {
		const out: AtlasNodeNeighbor[] = [];
		const incoming: AtlasNodeNeighbor[] = [];
		for (const neighbor of detail?.neighbors ?? []) {
			if (neighbor.direction === "out") {
				out.push(neighbor);
			} else {
				incoming.push(neighbor);
			}
		}
		return { dependsOn: out, usedBy: incoming };
	}, [detail]);

	const isFileNode = detail?.kind === "FILE";
	const canDescribe = isFileNode && !description;
	const isLongDescription =
		!!description && description.length > DESCRIPTION_CLAMP_CHARS;

	// Stat pills: files (file count, falling back to LOC) + links (neighbours).
	const fileCount = detail?.metrics?.fileCount;
	const loc = detail?.metrics?.loc;
	const linkCount = detail?.neighbors?.length ?? 0;

	// Every available metric in a stable display order, plus the node's primary
	// language (uppercased) as a final entry. Anything null/undefined is omitted,
	// so nodes only ever show the metrics they actually carry.
	const metricEntries = useMemo(() => {
		const metrics = detail?.metrics;
		const entries: { key: string; label: string; value: string }[] = [];
		const order: [string, string][] = [
			["loc", t("metrics.loc")],
			["fileCount", t("metrics.files")],
			["symbolCount", t("metrics.symbols")],
			["importCount", t("metrics.imports")],
			["dependentCount", t("metrics.dependents")],
		];
		if (metrics) {
			for (const [key, label] of order) {
				const value = metrics[key];
				if (typeof value === "number") {
					entries.push({
						key,
						label,
						value: value.toLocaleString(),
					});
				}
			}
		}
		if (detail?.language) {
			entries.push({
				key: "language",
				label: t("metrics.language"),
				value: detail.language.toUpperCase(),
			});
		}
		return entries;
	}, [detail, t]);

	// "More details" hosts the metrics grid plus the dependency chips, so it has
	// content whenever any of those (or attached documentation) exist.
	const hasDetails =
		!!detail?.documentation ||
		metricEntries.length > 0 ||
		dependsOn.length > 0 ||
		usedBy.length > 0;

	/** A clickable neighbour chip, dotted in the neighbour's own category colour. */
	const renderChip = (neighbor: AtlasNodeNeighbor) => {
		// Neighbours carry no persisted category, so this falls back to keyword
		// categorisation (the resolver handles that transparently).
		const chipColor = resolveNodeCategory({
			label: neighbor.label,
			kind: neighbor.kind,
		}).colorVar;
		return (
			<button
				key={`${neighbor.direction}-${neighbor.key}`}
				type="button"
				onClick={() => onSelectNode(neighbor.key)}
				className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-border/60 bg-muted/50 px-2 py-1 text-[11.5px] text-muted-foreground transition-colors hover:border-[color:var(--chip-color)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				style={{ "--chip-color": chipColor } as CSSProperties}
			>
				<span
					aria-hidden="true"
					className="size-1.5 shrink-0 rounded-full"
					style={{ background: chipColor }}
				/>
				<span className="truncate">{neighbor.label}</span>
			</button>
		);
	};

	/** A collapsible chip section ("Depends on" / "Used by"). */
	const renderChipSection = (
		label: string,
		items: AtlasNodeNeighbor[],
		expanded: boolean,
		setExpanded: (next: boolean) => void,
	) => {
		if (items.length === 0) {
			return null;
		}
		const shown = expanded ? items : items.slice(0, CHIP_VISIBLE_LIMIT);
		const overflow = items.length - shown.length;
		return (
			<div>
				<p className="mb-1.5 text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
					{label}
				</p>
				<div className="flex flex-wrap gap-1.5">
					{shown.map(renderChip)}
					{!expanded && overflow > 0 && (
						<button
							type="button"
							onClick={() => setExpanded(true)}
							className="rounded-lg border border-dashed border-border/60 px-2 py-1 text-[11.5px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							{t("moreChips", { count: overflow })}
						</button>
					)}
				</div>
			</div>
		);
	};

	/** One edit-history row: field · old → new · who · when. */
	const renderHistoryEntry = (entry: NodeOverrideHistoryEntry) => (
		<li
			key={entry.id}
			className="rounded-md px-1.5 py-1.5 transition-colors hover:bg-muted/50"
		>
			<div className="flex items-center justify-between gap-2">
				<span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
					{t(`historyField.${entry.field}`)}
				</span>
				<span className="shrink-0 text-[11px] text-muted-foreground">
					{formatRelativeTime(entry.createdAt)}
				</span>
			</div>
			<p className="mt-1 line-clamp-3 break-words text-xs leading-relaxed">
				<span className="text-muted-foreground line-through">
					{entry.oldValue?.trim() || "—"}
				</span>
				<span aria-hidden="true" className="mx-1 text-muted-foreground">
					→
				</span>
				<span className="text-foreground">
					{entry.newValue?.trim() || "—"}
				</span>
			</p>
			{entry.editedByName && (
				<p className="mt-0.5 text-[11px] text-muted-foreground">
					{t("historyBy", { name: entry.editedByName })}
				</p>
			)}
		</li>
	);

	return (
		<section
			aria-label={t("regionLabel")}
			className="flex h-full flex-col rounded-xl border bg-card"
			style={
				{
					"--cc": accent,
					borderColor: `color-mix(in srgb, ${accent} 28%, var(--border))`,
				} as CSSProperties
			}
		>
			<header className="flex items-center gap-1.5 border-b border-border/60 p-3">
				{/* Category chip — read-only. Categories are derived from the
				    analysis and are a visualization, not editable; hover or focus
				    reveals what the category means. */}
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							aria-label={categoryLabel}
							className="-ml-1 flex min-w-0 flex-1 cursor-help items-center gap-2 rounded-lg px-1 py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							<span
								aria-hidden="true"
								className="grid size-7 shrink-0 place-items-center rounded-lg border"
								style={{
									color: accent,
									background: `color-mix(in srgb, ${accent} 16%, transparent)`,
									borderColor: `color-mix(in srgb, ${accent} 28%, transparent)`,
								}}
							>
								<CategoryIcon
									aria-hidden="true"
									className="size-4"
								/>
							</span>
							<span
								className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-[0.16em]"
								style={{ color: accent }}
							>
								{categoryLabel}
							</span>
						</button>
					</TooltipTrigger>
					<TooltipContent
						side="bottom"
						align="start"
						className="max-w-xs"
					>
						{categoryDescription ?? categoryLabel}
					</TooltipContent>
				</Tooltip>
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					aria-label={t("close")}
					onClick={onClose}
					className="shrink-0"
				>
					<XIcon aria-hidden="true" className="size-4" />
				</Button>
			</header>

			<ScrollArea className="flex-1">
				<div className="space-y-4 p-3">
					{nodeQuery.isLoading ? (
						<div className="space-y-2">
							<Skeleton className="h-5 w-2/3" />
							<Skeleton className="h-4 w-full" />
							<Skeleton className="h-4 w-5/6" />
						</div>
					) : nodeQuery.isError ? (
						<p className="text-sm text-destructive">
							{t("loadError")}
						</p>
					) : (
						<>
							{/* Title */}
							<div>
								<h3
									ref={headingRef}
									tabIndex={-1}
									className="font-serif text-lg leading-tight text-foreground focus-visible:outline-none"
								>
									{detail?.label ?? t("notFound")}
								</h3>
								{detail?.filePath && (
									<p className="mt-0.5 truncate text-xs text-muted-foreground">
										{detail.filePath}
										{detail.language
											? ` · ${detail.language}`
											: ""}
									</p>
								)}
							</div>

							{/* Description — editable, with regenerate + history. */}
							<div>
								<div className="mb-1.5 flex items-center justify-between gap-2">
									<p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
										{t("description")}
									</p>
									{!editingDescription && (
										<div className="flex items-center gap-0.5">
											{/* Edit-history (lazy popover). */}
											<Popover
												open={historyOpen}
												onOpenChange={setHistoryOpen}
											>
												<Tooltip>
													<TooltipTrigger asChild>
														<PopoverTrigger asChild>
															<button
																type="button"
																aria-label={t(
																	"history",
																)}
																className="rounded p-0.5 text-muted-foreground/60 transition-colors hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
															>
																<ClockIcon
																	aria-hidden="true"
																	className="size-3.5"
																/>
															</button>
														</PopoverTrigger>
													</TooltipTrigger>
													<TooltipContent>
														{t("history")}
													</TooltipContent>
												</Tooltip>
												<PopoverContent
													align="end"
													className="w-80 p-0"
												>
													<div className="border-b border-border/60 px-3 py-2">
														<p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
															{t("historyTitle")}
														</p>
													</div>
													<div className="max-h-72 overflow-y-auto p-1.5">
														{historyQuery.isLoading ? (
															<div className="space-y-2 p-1.5">
																<Skeleton className="h-4 w-full" />
																<Skeleton className="h-4 w-2/3" />
															</div>
														) : historyQuery.isError ? (
															<p className="px-1.5 py-2 text-sm text-destructive">
																{t(
																	"historyError",
																)}
															</p>
														) : (historyQuery.data
																?.history
																.length ??
																0) === 0 ? (
															<p className="px-1.5 py-2 text-sm text-muted-foreground">
																{t(
																	"historyEmpty",
																)}
															</p>
														) : (
															<ul className="space-y-1">
																{historyQuery.data?.history.map(
																	(entry) =>
																		renderHistoryEntry(
																			entry,
																		),
																)}
															</ul>
														)}
													</div>
												</PopoverContent>
											</Popover>
											{/* Edit description (pencil). */}
											{canEdit && (
												<Tooltip>
													<TooltipTrigger asChild>
														<button
															type="button"
															onClick={
																startEditingDescription
															}
															aria-label={t(
																"editDescription",
															)}
															className="rounded p-0.5 text-muted-foreground/60 transition-colors hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
														>
															<PencilIcon
																aria-hidden="true"
																className="size-3.5"
															/>
														</button>
													</TooltipTrigger>
													<TooltipContent>
														{t("editDescription")}
													</TooltipContent>
												</Tooltip>
											)}
											{/* Regenerate the AI version (a user
											    override still wins). */}
											{description && (
												<Tooltip>
													<TooltipTrigger asChild>
														<button
															type="button"
															onClick={() =>
																setShowRegenerate(
																	(v) => !v,
																)
															}
															aria-label={t(
																"regenerateAi",
															)}
															aria-expanded={
																showRegenerate
															}
															className="rounded p-0.5 text-muted-foreground/60 transition-colors hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
														>
															<RefreshCwIcon
																aria-hidden="true"
																className="size-3.5"
															/>
														</button>
													</TooltipTrigger>
													<TooltipContent>
														{t("regenerateAi")}
													</TooltipContent>
												</Tooltip>
											)}
										</div>
									)}
								</div>

								{showRegenerate && !editingDescription && (
									<div className="mb-3 space-y-2 rounded-lg border border-border/60 bg-muted/30 p-3">
										<label
											htmlFor="regenerate-instructions"
											className="text-xs text-muted-foreground"
										>
											{t("regenerateInstructions")}
										</label>
										<textarea
											id="regenerate-instructions"
											value={regenerateInstructions}
											onChange={(e) =>
												setRegenerateInstructions(
													e.target.value,
												)
											}
											rows={2}
											placeholder={t(
												"regenerateInstructionsPlaceholder",
											)}
											className={cn(
												"w-full resize-none rounded-md border border-input bg-background px-3 py-1.5 text-sm outline-none",
												"focus-visible:ring-2 focus-visible:ring-ring",
												"placeholder:text-muted-foreground",
											)}
										/>
										{isUserDescription && (
											<p className="text-[11px] leading-relaxed text-muted-foreground">
												{t("regenerateOverrideNote")}
											</p>
										)}
										<div className="flex items-center gap-2">
											<Button
												type="button"
												size="sm"
												onClick={() =>
													describeMutation.mutate({
														projectId,
														analysisId,
														mode,
														key: nodeKey,
														instructions:
															regenerateInstructions.trim() ||
															undefined,
														organizationId:
															organizationId ??
															null,
													})
												}
												disabled={
													describeMutation.isPending
												}
												className="gap-1.5"
											>
												{describeMutation.isPending ? (
													<Loader2Icon
														aria-hidden="true"
														className="size-3.5 motion-safe:animate-spin"
													/>
												) : (
													<SparklesIcon
														aria-hidden="true"
														className="size-3.5"
													/>
												)}
												{t("regenerateSubmit")}
											</Button>
											<Button
												type="button"
												size="sm"
												variant="ghost"
												onClick={() => {
													setShowRegenerate(false);
													setRegenerateInstructions(
														"",
													);
												}}
											>
												{t("regenerateCancel")}
											</Button>
										</div>
									</div>
								)}

								{editingDescription ? (
									<div className="space-y-2">
										<Textarea
											value={descDraft}
											onChange={(e) =>
												setDescDraft(e.target.value)
											}
											rows={7}
											aria-label={t("editDescription")}
											placeholder={t("editPlaceholder")}
											className="resize-y text-sm"
										/>
										<div className="flex flex-wrap items-center gap-2">
											<Button
												type="button"
												size="sm"
												onClick={saveDescription}
												disabled={
													!descDraft.trim() ||
													isSavingOverride
												}
												className="gap-1.5"
											>
												{isSavingOverride ? (
													<Loader2Icon
														aria-hidden="true"
														className="size-3.5 motion-safe:animate-spin"
													/>
												) : (
													<CheckIcon
														aria-hidden="true"
														className="size-3.5"
													/>
												)}
												{t("editSave")}
											</Button>
											<Button
												type="button"
												size="sm"
												variant="ghost"
												onClick={() => {
													setEditingDescription(
														false,
													);
													setDescDraft("");
												}}
												disabled={isSavingOverride}
											>
												{t("editCancel")}
											</Button>
											{isUserDescription && (
												<Button
													type="button"
													size="sm"
													variant="ghost"
													onClick={clearDescription}
													disabled={isSavingOverride}
													className="ml-auto gap-1.5 text-muted-foreground"
												>
													<Undo2Icon
														aria-hidden="true"
														className="size-3.5"
													/>
													{t("editClear")}
												</Button>
											)}
										</div>
									</div>
								) : description ? (
									<>
										<div
											className={cn(
												"prose prose-sm dark:prose-invert max-w-none text-sm text-foreground",
												!descExpanded &&
													isLongDescription &&
													"line-clamp-[7]",
											)}
										>
											<ReactMarkdown
												remarkPlugins={[remarkGfm]}
											>
												{description}
											</ReactMarkdown>
										</div>
										{isLongDescription && (
											<button
												type="button"
												onClick={() =>
													setDescExpanded((v) => !v)
												}
												className="mt-1 text-xs font-medium text-primary transition-colors hover:text-primary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
											>
												{descExpanded
													? t("showLess")
													: t("showMore")}
											</button>
										)}
										{isUserDescription && (
											<div className="mt-2.5 space-y-1">
												<Badge
													variant="outline"
													className="gap-1 text-muted-foreground"
												>
													<PencilIcon
														aria-hidden="true"
														className="size-3"
													/>
													{t("editedByYou")}
												</Badge>
												<p className="text-xs leading-relaxed text-muted-foreground">
													{t("editedDescriptionHint")}
												</p>
											</div>
										)}
									</>
								) : canDescribe ? (
									<div className="rounded-lg border border-dashed border-border/70 bg-muted/40 p-3">
										<p className="mb-2 text-sm text-muted-foreground">
											{t("noDescriptionFile")}
										</p>
										<Button
											type="button"
											size="sm"
											variant="outline"
											onClick={() =>
												describeMutation.mutate({
													projectId,
													analysisId,
													mode,
													key: nodeKey,
													organizationId:
														organizationId ?? null,
												})
											}
											disabled={
												describeMutation.isPending
											}
											className="gap-1.5"
										>
											{describeMutation.isPending ? (
												<Loader2Icon
													aria-hidden="true"
													className="size-4 motion-safe:animate-spin"
												/>
											) : (
												<SparklesIcon
													aria-hidden="true"
													className="size-4"
												/>
											)}
											{t("describeWithAi")}
										</Button>
									</div>
								) : (
									<p className="text-sm italic text-muted-foreground">
										{t("noDescription")}
									</p>
								)}
							</div>

							{/* Stat pills: files / links */}
							<div className="grid grid-cols-2 gap-2">
								<div className="flex items-center gap-2 rounded-lg bg-muted/60 px-3 py-2">
									<FilesIcon
										aria-hidden="true"
										className="size-3.5 shrink-0 text-muted-foreground"
									/>
									<span className="font-semibold text-sm text-foreground tabular-nums">
										{typeof fileCount === "number"
											? fileCount
											: typeof loc === "number"
												? loc
												: 0}
									</span>
									<span className="text-xs text-muted-foreground">
										{typeof fileCount !== "number" &&
										typeof loc === "number"
											? t("statLines")
											: t("statFiles")}
									</span>
								</div>
								<div className="flex items-center gap-2 rounded-lg bg-muted/60 px-3 py-2">
									<LinkIcon
										aria-hidden="true"
										className="size-3.5 shrink-0 text-muted-foreground"
									/>
									<span className="font-semibold text-sm text-foreground tabular-nums">
										{linkCount}
									</span>
									<span className="text-xs text-muted-foreground">
										{t("statLinks")}
									</span>
								</div>
							</div>

							{/* Heavier detail tucked behind a disclosure */}
							{hasDetails && (
								<div className="border-t border-border/60 pt-3">
									<button
										type="button"
										onClick={() =>
											setShowDetails((v) => !v)
										}
										aria-expanded={showDetails}
										className="flex w-full items-center justify-between gap-2 text-[11px] uppercase tracking-[0.16em] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
									>
										{t("moreDetails")}
										<ChevronDownIcon
											aria-hidden="true"
											className={cn(
												"size-3.5 transition-transform",
												showDetails && "rotate-180",
											)}
										/>
									</button>
									{showDetails && (
										<div className="mt-3 space-y-4">
											{metricEntries.length > 0 && (
												<div>
													<p className="mb-1.5 text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
														{t("metricsTitle")}
													</p>
													<dl className="grid grid-cols-2 gap-2">
														{metricEntries.map(
															(metric) => (
																<div
																	key={
																		metric.key
																	}
																	className="rounded-lg bg-muted/50 px-3 py-2"
																>
																	<dt className="text-[11px] text-muted-foreground">
																		{
																			metric.label
																		}
																	</dt>
																	<dd className="font-medium text-sm text-foreground tabular-nums">
																		{
																			metric.value
																		}
																	</dd>
																</div>
															),
														)}
													</dl>
												</div>
											)}
											{renderChipSection(
												t("dependsOnLabel"),
												dependsOn,
												showAllDeps,
												setShowAllDeps,
											)}
											{renderChipSection(
												t("usedByLabel"),
												usedBy,
												showAllUsedBy,
												setShowAllUsedBy,
											)}
											{detail?.documentation && (
												<div>
													<p className="mb-1.5 flex items-center gap-1.5 text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
														<FileTextIcon
															aria-hidden="true"
															className="size-3.5"
														/>
														{t("documentation")}
													</p>
													<div
														className={cn(
															"rounded-lg border border-border/50 bg-muted/30 px-4 py-3",
															"prose prose-sm dark:prose-invert max-w-none text-sm text-foreground",
														)}
													>
														<ReactMarkdown
															remarkPlugins={[
																remarkGfm,
															]}
														>
															{
																detail.documentation
															}
														</ReactMarkdown>
													</div>
												</div>
											)}
										</div>
									)}
								</div>
							)}
						</>
					)}
				</div>
			</ScrollArea>

			{detail && (
				<footer className="border-t border-border/60 p-3">
					<Button
						type="button"
						variant="default"
						size="sm"
						onClick={() => onAskAi(nodeKey, detail.label)}
						className="w-full gap-1.5"
					>
						<MessageSquarePlusIcon
							aria-hidden="true"
							className="size-4"
						/>
						{t("askAi")}
					</Button>
				</footer>
			)}
		</section>
	);
}
