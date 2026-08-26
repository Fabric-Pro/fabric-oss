"use client";

/**
 * Create-vs-Enrich routing control for one row of a backlog proposal.
 *
 * Backend routing (`route-action-items.ts` in @repo/temporal) has already
 * classified each action item captured from a meeting or monitored chat as a
 * new ticket or as extra detail for one the project already has. This control
 * is where the reviewer sees that call — with the matched ticket and how
 * confident the system was — and overrides it if it is wrong.
 *
 * Lives in its own file rather than inside `BacklogChangeProposal.tsx`, which
 * is already well past the size where another feature can be folded in.
 */

import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@ui/components/command";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ui/components/popover";
import { cn } from "@ui/lib";
import {
	AlertTriangleIcon,
	CheckIcon,
	ChevronsUpDownIcon,
	FilePlus2Icon,
	MergeIcon,
} from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { ProposalDiffField } from "./ProposalDiffField";

/**
 * Drafting stages that mean a ticket is closed or archived. Mirrors
 * `TERMINAL_DRAFTING_STAGES` on the backend — routing never auto-targets one,
 * but a reviewer may deliberately pick one, behind the warning below.
 */
const TERMINAL_STAGES = new Set(["CLOSED", "DECLINED"]);

type RoutingAlternative = {
	storyId: string;
	identifier: string;
	title: string;
	similarity: number;
};

export type RoutingAnnotation = {
	decision: "create" | "enrich";
	confidence: number;
	matchedStoryId?: string | null;
	matchedIdentifier?: string | null;
	matchedTitle?: string | null;
	reasoning?: string | null;
	/**
	 * The action item as captured, before an enrich adopted the target's title
	 * and before the body was merged against it. This — not the row's current
	 * content — is what an override re-submits.
	 */
	proposedTitle?: string | null;
	proposedDescription?: string | null;
	proposedAcceptanceCriteria?: string | null;
	alternatives?: RoutingAlternative[];
	overridden?: boolean;
	error?: string | null;
};

/**
 * The reviewer's override for one row. `undefined` anywhere means "no override"
 * — the backend decision stands.
 */
export type RoutingOverride = {
	decision: "create" | "enrich";
	/** Required when `decision` is "enrich"; approval is blocked until it is set. */
	target?: {
		storyId: string;
		identifier: string;
		title: string;
		closed: boolean;
	};
	/** The reviewer explicitly accepted a closed/archived target. */
	closedTargetConfirmed?: boolean;
	/**
	 * Set when this override exists ONLY because the system's matched ticket has
	 * been closed since the proposal was written — the reviewer chose nothing.
	 * Keeps the "Overridden" badge honest while still routing the now-closed
	 * target through the same warn-and-confirm path as a hand-picked one.
	 */
	systemTargetWentStale?: boolean;
};

export type EffectiveRouting = {
	decision: "create" | "enrich";
	targetStoryId?: string;
	targetIdentifier?: string;
	targetTitle?: string;
	targetClosed: boolean;
	confidence: number;
	overridden: boolean;
};

/**
 * Fold the backend annotation and the reviewer's override into the routing that
 * will actually be applied. Pure, and exported so the parent computes the same
 * answer for the approve payload and the Apply gate without duplicating the
 * rule — and without needing the story list this control loads.
 *
 * Closed-target knowledge rides on `override.target.closed`. The picker sets it
 * from live data, and the control installs an override for a system-matched
 * target that has since been closed, so this stays a pure function of what it
 * is handed.
 */
export function resolveEffectiveRouting(
	routing: RoutingAnnotation | undefined,
	override: RoutingOverride | undefined,
): EffectiveRouting | undefined {
	if (!routing) {
		return undefined;
	}
	const targetStoryId = override
		? override.target?.storyId
		: (routing.matchedStoryId ?? undefined);
	return {
		decision: override ? override.decision : routing.decision,
		targetStoryId,
		targetIdentifier: override
			? override.target?.identifier
			: (routing.matchedIdentifier ?? undefined),
		targetTitle: override
			? override.target?.title
			: (routing.matchedTitle ?? undefined),
		targetClosed: override?.target?.closed ?? false,
		confidence: routing.confidence,
		// A stale-closed override changes no routing choice, so it must not read
		// as the reviewer having overridden anything.
		overridden: !!override && !override.systemTargetWentStale,
	};
}

/**
 * Why a row cannot be approved yet, or `null` when it can. Exported and used by
 * the parent's Apply gate so the button's disabled state and the row's inline
 * message always agree.
 */
