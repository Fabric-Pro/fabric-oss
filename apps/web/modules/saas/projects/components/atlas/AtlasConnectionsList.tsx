"use client";

/**
 * Shared CONNECTIONS list — the edge analogue of the solo graph's node list.
 * Rendered inside BOTH the solo graph toolbar disclosure and the System-map
 * toolbar disclosure (the host owns the [Nodes | Connections] segmented toggle
 * and the search box; this component renders the Connections-mode body for a
 * given search query).
 *
 * Each row: a kind dot (per-kind token colour), `source → target`, and a
 * description snippet. Fuzzy search runs across both endpoint labels + the
 * description. Clicking a row selects that edge (opens the edge panel in the
 * host). A "Show deleted" checkbox flips the parent's `includeDeleted` state (so
 * the graph/systemGraph query refetches with soft-deleted edges); deleted rows
 * render struck-through with a Restore button. A "+ New connection" button opens
 * an inline create form (two searchable node pickers + a kind select + optional
 * description → `createEdge`).
 *
 * Host-agnostic: the host adapts its own edges into `ConnectionRow[]` and nodes
 * into `ConnectionNodeOption[]`, and supplies the localised kind labels + the
 * create handler.
 */
import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@ui/components/command";
import { Label } from "@ui/components/label";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ui/components/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
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
	ChevronsUpDownIcon,
	InfoIcon,
	Loader2Icon,
	PlusIcon,
	Undo2Icon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { type CSSProperties, useId, useMemo, useState } from "react";
import {
	type ConnectionNodeOption,
	type ConnectionRow,
	edgeKindColorVar,
} from "./atlas-edges";
import { fuzzyScore } from "./atlas-utils";

export interface ConnectionsCreateInput {
	source: ConnectionNodeOption;
	target: ConnectionNodeOption;
	kind: string;
	description: string;
}

interface AtlasConnectionsListProps {
	/** Live search query (owned by the host's shared search box). */
	query: string;
	/** Normalised connection rows for the active graph. */
	connections: ConnectionRow[];
	/** Pickable nodes for the create form's source/target selects. */
	nodes: ConnectionNodeOption[];
	/** Kind options for the create form's kind select. */
	kindOptions: string[];
	/** Localised label for an edge kind. */
	kindLabel: (kind: string) => string;
	/** Lifted "include soft-deleted edges" state (drives the parent's refetch). */
	includeDeleted: boolean;
	onIncludeDeletedChange: (next: boolean) => void;
	/** Select a connection → host opens the edge panel for it. */
	onSelectConnection: (row: ConnectionRow) => void;
	/** Restore a soft-deleted connection inline from the list. */
	onRestoreConnection: (row: ConnectionRow) => void;
	/** Create a new manual connection. Resolves when the mutation settles. */
	onCreateConnection: (input: ConnectionsCreateInput) => Promise<void> | void;
	/** True while a create/restore mutation is in flight (disables the form). */
	isMutating: boolean;
}

/** One searchable node picker (source or target) for the create form. */
function NodePicker({
	value,
	onChange,
	nodes,
	placeholder,
	searchPlaceholder,
	emptyLabel,
	ariaLabel,
	excludeKey,
}: {
	value: ConnectionNodeOption | null;
	onChange: (node: ConnectionNodeOption) => void;
	nodes: ConnectionNodeOption[];
	placeholder: string;
	searchPlaceholder: string;
	emptyLabel: string;
	ariaLabel: string;
	excludeKey?: string;
}) {
	const [open, setOpen] = useState(false);
	const options = useMemo(
		() => nodes.filter((n) => n.key !== excludeKey),
		[nodes, excludeKey],
	);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<button
					type="button"
					aria-label={ariaLabel}
					aria-expanded={open}
					className="flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
				>
					<span
						className={cn(
							"min-w-0 flex-1 truncate text-left",
							!value && "text-muted-foreground",
						)}
					>
						{value ? value.label : placeholder}
					</span>
					<ChevronsUpDownIcon
						aria-hidden="true"
						className="size-4 shrink-0 opacity-50"
					/>
				</button>
			</PopoverTrigger>
			<PopoverContent
				align="start"
				className="w-[var(--radix-popover-trigger-width)] p-0"
			>
				<Command>
					<CommandInput placeholder={searchPlaceholder} />
					<CommandList>
						<CommandEmpty>{emptyLabel}</CommandEmpty>
						<CommandGroup>
							{options.map((node) => (
								<CommandItem
									key={node.key}
									value={`${node.label} ${node.key}`}
									onSelect={() => {
										onChange(node);
										setOpen(false);
									}}
									className="gap-2"
								>
									<CheckIcon
										aria-hidden="true"
										className={cn(
											"size-4 shrink-0",
											value?.key === node.key
												? "opacity-100"
												: "opacity-0",
										)}
									/>
									<span className="min-w-0 flex-1 truncate">
										{node.label}
									</span>
								</CommandItem>
							))}
						</CommandGroup>
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}

