"use client";

/**
 * Compact detail card for the currently-selected graph CONNECTION (edge) — the
 * edge analogue of `AtlasNodePanel`. It floats over the map (solo graph
 * and System map) with the same docking/overlay pattern the node panel uses.
 *
 * Shows: a kind badge tinted by the edge's design token, the
 * `sourceLabel → targetLabel` pairing, the connection description (view, with an
 * inline edit textarea → `updateEdge`), a "Manual" / "Edited" badge, a
 * collapsible edit History (lazy `edgeHistory`), and a footer that soft-deletes
 * (`deleteEdge`) or restores (`restoreEdge`) the connection. Every mutation
 * invalidates the relevant graph / systemGraph query so all surfaces re-read, and
 * calls `onChanged` so the host can drop its selection when the edge disappears.
 *
 * Read-only edges (e.g. a System-map repo-group endpoint that the backend can't
 * key an override to) pass `endpoints={null}` — the description still shows but
 * the edit / delete affordances are hidden.
 */
import type { EdgeOverrideHistoryEntry, GraphMode } from "@repo/atlas/types";
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
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Skeleton } from "@ui/components/skeleton";
import { Textarea } from "@ui/components/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	ArrowRightIcon,
	CheckIcon,
	ClockIcon,
	Loader2Icon,
	PencilIcon,
	Trash2Icon,
	Undo2Icon,
	XIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { edgeKindColorVar, type EdgeEndpoints } from "./atlas-edges";
import { formatRelativeTime } from "./atlas-utils";

interface AtlasEdgePanelProps {
	projectId: string;
	mode: GraphMode;
	/**
	 * The endpoint selector for this edge, or null when the edge isn't
	 * user-editable (e.g. a System-map repo-group endpoint). Read-only when null.
	 */
	endpoints: EdgeEndpoints | null;
	kind: string;
	sourceLabel: string;
	targetLabel: string;
	/** Human label for the edge kind (already localised by the host). */
	kindLabel: string;
	/**
	 * Selectable connection types (value + localised label). When provided on an
	 * editable edge, the panel shows a Type selector that RE-TYPES the connection
	 * (`updateEdge` with `isUserKind`). Omit to hide the selector.
	 */
	kindOptions?: { value: string; label: string }[];
	description: string | null;
	isManual: boolean;
	isUserDescription: boolean;
	deleted: boolean;
	onClose: () => void;
	/** Called after any successful mutation so the host can refetch / drop selection. */
	onChanged: (event: { deleted?: boolean; restored?: boolean }) => void;
	/**
	 * When provided, DELETE is STAGED locally (drafted, persisted on the canvas's
	 * Save) instead of mutating immediately. The host stages the endpoints and
	 * closes the panel. Description edits and restore remain immediate regardless.
	 */
	onStageDelete?: (endpoints: EdgeEndpoints) => void;
}

const DESCRIPTION_CLAMP_CHARS = 360;