export function routingBlocker(
	routing: RoutingAnnotation | undefined,
	override: RoutingOverride | undefined,
): "target-required" | "closed-target-unconfirmed" | null {
	const effective = resolveEffectiveRouting(routing, override);
	if (!effective || effective.decision !== "enrich") {
		return null;
	}
	if (!effective.targetStoryId) {
		return "target-required";
	}
	if (effective.targetClosed && !override?.closedTargetConfirmed) {
		return "closed-target-unconfirmed";
	}
	return null;
}

/** Three coarse bands — a raw 0..1 score reads as false precision. */
function confidenceBand(value: number): {
	label: string;
	className: string;
} {
	if (value >= 0.85) {
		return { label: "High confidence", className: "text-secondary" };
	}
	if (value >= 0.7) {
		// `text-highlight` is #d97706 in light mode — ~2.95:1 on the stone
		// background, under AA's 4.5:1. The surrounding file already uses this
		// darker amber for inline warning text for the same reason.
		return {
			label: "Medium confidence",
			className: "text-amber-700 dark:text-highlight",
		};
	}
	return { label: "Low confidence", className: "text-muted-foreground" };
}

type PickerStory = {
	id: string;
	identifier: string;
	title: string;
	draftingStage?: string | null;
};

type Props = {
	routing: RoutingAnnotation;
	override: RoutingOverride | undefined;
	onOverrideChange: (next: RoutingOverride | undefined) => void;
	projectId?: string;
	organizationId?: string | null;
	disabled?: boolean;
	/** Used to label controls uniquely when several rows are on screen. */
	itemTitle: string;
};