export function AtlasConnectionsList({
	query,
	connections,
	nodes,
	kindOptions,
	kindLabel,
	includeDeleted,
	onIncludeDeletedChange,
	onSelectConnection,
	onRestoreConnection,
	onCreateConnection,
	isMutating,
}: AtlasConnectionsListProps) {
	const t = useTranslations("projects.atlas.connections");
	const formId = useId();
	const [showCreate, setShowCreate] = useState(false);
	const [source, setSource] = useState<ConnectionNodeOption | null>(null);
	const [target, setTarget] = useState<ConnectionNodeOption | null>(null);
	const [kind, setKind] = useState<string>(kindOptions[0] ?? "RELATES_TO");
	const [createDescription, setCreateDescription] = useState("");

	const normalizedQuery = query.trim().toLowerCase();

	// Fuzzy match across both endpoint labels + the description, best-ranked
	// first. With no query, preserve the incoming order (active first, then any
	// deleted rows the host appended).
	const displayed = useMemo(() => {
		if (!normalizedQuery) {
			return connections;
		}
		const scored: { row: ConnectionRow; score: number }[] = [];
		for (const row of connections) {
			const haystack = `${row.sourceLabel} ${row.targetLabel} ${row.description ?? ""}`;
			const score = fuzzyScore(normalizedQuery, haystack);
			if (score !== null) {
				scored.push({ row, score });
			}
		}
		scored.sort((a, b) => b.score - a.score);
		return scored.map((s) => s.row);
	}, [connections, normalizedQuery]);

	const canCreate =
		!!source && !!target && source.key !== target.key && !!kind;

	const resetCreate = () => {
		setShowCreate(false);
		setSource(null);
		setTarget(null);
		setKind(kindOptions[0] ?? "RELATES_TO");
		setCreateDescription("");
	};

	const submitCreate = async () => {
		if (!canCreate || !source || !target) {
			return;
		}
		await onCreateConnection({
			source,
			target,
			kind,
			description: createDescription.trim(),
		});
		resetCreate();
	};

	return (
		<div className="flex flex-col">
			{/* Controls: Show deleted + New connection. */}
			<div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-border/60 bg-background/95 px-3 py-2 backdrop-blur-sm">
				<div className="flex items-center gap-2">
					<Checkbox
						id={`${formId}-show-deleted`}
						checked={includeDeleted}
						onCheckedChange={(c) =>
							onIncludeDeletedChange(c === true)
						}
					/>
					<Label
						htmlFor={`${formId}-show-deleted`}
						className="cursor-pointer text-xs font-normal text-muted-foreground"
					>
						{t("showDeleted")}
					</Label>
					{/* Brief "what is a connection?" explainer. */}
					<Popover>
						<PopoverTrigger asChild>
							<button
								type="button"
								aria-label={t("info")}
								className="grid size-6 place-items-center rounded-md text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							>
								<InfoIcon
									aria-hidden="true"
									className="size-3.5"
								/>
							</button>
						</PopoverTrigger>
						<PopoverContent
							align="start"
							className="w-72 space-y-1.5"
						>
							<p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
								{t("infoTitle")}
							</p>
							<p className="text-xs leading-relaxed text-foreground">
								{t("infoBody")}
							</p>
						</PopoverContent>
					</Popover>
				</div>
				<Button
					type="button"
					variant="outline"
					size="sm"
					aria-expanded={showCreate}
					aria-controls={formId}
					onClick={() => setShowCreate((v) => !v)}
					disabled={nodes.length < 2}
					className="gap-1.5"
				>
					<PlusIcon aria-hidden="true" className="size-4" />
					{t("newConnection")}
				</Button>
			</div>

			{/* Inline create form. */}
			{showCreate && (
				<div
					id={formId}
					className="space-y-2.5 border-b border-border/60 bg-muted/30 p-3"
				>
					<div className="space-y-1">
						<Label className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
							{t("createSource")}
						</Label>
						<NodePicker
							value={source}
							onChange={setSource}
							nodes={nodes}
							excludeKey={target?.key}
							placeholder={t("createSelectNode")}
							searchPlaceholder={t("createSearchNodes")}
							emptyLabel={t("createNoNodes")}
							ariaLabel={t("createSource")}
						/>
					</div>
					<div className="space-y-1">
						<Label className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
							{t("createTarget")}
						</Label>
						<NodePicker
							value={target}
							onChange={setTarget}
							nodes={nodes}
							excludeKey={source?.key}
							placeholder={t("createSelectNode")}
							searchPlaceholder={t("createSearchNodes")}
							emptyLabel={t("createNoNodes")}
							ariaLabel={t("createTarget")}
						/>
					</div>
					<div className="space-y-1">
						<Label className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
							{t("createKind")}
						</Label>
						<Select value={kind} onValueChange={setKind}>
							<SelectTrigger aria-label={t("createKind")}>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{kindOptions.map((option) => (
									<SelectItem key={option} value={option}>
										<span className="flex items-center gap-2">
											<span
												aria-hidden="true"
												className="size-2 rounded-full"
												style={{
													background:
														edgeKindColorVar(
															option,
														),
												}}
											/>
											{kindLabel(option)}
										</span>
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					<div className="space-y-1">
						<Label className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
							{t("createDescription")}
						</Label>
						<Textarea
							value={createDescription}
							onChange={(e) =>
								setCreateDescription(e.target.value)
							}
							rows={2}
							placeholder={t("createDescriptionPlaceholder")}
							className="resize-y text-sm"
						/>
					</div>
					<div className="flex items-center gap-2">
						<Button
							type="button"
							size="sm"
							onClick={submitCreate}
							disabled={!canCreate || isMutating}
							className="gap-1.5"
						>
							{isMutating ? (
								<Loader2Icon
									aria-hidden="true"
									className="size-3.5 motion-safe:animate-spin"
								/>
							) : (
								<PlusIcon
									aria-hidden="true"
									className="size-3.5"
								/>
							)}
							{t("createSubmit")}
						</Button>
						<Button
							type="button"
							size="sm"
							variant="ghost"
							onClick={resetCreate}
							disabled={isMutating}
						>
							{t("createCancel")}
						</Button>
					</div>
				</div>
			)}

			{/* Connection rows. */}
			<ul className="flex flex-col p-1">
				{displayed.length === 0 && (
					<li className="px-3 py-3 text-sm text-muted-foreground">
						{connections.length === 0 ? t("empty") : t("noMatches")}
					</li>
				)}
				{displayed.map((row) => {
					const color = edgeKindColorVar(row.kind);
					return (
						<li key={row.id}>
							<div className="flex items-stretch gap-1">
								<button
									type="button"
									onClick={() => onSelectConnection(row)}
									className={cn(
										"flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
										row.deleted && "opacity-70",
									)}
								>
									<span className="flex w-full min-w-0 items-center gap-1.5">
										<span
											aria-hidden="true"
											className="size-1.5 shrink-0 rounded-full"
											style={
												{
													background: color,
												} as CSSProperties
											}
										/>
										<span
											className={cn(
												"min-w-0 flex-1 truncate text-sm font-medium text-foreground",
												row.deleted && "line-through",
											)}
										>
											{row.sourceLabel}
										</span>
										<ArrowRightIcon
											aria-hidden="true"
											className="size-3 shrink-0 text-muted-foreground"
										/>
										<span
											className={cn(
												"min-w-0 flex-1 truncate text-sm font-medium text-foreground",
												row.deleted && "line-through",
											)}
										>
											{row.targetLabel}
										</span>
									</span>
									<span className="flex w-full items-center gap-1.5 pl-3">
										<span className="shrink-0 text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
											{kindLabel(row.kind)}
										</span>
										{row.description && (
											<span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
												· {row.description}
											</span>
										)}
									</span>
								</button>
								{row.deleted && row.endpoints && (
									<Tooltip>
										<TooltipTrigger asChild>
											<button
												type="button"
												onClick={() =>
													onRestoreConnection(row)
												}
												disabled={isMutating}
												aria-label={t("restore")}
												className="flex shrink-0 items-center rounded-lg px-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
											>
												<Undo2Icon
													aria-hidden="true"
													className="size-3.5"
												/>
											</button>
										</TooltipTrigger>
										<TooltipContent>
											{t("restore")}
										</TooltipContent>
									</Tooltip>
								)}
							</div>
						</li>
					);
				})}
			</ul>
		</div>
	);
}