export function AtlasEdgePanel({
	projectId,
	mode,
	endpoints,
	kind,
	sourceLabel,
	targetLabel,
	kindLabel,
	kindOptions,
	description,
	isManual,
	isUserDescription,
	deleted,
	onClose,
	onChanged,
	onStageDelete,
}: AtlasEdgePanelProps) {
	const t = useTranslations("projects.atlas.edgePanel");
	const { organizationId } = useOrganizationContext();
	const queryClient = useQueryClient();
	const headingRef = useRef<HTMLHeadingElement>(null);
	const [editing, setEditing] = useState(false);
	const [descDraft, setDescDraft] = useState("");
	const [descExpanded, setDescExpanded] = useState(false);
	const [historyOpen, setHistoryOpen] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);

	// A stable selection signature so opening a different edge resets the panel's
	// per-edge disclosures + draft to the compact resting state.
	const selectionKey = endpoints
		? `${endpoints.sourceRepositoryIntegrationId ?? "_"}:${endpoints.sourceKey}->${endpoints.targetRepositoryIntegrationId ?? "_"}:${endpoints.targetKey}`
		: `${sourceLabel}->${targetLabel}`;
	useEffect(() => {
		headingRef.current?.focus();
		setEditing(false);
		setDescDraft("");
		setDescExpanded(false);
		setHistoryOpen(false);
		setConfirmDelete(false);
	}, [selectionKey]);

	const accent = edgeKindColorVar(kind);

	// Tenant + endpoint identity reused by the mutations and the (lazy) history
	// query. Null endpoints → no mutation/history wiring (read-only edge).
	const baseInput = endpoints
		? {
				projectId,
				mode,
				sourceRepositoryIntegrationId:
					endpoints.sourceRepositoryIntegrationId,
				sourceKey: endpoints.sourceKey,
				targetRepositoryIntegrationId:
					endpoints.targetRepositoryIntegrationId,
				targetKey: endpoints.targetKey,
				organizationId: organizationId ?? null,
			}
		: null;

	const historyQuery = useQuery({
		...orpc.atlas.edgeHistory.queryOptions({
			// `baseInput` is non-null whenever `enabled` is true.
			input: baseInput ?? ({} as never),
		}),
		enabled: historyOpen && baseInput !== null,
	});

	// Invalidate BOTH graph reads — an edge edit can land in either host, and the
	// connections list mirror reads the same cache. The history (when open)
	// re-reads too so a fresh edit row appears immediately.
	const invalidateGraphs = () => {
		queryClient.invalidateQueries({
			queryKey: orpc.atlas.graph.key(),
		});
		queryClient.invalidateQueries({
			queryKey: orpc.atlas.systemGraph.key(),
		});
		if (baseInput) {
			queryClient.invalidateQueries({
				queryKey: orpc.atlas.edgeHistory.queryKey({
					input: baseInput,
				}),
			});
		}
	};

	const updateMutation = useMutation(
		orpc.atlas.updateEdge.mutationOptions({
			onSuccess: () => {
				invalidateGraphs();
				setEditing(false);
				onChanged({});
			},
		}),
	);
	const deleteMutation = useMutation(
		orpc.atlas.deleteEdge.mutationOptions({
			onSuccess: () => {
				invalidateGraphs();
				setConfirmDelete(false);
				onChanged({ deleted: true });
			},
		}),
	);
	const restoreMutation = useMutation(
		orpc.atlas.restoreEdge.mutationOptions({
			onSuccess: () => {
				invalidateGraphs();
				onChanged({ restored: true });
			},
		}),
	);

	const isBusy =
		updateMutation.isPending ||
		deleteMutation.isPending ||
		restoreMutation.isPending;
	const editable = baseInput !== null;

	const startEditing = () => {
		setDescDraft(description ?? "");
		setHistoryOpen(false);
		setConfirmDelete(false);
		setEditing(true);
	};
	const saveDescription = () => {
		if (!baseInput) {
			return;
		}
		const next = descDraft.trim();
		updateMutation.mutate({
			...baseInput,
			kind,
			userDescription: next.length > 0 ? next : null,
		});
	};
	const clearDescription = () => {
		if (!baseInput) {
			return;
		}
		updateMutation.mutate({ ...baseInput, kind, userDescription: null });
	};
	// Re-type the connection: persist the chosen kind with `isUserKind` so the read
	// overlay applies it over the detected AI/structural kind. Description untouched.
	const changeKind = (nextKind: string) => {
		if (!baseInput || nextKind === kind) {
			return;
		}
		updateMutation.mutate({
			...baseInput,
			kind: nextKind,
			isUserKind: true,
		});
	};

	// Delete: STAGE it (drafted, persisted on the canvas's Save) when the host
	// supplies `onStageDelete`; otherwise fall back to the immediate mutation.
	const handleDelete = () => {
		if (!endpoints) {
			return;
		}
		if (onStageDelete) {
			onStageDelete(endpoints);
			setConfirmDelete(false);
			onChanged({ deleted: true });
			return;
		}
		if (baseInput) {
			deleteMutation.mutate(baseInput);
		}
	};

	const isLongDescription =
		!!description && description.length > DESCRIPTION_CLAMP_CHARS;

	const renderHistoryEntry = (entry: EdgeOverrideHistoryEntry) => (
		<li
			key={entry.id}
			className="rounded-md px-1.5 py-1.5 transition-colors hover:bg-muted/50"
		>
			<div className="flex items-center justify-between gap-2">
				<span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
					{t(`historyAction.${entry.action}`)}
				</span>
				<span className="shrink-0 text-[11px] text-muted-foreground">
					{formatRelativeTime(entry.createdAt)}
				</span>
			</div>
			{/* Description edits show old → new; lifecycle actions (created /
			    deleted / restored) carry no value diff, so only the verb + time. */}
			{entry.action === "description" && (
				<p className="mt-1 line-clamp-3 break-words text-xs leading-relaxed">
					<span className="text-muted-foreground line-through">
						{entry.oldValue?.trim() || "—"}
					</span>
					<span
						aria-hidden="true"
						className="mx-1 text-muted-foreground"
					>
						→
					</span>
					<span className="text-foreground">
						{entry.newValue?.trim() || "—"}
					</span>
				</p>
			)}
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
				<div className="-ml-0.5 flex min-w-0 flex-1 items-center gap-2">
					<span
						aria-hidden="true"
						className="size-2.5 shrink-0 rounded-full"
						style={{ background: accent }}
					/>
					<span
						className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-[0.16em]"
						style={{ color: accent }}
					>
						{kindLabel}
					</span>
					{deleted && (
						<Badge
							variant="outline"
							className="shrink-0 gap-1 text-muted-foreground"
						>
							{t("deletedBadge")}
						</Badge>
					)}
				</div>
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
					{/* Endpoints: source → target */}
					<div>
						<h3
							ref={headingRef}
							tabIndex={-1}
							className="flex flex-wrap items-center gap-1.5 font-serif text-lg leading-tight text-foreground focus-visible:outline-none"
						>
							<span className="break-words">{sourceLabel}</span>
							<ArrowRightIcon
								aria-hidden="true"
								className="size-4 shrink-0 text-muted-foreground"
							/>
							<span className="break-words">{targetLabel}</span>
						</h3>
						{(isManual || isUserDescription) && (
							<div className="mt-1.5 flex flex-wrap gap-1.5">
								{isManual && (
									<Badge
										variant="outline"
										className="gap-1 text-muted-foreground"
									>
										{t("manualBadge")}
									</Badge>
								)}
								{isUserDescription && (
									<Badge
										variant="outline"
										className="gap-1 text-muted-foreground"
									>
										<PencilIcon
											aria-hidden="true"
											className="size-3"
										/>
										{t("editedBadge")}
									</Badge>
								)}
							</div>
						)}
					</div>

					{/* Type — RE-TYPE the connection (applies over the detected kind). */}
					{editable &&
						kindOptions &&
						kindOptions.length > 0 &&
						!deleted && (
							<div>
								<p className="mb-1.5 text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
									{t("type")}
								</p>
								<Select
									value={kind}
									onValueChange={changeKind}
									disabled={isBusy}
								>
									<SelectTrigger
										aria-label={t("type")}
										className="h-9"
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{kindOptions.map((option) => (
											<SelectItem
												key={option.value}
												value={option.value}
											>
												<span className="flex items-center gap-2">
													<span
														aria-hidden="true"
														className="size-2 shrink-0 rounded-full"
														style={{
															background:
																edgeKindColorVar(
																	option.value,
																),
														}}
													/>
													{option.label}
												</span>
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
						)}

					{/* Description — editable (when not read-only), with history. */}
					<div>
						<div className="mb-1.5 flex items-center justify-between gap-2">
							<p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
								{t("description")}
							</p>
							{!editing && (
								<div className="flex items-center gap-0.5">
									{editable && (
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
															{t("historyError")}
														</p>
													) : (historyQuery.data
															?.history.length ??
															0) === 0 ? (
														<p className="px-1.5 py-2 text-sm text-muted-foreground">
															{t("historyEmpty")}
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
									)}
									{editable && !deleted && (
										<Tooltip>
											<TooltipTrigger asChild>
												<button
													type="button"
													onClick={startEditing}
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
								</div>
							)}
						</div>

						{editing ? (
							<div className="space-y-2">
								<Textarea
									value={descDraft}
									onChange={(e) =>
										setDescDraft(e.target.value)
									}
									rows={6}
									aria-label={t("editDescription")}
									placeholder={t("editPlaceholder")}
									className="resize-y text-sm"
								/>
								<div className="flex flex-wrap items-center gap-2">
									<Button
										type="button"
										size="sm"
										onClick={saveDescription}
										disabled={isBusy}
										className="gap-1.5"
									>
										{updateMutation.isPending ? (
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
											setEditing(false);
											setDescDraft("");
										}}
										disabled={isBusy}
									>
										{t("editCancel")}
									</Button>
									{isUserDescription && (
										<Button
											type="button"
											size="sm"
											variant="ghost"
											onClick={clearDescription}
											disabled={isBusy}
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
								<p
									className={cn(
										"whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground",
										!descExpanded &&
											isLongDescription &&
											"line-clamp-[7]",
									)}
								>
									{description}
								</p>
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
							</>
						) : (
							<p className="text-sm italic text-muted-foreground">
								{editable
									? t("noDescriptionEditable")
									: t("noDescription")}
							</p>
						)}
					</div>
				</div>
			</ScrollArea>

			{/* Footer: delete (with confirm) / restore. Hidden for read-only edges. */}
			{editable && (
				<footer className="border-t border-border/60 p-3">
					{deleted ? (
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => restoreMutation.mutate(baseInput)}
							disabled={isBusy}
							className="w-full gap-1.5"
						>
							{restoreMutation.isPending ? (
								<Loader2Icon
									aria-hidden="true"
									className="size-4 motion-safe:animate-spin"
								/>
							) : (
								<Undo2Icon
									aria-hidden="true"
									className="size-4"
								/>
							)}
							{t("restore")}
						</Button>
					) : confirmDelete ? (
						<div className="space-y-2">
							<p className="text-xs text-muted-foreground">
								{t("deleteConfirmBody")}
							</p>
							<div className="flex items-center gap-2">
								<Button
									type="button"
									variant="destructive"
									size="sm"
									onClick={handleDelete}
									disabled={isBusy}
									className="gap-1.5"
								>
									{deleteMutation.isPending ? (
										<Loader2Icon
											aria-hidden="true"
											className="size-4 motion-safe:animate-spin"
										/>
									) : (
										<Trash2Icon
											aria-hidden="true"
											className="size-4"
										/>
									)}
									{t("deleteConfirm")}
								</Button>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={() => setConfirmDelete(false)}
									disabled={isBusy}
								>
									{t("deleteCancel")}
								</Button>
							</div>
						</div>
					) : (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => setConfirmDelete(true)}
							disabled={isBusy}
							className="w-full gap-1.5 text-destructive hover:text-destructive"
						>
							<Trash2Icon aria-hidden="true" className="size-4" />
							{t("delete")}
						</Button>
					)}
				</footer>
			)}
		</section>
	);
}