export function ProposalRoutingControl({
	routing,
	override,
	onOverrideChange,
	projectId,
	organizationId,
	disabled,
	itemTitle,
}: Props) {
	const [pickerOpen, setPickerOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [showClosed, setShowClosed] = useState(false);
	// Ties the closed-target warning to the controls it constrains, so a screen
	// reader announces WHY the picker and the confirm button are there rather
	// than leaving the explanation as unassociated text between them.
	const warningId = useId();

	const effective = resolveEffectiveRouting(routing, override);
	const blocker = routingBlocker(routing, override);

	// The project's tickets: the override picker's options, and the live
	// lifecycle state behind the closed-target warning. Fetched for any
	// enrichment row (not only when the picker opens) because the warning has
	// to fire before the reviewer thinks to look. One query key for the whole
	// proposal, so several routed rows share a single request.
	const isEnrich = effective?.decision === "enrich";
	const { data, isLoading } = useQuery({
		...orpc.projects.stories.list.queryOptions({
			input: {
				projectId: projectId ?? "",
				organizationId: organizationId ?? null,
			},
		}),
		enabled: (pickerOpen || isEnrich) && !!projectId,
		staleTime: 60_000,
	});

	// A system-matched target that has been closed since the proposal was
	// written. Routing only ever targets active tickets, but analysis and review
	// can be hours apart, so this is the one path by which an enrichment can
	// reach a closed ticket without anyone choosing it.
	const staleClosedTarget =
		!override &&
		isEnrich &&
		routing.matchedStoryId &&
		((data?.stories ?? []) as PickerStory[]).some(
			(story) =>
				story.id === routing.matchedStoryId &&
				TERMINAL_STAGES.has(story.draftingStage ?? ""),
		);

	// Convert it into an explicit override carrying `closed: true`, so the same
	// warn-and-confirm path — and the same pure Apply gate — handles it. Marked
	// `systemTargetWentStale` so the row does not claim the reviewer overrode
	// anything.
	useEffect(() => {
		if (!staleClosedTarget || !routing.matchedStoryId) {
			return;
		}
		onOverrideChange({
			decision: "enrich",
			target: {
				storyId: routing.matchedStoryId,
				identifier: routing.matchedIdentifier ?? "",
				title: routing.matchedTitle ?? "",
				closed: true,
			},
			systemTargetWentStale: true,
		});
	}, [
		staleClosedTarget,
		routing.matchedStoryId,
		routing.matchedIdentifier,
		routing.matchedTitle,
		onOverrideChange,
	]);

	// Re-targeted enrichment: the row's own diff was merged against the ticket
	// the system picked, so it describes the wrong ticket now. Re-run the same
	// structure-preserving merge against the chosen one and diff THAT. Only
	// fetched when the reviewer has actually re-targeted — an unmodified
	// enrichment already carries an accurate diff from analysis time.
	const previewTargetId =
		effective?.decision === "enrich" && effective.overridden
			? effective.targetStoryId
			: undefined;
	const { data: preview, isLoading: previewLoading } = useQuery({
		...orpc.projects.stories.previewEnrichment.queryOptions({
			input: {
				projectId: projectId ?? "",
				organizationId: organizationId ?? null,
				targetStoryId: previewTargetId ?? "",
				proposedDescription: routing.proposedDescription ?? undefined,
				proposedAcceptanceCriteria:
					routing.proposedAcceptanceCriteria ?? undefined,
				reasoning: routing.reasoning ?? undefined,
			},
		}),
		enabled: !!previewTargetId && !!projectId,
		staleTime: 60_000,
	});

	/**
	 * Whether a ticket is closed or archived RIGHT NOW, per the loaded list.
	 * Every target this control hands upward is stamped through here, so the
	 * closed-target warning survives a Create → Enrich → Create round trip
	 * instead of being reset to `false` by whichever code path rebuilt the
	 * target last.
	 */
	const isClosedNow = (storyId: string): boolean =>
		((data?.stories ?? []) as PickerStory[]).some(
			(story) =>
				story.id === storyId &&
				TERMINAL_STAGES.has(story.draftingStage ?? ""),
		);

	const suggestedIds = useMemo(
		() => new Set((routing.alternatives ?? []).map((alt) => alt.storyId)),
		[routing.alternatives],
	);

	const { suggested, others } = useMemo(() => {
		const stories = (data?.stories ?? []) as PickerStory[];
		const needle = query.trim().toLowerCase();
		const matches = (story: PickerStory) =>
			needle.length === 0 ||
			story.title.toLowerCase().includes(needle) ||
			story.identifier.toLowerCase().includes(needle);

		const visible = stories.filter((story) => {
			const closed = TERMINAL_STAGES.has(story.draftingStage ?? "");
			return (showClosed || !closed) && matches(story);
		});

		// The backend shortlist leads, in its ranked order — it is the answer to
		// "which ticket did the system think this was about", which is exactly
		// what a reviewer overriding the target is looking for.
		const byId = new Map(visible.map((story) => [story.id, story]));
		const suggestedRows = (routing.alternatives ?? [])
			.map((alt) => byId.get(alt.storyId))
			.filter((story): story is PickerStory => story !== undefined);

		return {
			suggested: suggestedRows,
			others: visible.filter((story) => !suggestedIds.has(story.id)),
		};
	}, [data?.stories, query, showClosed, routing.alternatives, suggestedIds]);

	const setDecision = (decision: "create" | "enrich") => {
		if (decision === "create") {
			onOverrideChange(
				routing.decision === "create" ? undefined : { decision },
			);
			return;
		}
		// Switching to Enrich keeps whatever target is already in play — the
		// system's match when there is one — so a Create→Enrich→Create→Enrich
		// round trip does not silently discard it. The closed flag is re-derived
		// from live state on the way through: rebuilding the target from the
		// annotation alone would quietly drop it and re-enable approval on a
		// ticket the team has closed.
		const target = override?.target ?? currentSystemTarget(routing);
		onOverrideChange({
			decision: "enrich",
			target: target
				? { ...target, closed: isClosedNow(target.storyId) }
				: undefined,
			closedTargetConfirmed: override?.closedTargetConfirmed,
		});
	};

	const pickTarget = (story: PickerStory) => {
		onOverrideChange({
			decision: "enrich",
			target: {
				storyId: story.id,
				identifier: story.identifier,
				title: story.title,
				closed: TERMINAL_STAGES.has(story.draftingStage ?? ""),
			},
			// A different target needs its own acknowledgement.
			closedTargetConfirmed: false,
		});
		setQuery("");
		setPickerOpen(false);
	};

	const band = confidenceBand(routing.confidence);

	return (
		<div className="mt-2 space-y-2 rounded-md border border-dashed bg-muted/30 p-2">
			{/* Evaluation failed — say so rather than letting the fallback Create
			    read as a considered decision. */}
			{routing.error ? (
				<p className="flex items-start gap-1.5 text-destructive text-xs">
					<AlertTriangleIcon
						aria-hidden="true"
						className="mt-0.5 size-3.5 shrink-0"
					/>
					<span>
						Could not check this against existing tickets, so it is
						proposed as a new one. Review it against the backlog
						before approving.
					</span>
				</p>
			) : null}

			<div className="flex flex-wrap items-center gap-2">
				<span className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
					Routing
				</span>
				{/* A real <fieldset> rather than role="group": the two buttons
				    are a single mutually-exclusive choice, and a screen reader
				    announces the legend before either option so the reader
				    knows WHICH item's routing they are changing. */}
				<fieldset className="m-0 inline-flex overflow-hidden rounded-md border p-0">
					<legend className="sr-only">Routing for {itemTitle}</legend>
					<RoutingToggle
						active={!isEnrich}
						disabled={disabled}
						icon={<FilePlus2Icon className="size-3.5" />}
						label="New ticket"
						onClick={() => setDecision("create")}
					/>
					<RoutingToggle
						active={!!isEnrich}
						disabled={disabled}
						icon={<MergeIcon className="size-3.5" />}
						label="Enrich existing"
						onClick={() => setDecision("enrich")}
					/>
				</fieldset>
				{!routing.error && (
					<span className={cn("text-xs", band.className)}>
						{band.label}
					</span>
				)}
				{effective?.overridden && (
					<Badge variant="outline" className="text-[10px]">
						Overridden
					</Badge>
				)}
			</div>

			{isEnrich ? (
				<div className="space-y-2">
					<div className="flex flex-wrap items-center gap-2">
						<span className="text-muted-foreground text-xs">
							Target
						</span>
						<Popover open={pickerOpen} onOpenChange={setPickerOpen}>
							<PopoverTrigger asChild disabled={disabled}>
								<Button
									type="button"
									variant="outline"
									size="sm"
									role="combobox"
									aria-expanded={pickerOpen}
									aria-label={
										effective?.targetClosed
											? `Choose the ticket to enrich for ${itemTitle}. Current target ${effective.targetIdentifier ?? ""} is closed or archived.`
											: `Choose the ticket to enrich for ${itemTitle}`
									}
									aria-describedby={
										blocker === "closed-target-unconfirmed"
											? warningId
											: undefined
									}
									className={cn(
										"h-7 max-w-full justify-between font-normal",
										!effective?.targetStoryId &&
											"text-muted-foreground",
									)}
								>
									<span className="min-w-0 truncate text-xs">
										{effective?.targetIdentifier
											? `${effective.targetIdentifier} · ${effective.targetTitle ?? ""}`
											: "Select a ticket"}
									</span>
									<ChevronsUpDownIcon
										aria-hidden="true"
										className="ml-2 size-3.5 shrink-0 opacity-50"
									/>
								</Button>
							</PopoverTrigger>
							<PopoverContent
								align="start"
								// Clamped: this control also renders inside the
								// narrower AI-Update sidebar and on small viewports,
								// where a fixed 384px popover overflows.
								className="w-96 max-w-[calc(100vw-2rem)] p-0"
							>
								{/* Ranking is the backend shortlist's, so cmdk's own
								    fuzzy filter must stay out of the way. */}
								<Command shouldFilter={false}>
									<CommandInput
										value={query}
										onValueChange={setQuery}
										placeholder="Search tickets…"
									/>
									<CommandList>
										{isLoading ? (
											<div className="py-6 text-center text-muted-foreground text-sm">
												Loading tickets…
											</div>
										) : (
											<>
												<CommandEmpty>
													No matching tickets.
												</CommandEmpty>
												{suggested.length > 0 && (
													<CommandGroup heading="Suggested">
														{suggested.map(
															(story) => (
																<TargetRow
																	key={
																		story.id
																	}
																	story={
																		story
																	}
																	selected={
																		effective?.targetStoryId ===
																		story.id
																	}
																	onSelect={
																		pickTarget
																	}
																/>
															),
														)}
													</CommandGroup>
												)}
												<CommandGroup heading="All tickets">
													{others.map((story) => (
														<TargetRow
															key={story.id}
															story={story}
															selected={
																effective?.targetStoryId ===
																story.id
															}
															onSelect={
																pickTarget
															}
														/>
													))}
												</CommandGroup>
											</>
										)}
									</CommandList>
									<div className="border-t p-1">
										<Button
											type="button"
											variant="ghost"
											size="sm"
											aria-pressed={showClosed}
											onClick={() =>
												setShowClosed((prev) => !prev)
											}
											className="w-full justify-start font-normal text-muted-foreground text-xs"
										>
											<CheckIcon
												aria-hidden="true"
												className={cn(
													"mr-2 size-3.5",
													showClosed
														? "opacity-100"
														: "opacity-0",
												)}
											/>
											Include closed tickets
										</Button>
									</div>
								</Command>
							</PopoverContent>
						</Popover>
					</div>

					{routing.reasoning && !effective?.overridden && (
						<p className="text-muted-foreground text-xs">
							{routing.reasoning}
						</p>
					)}

					{/* Re-targeted enrichment: what would change on the ticket
					    the reviewer chose. Announced, because choosing a target
					    closes the popover and returns focus to the trigger — the
					    diff then appears below, out of the reader's path. */}
					<div aria-live="polite">
						{previewTargetId &&
							(previewLoading ? (
								<p className="text-muted-foreground text-xs">
									Working out what would change on{" "}
									{effective?.targetIdentifier}…
								</p>
							) : preview ? (
								preview.fallbackUsed ? (
									<p className="text-muted-foreground text-xs">
										The description of{" "}
										{preview.targetIdentifier} would be kept
										as-is — this detail could not be merged
										into it safely.
									</p>
								) : (
									<div className="space-y-1">
										{preview.currentDescription !==
											preview.mergedDescription && (
											<ProposalDiffField
												label="Description"
												from={
													preview.currentDescription
												}
												to={preview.mergedDescription}
											/>
										)}
										{preview.currentAcceptanceCriteria !==
											preview.mergedAcceptanceCriteria && (
											<ProposalDiffField
												label="Acceptance criteria"
												from={
													preview.currentAcceptanceCriteria
												}
												to={
													preview.mergedAcceptanceCriteria
												}
											/>
										)}
									</div>
								)
							) : null)}
					</div>

					{/* Only for a SELECTED row: a deselected row is excluded from
					    the Apply gate, so a red "you must fix this" beside an
					    enabled Apply is a straight contradiction. */}
					{blocker === "target-required" && !disabled && (
						<p className="text-destructive text-xs">
							Select the ticket to enrich before approving.
						</p>
					)}

					{blocker === "closed-target-unconfirmed" && !disabled && (
						<div className="space-y-1.5 rounded border border-highlight/40 bg-highlight/10 p-2">
							<p
								id={warningId}
								className="flex items-start gap-1.5 text-xs"
							>
								<AlertTriangleIcon
									aria-hidden="true"
									className="mt-0.5 size-3.5 shrink-0 text-amber-700 dark:text-highlight"
								/>
								<span>
									{effective?.targetIdentifier} is closed or
									archived. Enriching it will reopen the
									conversation on work the team has already
									finished.
								</span>
							</p>
							<Button
								type="button"
								size="sm"
								variant="outline"
								className="h-7 text-xs"
								disabled={disabled}
								aria-describedby={warningId}
								onClick={() =>
									onOverrideChange({
										decision: "enrich",
										target: override?.target,
										closedTargetConfirmed: true,
									})
								}
							>
								Enrich it anyway
							</Button>
						</div>
					)}
				</div>
			) : (
				routing.reasoning &&
				!routing.error && (
					<p className="text-muted-foreground text-xs">
						{routing.reasoning}
					</p>
				)
			)}
		</div>
	);
}

/**
 * The system's own match, as an override target shape. `closed` is a
 * placeholder the caller overwrites from live state — routing never auto-targets
 * a terminal ticket, but one can be closed between analysis and review.
 */
function currentSystemTarget(
	routing: RoutingAnnotation,
): RoutingOverride["target"] {
	if (!routing.matchedStoryId || !routing.matchedIdentifier) {
		return undefined;
	}
	return {
		storyId: routing.matchedStoryId,
		identifier: routing.matchedIdentifier,
		title: routing.matchedTitle ?? "",
		closed: false,
	};
}

function RoutingToggle({
	active,
	disabled,
	icon,
	label,
	onClick,
}: {
	active: boolean;
	disabled?: boolean;
	icon: React.ReactNode;
	label: string;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			aria-pressed={active}
			disabled={disabled}
			onClick={onClick}
			className={cn(
				"inline-flex items-center gap-1.5 px-2 py-1 text-xs transition-colors",
				active
					? "bg-primary text-primary-foreground"
					: "bg-transparent text-muted-foreground hover:bg-accent",
				disabled && "cursor-not-allowed opacity-50",
			)}
		>
			{icon}
			{label}
		</button>
	);
}

function TargetRow({
	story,
	selected,
	onSelect,
}: {
	story: PickerStory;
	selected: boolean;
	onSelect: (story: PickerStory) => void;
}) {
	const closed = TERMINAL_STAGES.has(story.draftingStage ?? "");
	return (
		<CommandItem value={story.id} onSelect={() => onSelect(story)}>
			<CheckIcon
				aria-hidden="true"
				className={cn(
					"mr-1 size-4 shrink-0",
					selected ? "opacity-100" : "opacity-0",
				)}
			/>
			<span className="shrink-0 font-mono text-muted-foreground text-xs tabular-nums">
				{story.identifier}
			</span>
			<span className="min-w-0 flex-1 truncate">{story.title}</span>
			{closed && (
				<span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
					closed
				</span>
			)}
		</CommandItem>
	);
}
