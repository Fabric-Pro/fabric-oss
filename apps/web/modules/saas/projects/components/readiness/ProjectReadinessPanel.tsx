"use client";

/**
 * The one row that does not behave like the others (Fizzy #2457, R15 / R21).
 *
 * Two departures, both scoped to this key alone.
 *
 * Its audience is decided by an ORGANIZATION role. Creating an API key sits on
 * organization roles and on no project role at all, and creating a project
 * seeds no `ProjectMember` rows — so `canAct`, which answers a project-role
 * question, is false for the ordinary organization members this row exists for,
 * and the panel would hand them the read-only label instead of the one action
 * they can take.
 *
 * And its action opens the issuing view in place rather than navigating. The
 * key's secret is returned exactly once, so no page reached by a link can
 * render the finished configuration. The rule still carries a `target` because
 * the rule type and the CTA drift test require one; it is not meant to be
 * followed, and this row never uses it.
 *
 * Imported, not restated: the same string is the rule's own key and the row
 * both readiness procedures special-case, and a fifth copy here is a fifth
 * chance for one of them to be edited alone — a mismatch nothing would report,
 * because every reader simply stops matching a row that still exists. The
 * module it comes from is deliberately import-free, so a client component can
 * read it without dragging a server module into the browser bundle.
 */
import { useAnalytics } from "@analytics";
import { CLI_ITEM_KEY } from "@repo/api/modules/projects/lib/readiness/thresholds";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { ConnectCliDialog } from "@saas/projects/components/cli-connection/ConnectCliDialog";
import { CLI_CHECKLIST_KEY_ISSUED_EVENT } from "@saas/projects/components/cli-connection/lib/cli-connection-nudge";
import {
	resolveProjectTabs,
	useProjectTabCustomization,
	useProjectTabGates,
} from "@saas/projects/lib/project-tab-preferences";
import { tabs as PROJECT_TABS } from "@saas/projects/lib/project-tabs";
import {
	buildReadinessActionHref,
	dispatchReadinessItemAction,
} from "@saas/projects/lib/readiness-actions";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ui/components/collapsible";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { formatDistanceToNow } from "date-fns";
import {
	ArrowRightIcon,
	CheckCircle2Icon,
	CheckIcon,
	ChevronDownIcon,
	ChevronUpIcon,
	ClockIcon,
	FileTextIcon,
	FolderGit2Icon,
	FolderOpenIcon,
	KanbanIcon,
	LayersIcon,
	Link2Icon,
	Loader2Icon,
	type LucideIcon,
	MessageSquareIcon,
	MinusCircleIcon,
	MoreHorizontalIcon,
	ShieldCheckIcon,
	SparklesIcon,
	TerminalIcon,
	UsersIcon,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
	type ReadinessItem,
	useProjectReadiness,
} from "./ProjectReadinessProvider";

/**
 * The readiness panel (Fizzy #2165).
 *
 * Mounted in the project route-group layout so it appears above every project
 * page and PUSHES CONTENT DOWN rather than overlaying it — that is an explicit
 * acceptance criterion, and it is why this is a normal block element with no
 * absolute positioning.
 *
 * Shows the next three to five active gaps by default. "Active" is doing real
 * work there: an item hidden behind an unmet dependency, or snoozed by this
 * user, is not a gap they can act on and does not appear.
 */

const DEFAULT_GAP_COUNT = 5;

/**
 * What the issuing view calls this project when the payload cannot name it.
 *
 * Rarely seen and never for long: the readiness read is already in flight
 * above every project page, and the sentence naming the project is rendered
 * only after a second click inside the view. This is what the flag-disabled
 * payload and a still-loading one leave behind — a slightly vaguer instruction
 * rather than a sentence with a hole in it.
 */
const UNNAMED_PROJECT = "this project";

/**
 * One colour scale for the whole panel (DSU review, 20 Aug).
 *
 * The meter, the level word and every resolved-state chip read from this, so a
 * glance at any one of them carries the same signal. Before this they were
 * independently styled and the panel could show an amber rollup above a row of
 * uniformly grey chips.
 */
/**
 * Mirrors the `projectPhase` enum on the update route. Declared locally rather
 * than imported so this client component keeps no dependency on a server module.
 */
type ProjectPhase = "DISCOVERY_PLANNING" | "DEVELOPMENT_EXECUTION";

/**
 * One colour scale for the whole panel, keyed to the readiness level.
 *
 * `destructive`, not `primary`, for NOT_READY, and `success`, not `secondary`,
 * for READY. The running theme resolves `--primary` to a teal (#0d9488) and
 * `--secondary` to a light neutral surface (#f1f3f6), so painting "not ready"
 * with `primary` read as green and painting "ready" with `secondary` read as
 * grey. Semantic status tokens (`destructive`, `highlight`, `success`) give
 * every level an unambiguous signal.
 */
const LEVEL_TONE = {
	READY: "bg-success",
	PARTIALLY_READY: "bg-highlight",
	NOT_READY: "bg-destructive",
} as const;

const LEVEL_BADGE = {
	READY: "success",
	PARTIALLY_READY: "warning",
	NOT_READY: "destructive",
} as const;

/**
 * Category-matched DuBois workspace icons for active readiness items, replacing
 * uniform empty circles that looked like inert radio controls.
 */
function itemCategoryIcon(item: ReadinessItem): LucideIcon {
	if (item.key === CLI_ITEM_KEY) {
		return TerminalIcon;
	}
	if (item.key === "codebase-connected" || item.key === "atlas-explored") {
		return FolderGit2Icon;
	}
	if (item.key === "security-scan") {
		return ShieldCheckIcon;
	}
	if (item.key === "release-notes") {
		return SparklesIcon;
	}
	if (
		item.key === "chat-app-connected" ||
		item.key === "work-capture-chat" ||
		item.key === "meeting-transcripts" ||
		item.key === "work-capture-transcripts"
	) {
		return MessageSquareIcon;
	}
	if (
		item.key === "pm-system-connected" ||
		item.key === "pm-sync-enabled" ||
		item.key === "terminal-statuses" ||
		item.key === "wiki-connected" ||
		item.key === "knowledge-base"
	) {
		return Link2Icon;
	}
	switch (item.category) {
		case "DOCUMENTS":
			return FileTextIcon;
		case "ROADMAP":
			return KanbanIcon;
		case "MEMBERS":
			return UsersIcon;
		case "PROJECT_BASICS":
			return LayersIcon;
		default:
			return FolderOpenIcon;
	}
}

const NEED_RANK = {
	MUST: 0,
	SHOULD: 1,
	COULD: 2,
	NOT_APPLICABLE: 3,
} as const;

/**
 * Rule keys are kebab-case so they read as stable identifiers; translation keys
 * are camelCase to match the rest of the message catalogue.
 */
function toCamel(key: string): string {
	return key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Where an item's call-to-action points (Checklist AC-4).
 *
 * Each CTA opens the actual editor, creation dialog, or settings section that
 * satisfies the item — never a passive coach-mark tour that dims the page and
 * snaps focus back on dismiss.
 */
function readinessTargetHref(
	projectBasePath: string,
	target: ReadinessItem["target"],
	itemKey: string,
): string {
	return buildReadinessActionHref(projectBasePath, target, itemKey);
}

function handleTargetClick(
	projectId: string,
	target: ReadinessItem["target"],
	itemKey: string,
) {
	dispatchReadinessItemAction(projectId, target, itemKey);
}

/**
 * How long a snooze can run for (Checklist AC-8, which asks for a chosen
 * duration rather than a fixed one).
 *
 * Presets rather than a date picker: the question a person is answering is
 * "when should this nag me again", and they think in "next week", not in
 * calendar dates. The stored value is still an absolute instant, so nothing
 * downstream has to know these existed.
 */
const SNOOZE_DURATIONS = [
	{ labelKey: "snoozeOneDay", days: 1 },
	{ labelKey: "snoozeThreeDays", days: 3 },
	{ labelKey: "snoozeOneWeek", days: 7 },
	{ labelKey: "snoozeTwoWeeks", days: 14 },
	{ labelKey: "snoozeOneMonth", days: 30 },
] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

function snoozeUntilFrom(days: number): Date {
	return new Date(Date.now() + days * DAY_MS);
}

/**
 * "6 days" — how much longer this item stays quiet. A bare "Snoozed" gives no
 * way to tell a snooze that lapses tomorrow from one that lapses next month,
 * which is exactly what someone deciding whether to lift it needs to know.
 */
function snoozeRemaining(until: string | Date | null): string | null {
	if (!until) {
		return null;
	}
	const date = until instanceof Date ? until : new Date(until);
	if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) {
		return null;
	}
	return formatDistanceToNow(date);
}

/**
 * The panel in its proper home: the banner slot beneath the project title, the
 * same position the code-analysis banner occupies. Pages that have a title area
 * render this.
 */
export function ProjectReadinessPanel() {
	const readiness = useProjectReadiness();
	const claim = readiness?.claimInlineSlot;
	useEffect(() => claim?.(), [claim]);
	return <ReadinessPanelBody />;
}

/**
 * The fallback for the ~11 standalone project routes that render their own page
 * with no title area — the document editor, the feature workspace, Security and
 * friends. Renders from the route-group layout, above everything, and stands
 * down as soon as a page has claimed the better slot.
 */
export function ProjectReadinessPanelSlot() {
	const readiness = useProjectReadiness();
	if (readiness?.hasInlineSlot) {
		return null;
	}
	return <ReadinessPanelBody />;
}

function ReadinessPanelBody() {
	const t = useTranslations("readiness");
	const readiness = useProjectReadiness();
	// AC-8. Without this the panel only ever shows the next few gaps, so there is
	// no way to see what is already done, snoozed or marked not applicable —
	// which makes the checklist unauditable.
	const [showAll, setShowAll] = useState(false);
	const [lockedOpen, setLockedOpen] = useState(false);
	// A per-viewer "not yet" on the phase-transition offer. Browser-local on
	// purpose: declining the suggestion is not a fact about the project, and one
	// person deferring it should not hide it from their teammates.
	const [transitionDismissed, setTransitionDismissed] = useState(false);
	// The issuing view's open state, held HERE rather than on the row — see
	// where the view is mounted, at the foot of this component.
	const [connectCliOpen, setConnectCliOpen] = useState(false);
	const { organizationId, organizationSlug } = useOrganizationContext();
	const { trackEvent } = useAnalytics();
	const projectId = readiness?.projectId ?? "";
	// Mirrors the `/app` and `/app/{slug}` convention the rest of the SaaS shell
	// uses; same construction as ProjectContextsList's deep links.
	const projectBasePath = organizationSlug
		? `/app/${organizationSlug}/projects/${projectId}`
		: `/app/projects/${projectId}`;

	// `until: null` lifts the snooze — one mutation covers setting, changing and
	// clearing, because they are the same question with different answers.
	const snooze = useMutation({
		mutationFn: (args: { itemKey: string; until: Date | null }) =>
			orpcClient.projects.readiness.snooze({
				projectId: readiness?.projectId ?? "",
				itemKey: args.itemKey,
				until: args.until,
				organizationId: organizationId ?? null,
			}),
		onSuccess: () => readiness?.refetch(),
	});

	// An assumed phase is a guess the panel is grading against, so the correction
	// has to be one click away from the sentence that admits it. The link this
	// replaces sent people to Settings and left them to find the field — on the
	// 20 Aug review it read as a dead control. Nothing is written until someone
	// picks a value: an assumed phase must never persist as a chosen one.
	/**
	 * The tabs THIS viewer can reach.
	 *
	 * A checklist item routes to a tab id, but the tab bar is filtered per
	 * viewer — a feature flag, admin tab config or a personal preference can
	 * remove one — and a `?tab=` naming a tab outside that set falls back to
	 * Overview in silence. The CTA then looks broken: the click registers, the
	 * page does not move, and nothing says why. Shares its cache with the tab
	 * bar's own hook, so this costs no extra requests.
	 */
	const tabCustomization = useProjectTabCustomization({ projectId });
	const tabGates = useProjectTabGates();
	const reachableTabIds = useMemo(
		() =>
			new Set(
				resolveProjectTabs(PROJECT_TABS, {
					config: tabCustomization.config,
					prefs: tabCustomization.prefs,
					gates: tabGates,
				}).map((tab) => tab.id as string),
			),
		[tabCustomization.config, tabCustomization.prefs, tabGates],
	);

	const setPhase = useMutation({
		mutationFn: (projectPhase: ProjectPhase) =>
			orpcClient.projects.update({
				id: readiness?.projectId ?? "",
				projectPhase,
				organizationId: organizationId ?? null,
			}),
		onSuccess: () => readiness?.refetch(),
	});

	useEffect(() => {
		try {
			setTransitionDismissed(
				window.localStorage.getItem(
					`readiness-phase-suggestion-dismissed:${projectId}`,
				) === "1",
			);
		} catch {
			// Private windows and blocked site data both throw here; an
			// undismissed suggestion is the right fallback either way.
			setTransitionDismissed(false);
		}
	}, [projectId]);

	const setNotApplicable = useMutation({
		mutationFn: (args: { itemKey: string; notApplicable: boolean }) =>
			orpcClient.projects.readiness.setNotApplicable({
				projectId: readiness?.projectId ?? "",
				itemKey: args.itemKey,
				notApplicable: args.notApplicable,
				organizationId: organizationId ?? null,
			}),
		onSuccess: () => readiness?.refetch(),
	});

	// The only action here that leaves the product. Fabric composes the
	// message and the person sends it, so the click ends by opening their mail
	// client rather than by reporting a delivery — what happens after the draft
	// opens is not something this page can observe, and it will not claim
	// otherwise.
	const requestHelp = useMutation({
		mutationFn: (itemKey: string) =>
			orpcClient.projects.readiness.requestHelp({
				projectId: readiness?.projectId ?? "",
				itemKey,
				organizationId: organizationId ?? null,
			}),
		onSuccess: (result) => {
			// Assigning `location.href` rather than opening a window: a
			// `mailto:` is handed to the OS mail handler and the page stays
			// where it is, whereas `window.open` leaves a blank tab behind in
			// several browsers.
			if (result.mailto) {
				window.location.href = result.mailto;
			} else {
				// No support address configured — the request is still on the
				// record, and saying so is better than a draft that would be
				// addressed to nobody.
				toast.info(t("panel.helpRequestRecorded"));
			}
			readiness?.refetch();
		},
		onError: () => toast.error(t("panel.helpRequestFailed")),
	});

	if (!readiness) {
		return null;
	}
	const { data, isLoading, isExpanded, setExpanded } = readiness;

	// A skeleton rather than nothing while the first read is in flight: an empty
	// frame that later fills is far less confusing than a panel that pops into
	// existence, and "nothing rendered" is indistinguishable from "broken".
	if (isLoading && !data) {
		return (
			<section
				aria-label="Project readiness"
				aria-busy="true"
				className="overflow-hidden rounded-lg border border-border bg-muted/40"
			>
				<div className="flex flex-col gap-3 px-4 py-3.5 sm:px-5">
					<span className="font-semibold text-muted-foreground text-xs uppercase tracking-wider">
						{t("panel.label")}
					</span>
					<div className="h-1.5 w-full animate-pulse rounded-full bg-border" />
					<div className="flex flex-col gap-2">
						{[0, 1, 2].map((i) => (
							<div
								key={i}
								className="h-6 w-full animate-pulse rounded bg-border/60"
							/>
						))}
					</div>
				</div>
			</section>
		);
	}

	if (!data?.enabled) {
		return null;
	}

	// Prioritise required (`MUST`) gaps ahead of `SHOULD` / `COULD` in the
	// default summary and collapsed strip so "2 required items outstanding"
	// always puts those blockers first instead of burying them below earlier
	// optional rows. `Show all` continues to use server checklist order.
	const mustGapCount = data.activeGaps.filter(
		(i) => i.needLevel === "MUST",
	).length;
	const prioritizedGaps = [...data.activeGaps].sort(
		(a, b) => NEED_RANK[a.needLevel] - NEED_RANK[b.needLevel],
	);

	// Collapsed, the panel used to render nothing at all, leaving only a pill up
	// beside the project title — far from where the panel was, and reading as a
	// status label rather than a handle: "once I collapse it, I don't know that a
	// user would know how to unexpand it."
	//
	// The strip is the panel in one line, in the panel's own place. It restores
	// the handle AND the information: a rail would have been a door with nothing
	// behind it, and readiness would still have stopped existing on collapse. A
	// Ready project gets nothing here — it has nothing to ask for, and the card
	// wants that state compact and quiet.
	if (!isExpanded) {
		if (data.level === "READY") {
			return null;
		}
		return (
			<ReadinessSummaryStrip
				t={t}
				hasUnseenChanges={data.attention.changes.length > 0}
				level={data.level}
				requiredOutstanding={mustGapCount}
				completedCount={data.completedCount}
				totalCount={data.totalCount}
				nextGapKey={prioritizedGaps[0]?.key ?? null}
				onExpand={() => setExpanded(true)}
			/>
		);
	}

	// Show All lists every item the panel is allowed to display, in checklist
	// order. It used to float gaps to the top, which meant an item changed
	// position the moment you completed it — reviewed on 20 Aug and rejected:
	// the sheet's order is the order of the work, so a row that jumps once it is
	// done breaks the reader's map of where they are.
	const visible = data.items.filter((i) => i.isVisible);
	const defaultRows = prioritizedGaps.slice(
		0,
		Math.max(DEFAULT_GAP_COUNT, mustGapCount),
	);
	const rows = showAll ? visible : defaultRows;
	const hiddenCount = Math.max(0, visible.length - defaultRows.length);
	// Tier 1 of the attention rules: a static marker on anything that changed
	// since this person last opened the panel. Never animated, so it survives a
	// reload — a pulse a user missed is gone, and the news with it.
	const changeByKey = new Map(
		data.attention.changes.map((change) => [change.key, change.kind]),
	);

	const visibleKeySet = new Set(visible.map((i) => i.key));
	const blockedItems = data.items.filter(
		(i) => !i.isVisible && i.needLevel !== "NOT_APPLICABLE",
	);
	// Group first-tier locked items by their currently visible prerequisite;
	// deeper chained prerequisites are summarised by count until their upstream
	// step unlocks so the panel stays concise and actionable.
	const firstTierBlockedGroups = [
		...blockedItems
			.reduce((groups, blockedItem) => {
				const prerequisite = blockedItem.blockedBy;
				if (!prerequisite || !visibleKeySet.has(prerequisite)) {
					return groups;
				}
				const existing = groups.get(prerequisite);
				if (existing) {
					existing.push(blockedItem);
				} else {
					groups.set(prerequisite, [blockedItem]);
				}
				return groups;
			}, new Map<string, typeof blockedItems>())
			.entries(),
	];
	const firstTierBlockedCount = firstTierBlockedGroups.reduce(
		(sum, [, items]) => sum + items.length,
		0,
	);
	const chainedBlockedCount = Math.max(
		0,
		blockedItems.length - firstTierBlockedCount,
	);
	const percent =
		data.totalCount === 0
			? 0
			: Math.round((data.completedCount / data.totalCount) * 100);

	/**
	 * Who is offered the "Connect CLI" action (Fizzy #2457, R21).
	 *
	 * `viewerCanCreateKey` is the SERVER's answer to an organization-role
	 * question, resolved in the readiness payload right beside `canAct`. It is
	 * read, not re-derived: this codebase has no client-side permission hook, so
	 * a second comparison here would only be a second chance to disagree with
	 * the procedure that will actually authorise the key.
	 *
	 * The organization id is required as well, because the key is minted against
	 * the organization hosting this project, named explicitly and never taken
	 * from the session's active organization. With none resolved there is
	 * nothing to mint against, so the row keeps the panel's ordinary behaviour
	 * rather than offering an action that could only fail.
	 *
	 * The optional access is a RUNTIME guard, not a type one. `cliConnection` is
	 * non-optional on the payload the provider infers straight from the
	 * procedure's output, so dropping the `?.` would type-check today and still
	 * be wrong: a browser holding this bundle can be answered by a server
	 * running the previous release — both versions serve traffic during a
	 * rollout — and that response carries no `cliConnection` at all. Reading a
	 * field off it then throws inside render and takes the whole panel down,
	 * for a block whose absence should read as "not eligible". Readiness
	 * fixtures written before the block existed are the same shape.
	 */
	const cliActionAvailable =
		data.cliConnection?.viewerCanCreateKey === true &&
		organizationId !== null;

	return (
		<section
			aria-label="Project readiness"
			className="overflow-hidden rounded-lg border border-border bg-card"
		>
			<div className="flex flex-col gap-2 border-border/70 border-b bg-muted/30 px-4 py-2.5 sm:px-5">
				<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
					<div className="flex flex-wrap items-center gap-2">
						<span
							data-testid="readiness-status-dot"
							className={cn(
								"size-2 shrink-0 rounded-full",
								LEVEL_TONE[data.level],
							)}
							aria-hidden="true"
						/>
						<span className="font-semibold text-foreground text-sm tracking-[-0.01em]">
							{t("panel.label")}
						</span>
						{/* The level in words, in the panel itself. The header pill
						    carried it, but a reader looking AT the checklist had to
						    look away from it to learn what it added up to. */}
						<Badge status={LEVEL_BADGE[data.level]}>
							{t(`level.${data.level}` as never)}
						</Badge>
						{/* Say plainly that nobody chose this phase, and offer the
						    correction, rather than presenting a guess as a decision. */}
						{data.phaseSource === "inferred" && (
							<span className="flex flex-wrap items-center gap-1.5 text-muted-foreground text-xs">
								<span aria-hidden="true">·</span>
								<span>{t("panel.assumedPhase")}</span>
								<DropdownMenu>
									<DropdownMenuTrigger asChild>
										<Button
											variant="ghost"
											size="sm"
											className="h-6 px-1.5 font-medium text-foreground text-xs underline decoration-border underline-offset-4 hover:decoration-foreground"
											disabled={
												setPhase.isPending ||
												!data.canAct
											}
										>
											{t("panel.setPhase")}
											<ChevronDownIcon className="ml-0.5 size-3" />
										</Button>
									</DropdownMenuTrigger>
									<DropdownMenuContent align="start">
										<DropdownMenuItem
											onSelect={() =>
												setPhase.mutate(
													"DISCOVERY_PLANNING",
												)
											}
										>
											{t("panel.phaseDiscovery")}
										</DropdownMenuItem>
										<DropdownMenuItem
											onSelect={() =>
												setPhase.mutate(
													"DEVELOPMENT_EXECUTION",
												)
											}
										>
											{t("panel.phaseDevelopment")}
										</DropdownMenuItem>
									</DropdownMenuContent>
								</DropdownMenu>
							</span>
						)}
					</div>
					<div className="ml-auto flex flex-wrap items-center gap-3">
						{mustGapCount > 0 && (
							<span
								className={cn(
									"font-medium text-xs tabular-nums",
									data.level === "NOT_READY"
										? "text-destructive"
										: "text-highlight-ink",
								)}
							>
								{t("panel.requiredOutstanding", {
									count: mustGapCount,
								})}
							</span>
						)}
						<div className="flex items-center gap-2">
							{/* Compact inline meter rather than a full-bleed banner rule. */}
							<div
								className="h-1.5 w-20 overflow-hidden rounded-full bg-muted ring-1 ring-border/60 sm:w-24"
								role="progressbar"
								aria-valuenow={percent}
								aria-valuemin={0}
								aria-valuemax={100}
								aria-label={`${percent}% of readiness items complete`}
							>
								<div
									className={cn(
										"h-full rounded-full motion-safe:transition-[width]",
										LEVEL_TONE[data.level],
									)}
									style={{ width: `${percent}%` }}
								/>
							</div>
							<span className="text-muted-foreground text-xs tabular-nums">
								{t("panel.progress", {
									completed: data.completedCount,
									total: data.totalCount,
									percent,
								})}
							</span>
						</div>
						<Button
							variant="ghost"
							size="sm"
							className="size-7 p-0"
							onClick={() => setExpanded(false)}
							aria-label={t("panel.collapse")}
						>
							<ChevronUpIcon className="size-4" />
						</Button>
					</div>
				</div>

				{/* Read-only viewers have no inline controls, so explain how
				    steps resolve; editors already see direct actions on each row. */}
				{data.level !== "READY" && !data.canAct && (
					<p className="text-muted-foreground text-xs">
						{t("panel.introReadOnly")}
					</p>
				)}

				{/* UI Draft, Phase transition: once Discovery has nothing left
				    owed, offer the next phase rather than leaving the project at
				    Ready against a checklist it has outgrown. */}
				{data.suggestPhaseTransition &&
					!transitionDismissed &&
					data.canAct && (
						<div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-card px-3 py-2 text-sm">
							<span className="text-foreground">
								{t("panel.phaseTransition")}
							</span>
							<div className="ml-auto flex items-center gap-2">
								<Button
									size="sm"
									onClick={() =>
										setPhase.mutate("DEVELOPMENT_EXECUTION")
									}
									disabled={setPhase.isPending}
								>
									{t("panel.switchPhase")}
								</Button>
								<Button
									variant="ghost"
									size="sm"
									onClick={() => {
										setTransitionDismissed(true);
										try {
											window.localStorage.setItem(
												`readiness-phase-suggestion-dismissed:${projectId}`,
												"1",
											);
										} catch {
											// Dismissing for this session only is an
											// acceptable degradation.
										}
									}}
								>
									{t("panel.phaseTransitionDismiss")}
								</Button>
							</div>
						</div>
					)}
			</div>

			<div className="bg-card">
				{rows.length === 0 ? (
					<p className="px-4 py-3 text-muted-foreground text-sm sm:px-5">
						{t("panel.empty")}
					</p>
				) : (
					<ul
						className={cn(
							"bg-border/60",
							showAll
								? "grid grid-cols-1 gap-px"
								: "grid grid-cols-1 gap-px lg:grid-cols-2",
						)}
					>
						{rows.map((item, idx) => {
							/**
							 * The one row singled out (R15 / R21). Everything
							 * below is per-item, in the same shape the
							 * spotlighted rows are special-cased: the row
							 * component stays general and this decides, once,
							 * which behaviour it is handed.
							 *
							 * Two questions, not one. WHICH row this is decides
							 * that its call to action never navigates: its
							 * `target` names the Overview tab only because the
							 * rule type and the CTA drift test require one, and
							 * there is nothing about connecting a coding tool on
							 * that page. WHETHER this viewer may take it is a
							 * separate, organization-role answer. Folded into a
							 * single flag, a project editor without key rights
							 * fell through to the ordinary link branch and got an
							 * enabled "Connect CLI" that walked them to Overview.
							 */
							const isCliRow = item.key === CLI_ITEM_KEY;
							const cliActionOffered =
								isCliRow && cliActionAvailable;
							const isMustGap =
								item.needLevel === "MUST" && !item.isComplete;
							const nonMustRowCount = rows.filter(
								(r) => r.needLevel !== "MUST" || r.isComplete,
							).length;
							const fullWidth = showAll
								? false
								: isMustGap ||
									(mustGapCount === 0 &&
										rows.length % 2 === 1 &&
										idx === 0) ||
									(mustGapCount > 0 &&
										nonMustRowCount % 2 === 1 &&
										idx === rows.length - 1);
							return (
								<ReadinessGapRow
									key={item.key}
									item={item}
									fullWidth={fullWidth}
									compact={!showAll && !isMustGap}
									label={t(
										`items.${toCamel(item.key)}.name` as never,
									)}
									ctaLabel={t(
										item.ctaLabelKey.replace(
											/^readiness\./,
											"",
										) as never,
									)}
									itemDescription={t(
										`items.${toCamel(item.key)}.description` as never,
									)}
									itemTooltip={t(
										`items.${toCamel(item.key)}.tooltip` as never,
									)}
									changeKind={
										changeByKey.get(item.key) ?? null
									}
									itemUnmet={
										item.unmetReason
											? t(
													`items.${toCamel(item.key)}.unmet.${item.unmetReason}` as never,
												)
											: null
									}
									ctaHref={readinessTargetHref(
										projectBasePath,
										item.target,
										item.key,
									)}
									/* The CLI row's action goes nowhere, so
									   there is nothing for the viewer's tab set
									   to make unreachable. Without this, hiding
									   the Overview tab would disable a control
									   that never intended to navigate there. */
									ctaReachable={
										isCliRow ||
										item.target.kind !== "tab" ||
										reachableTabIds.has(item.target.tab)
									}
									onCtaAction={
										cliActionOffered
											? () => setConnectCliOpen(true)
											: undefined
									}
									onCtaClick={() => {
										handleTargetClick(
											projectId,
											item.target,
											item.key,
										);
									}}
									stateLabel={
										item.manualState === "SNOOZED"
											? t("panel.stateSnoozed")
											: item.manualState ===
													"NOT_APPLICABLE"
												? t("panel.stateNotApplicable")
												: item.isComplete
													? t("panel.stateComplete")
													: null
									}
									t={t}
									onSnooze={(until) =>
										snooze.mutate({
											itemKey: item.key,
											until,
										})
									}
									onSetNotApplicable={(notApplicable) =>
										setNotApplicable.mutate({
											itemKey: item.key,
											notApplicable,
										})
									}
									onRequestHelp={() =>
										requestHelp.mutate(item.key)
									}
									canAct={data.canAct}
									/* Answers the call to action ALONE, and only
									   on this row — every other row passes
									   nothing and keeps `canAct`. The two gates
									   answer different questions: `canAct` is the
									   project-role answer to "may this viewer
									   change the item's state", and this is the
									   organization-role answer to "may they take
									   the action the row offers". Folding the
									   second into the first also handed over the
									   item's actions menu, whose "Not
									   applicable" calls a procedure requiring
									   project edit rights — so an organization
									   member downgraded to project viewer, a
									   supported combination, was offered a
									   control the server answers FORBIDDEN.

									   It REPLACES `canAct` rather than widening
									   it, because on this row the project answer
									   is not an answer to this question at all:
									   an editor without organization key rights
									   cannot mint a key, and the action they were
									   handed instead led to the Overview tab the
									   rule names as a placeholder. */
									ctaAvailable={
										isCliRow
											? cliActionAvailable
											: undefined
									}
								/>
							);
						})}
					</ul>
				)}

				{(hiddenCount > 0 || showAll || blockedItems.length > 0) && (
					<Collapsible
						open={lockedOpen}
						onOpenChange={setLockedOpen}
						className="border-border/60 border-t bg-muted/20"
					>
						<div className="flex flex-wrap items-center justify-between gap-2 px-4 py-1.5 sm:px-5">
							<div className="flex flex-wrap items-center gap-2">
								{(hiddenCount > 0 || showAll) && (
									<Button
										variant="ghost"
										size="sm"
										className="h-7 px-2.5 text-xs"
										onClick={() => setShowAll((v) => !v)}
										aria-pressed={showAll}
									>
										{showAll
											? t("panel.showGapsOnly")
											: t("panel.showAll", {
													count: hiddenCount,
												})}
									</Button>
								)}
							</div>
							{blockedItems.length > 0 && (
								<CollapsibleTrigger asChild>
									<Button
										variant="ghost"
										size="sm"
										className="h-7 gap-1 px-2.5 text-muted-foreground text-xs hover:text-foreground"
									>
										{t("panel.lockedToggle", {
											count: blockedItems.length,
										})}
										<ChevronDownIcon
											className={cn(
												"size-3.5 motion-safe:transition-transform",
												lockedOpen && "rotate-180",
											)}
											aria-hidden="true"
										/>
									</Button>
								</CollapsibleTrigger>
							)}
						</div>
						{blockedItems.length > 0 && (
							<CollapsibleContent className="border-border/60 border-t px-4 py-2.5 sm:px-5">
								<dl className="flex flex-col gap-2 text-xs">
									{firstTierBlockedGroups.map(
										([prerequisite, blocked]) => (
											<div
												key={prerequisite}
												className="flex flex-wrap items-baseline gap-x-2 gap-y-1"
											>
												<dt className="font-medium text-foreground">
													{t("panel.lockedAfter", {
														prerequisite: t(
															`items.${toCamel(prerequisite)}.name` as never,
														),
													})}
													:
												</dt>
												<dd className="text-muted-foreground">
													{blocked
														.map((i) =>
															t(
																`items.${toCamel(i.key)}.name` as never,
															),
														)
														.join(" · ")}
												</dd>
											</div>
										),
									)}
									{chainedBlockedCount > 0 && (
										<p className="text-muted-foreground">
											{t("panel.lockedChained", {
												count: chainedBlockedCount,
											})}
										</p>
									)}
								</dl>
							</CollapsibleContent>
						)}
					</Collapsible>
				)}

				{/* Rollup AC-3. Progress is otherwise invisible: the list only
				    ever shows what is still owed, so a user who just finished
				    something watches it vanish with no acknowledgement. The
				    server caps this at two and only counts transitions it
				    actually observed — an item that was already complete the
				    first time Fabric looked is not news. */}
				{data.recentlyCompleted.length > 0 && (
					<div className="border-border/60 border-t bg-muted/15 px-4 py-2.5 sm:px-5">
						<p className="font-medium text-muted-foreground text-xs">
							{t("panel.recentlyCompleted")}
						</p>
						{/* One row per item rather than a comma-joined sentence.
						    The review asked to see something struck through or
						    checked off — "I want to feel like I get more than
						    just this number incrementing" — and a list reads as
						    work finished where a sentence reads as a footnote. */}
						<ul className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1">
							{data.recentlyCompleted.map((entry) => (
								<li
									key={entry.key}
									className="flex items-center gap-1.5 text-xs"
								>
									<CheckIcon
										className="size-3.5 shrink-0 text-success"
										aria-hidden="true"
									/>
									<span className="font-medium text-muted-foreground line-through decoration-muted-foreground/60">
										{t(
											`items.${toCamel(entry.key)}.name` as never,
										)}
									</span>
								</li>
							))}
						</ul>
					</div>
				)}
			</div>

			{/* The issuing view, mounted HERE: at the panel body, outside
			    the rows list, outside the `!canAct` branch and outside every
			    eligibility check.

			    That placement is load-bearing rather than tidy. The view
			    holds the only copy of a secret the server stores as a
			    hash, so anything that unmounts it destroys what the person
			    came for — and everything inside the rows list is at the
			    mercy of the next readiness read. Issuing a key is a
			    successful mutation and the provider re-reads on any of
			    those; that read can reorder the rows, take this one out of
			    the gap list or change the eligibility that would have
			    gated the mount. (What it will NOT do is complete the item:
			    the rule detects a CLI that has actually reached Fabric,
			    which minting a key is not, so the row stays outstanding
			    until someone connects with it.) Here the view lives as
			    long as the panel does, and the panel does not depend on
			    this item at all. */}
			{organizationId && projectId !== "" ? (
				<ConnectCliDialog
					open={connectCliOpen}
					onOpenChange={setConnectCliOpen}
					/* The other surface offering this key is the prompt
					   above the project, and it has no way to see a key
					   minted from here — it mounts its own issuing view.
					   Left unwired, it went on telling a viewer holding a
					   fresh key that nobody had connected a coding tool.
					   Recorded on the shared readiness context, which both
					   surfaces read; the row itself keeps its offer, since
					   issuing a key is not connecting with it. */
					onKeyIssued={() => {
						readiness.markCliKeyIssued?.();
						trackEvent(CLI_CHECKLIST_KEY_ISSUED_EVENT, {
							projectId,
						});
					}}
					organizationId={organizationId}
					organizationSlug={organizationSlug ?? undefined}
					projectId={projectId}
					/* `||`, not `??`: the payload names the project with the
					   empty string when there is no project to name — the
					   disabled shape, and the first render before the read
					   lands — and an empty string is not nullish. */
					projectName={data?.projectName || UNNAMED_PROJECT}
				/>
			) : null}
		</section>
	);
}

function ReadinessGapRow({
	item,
	fullWidth,
	compact,
	label,
	ctaLabel,
	itemDescription,
	itemTooltip,
	itemUnmet,
	changeKind,
	ctaReachable,
	ctaHref,
	onCtaAction,
	onCtaClick,
	stateLabel,
	t,
	onSnooze,
	onSetNotApplicable,
	onRequestHelp,
	canAct,
	ctaAvailable,
}: {
	item: ReadinessItem;
	fullWidth: boolean;
	compact: boolean;
	label: string;
	/** The spreadsheet's action label for this item, e.g. "Connect codebase". */
	ctaLabel: string;
	/** The sheet's "Short Description" column. */
	itemDescription: string;
	/**
	 * What is still standing in the way, when the rule can name it. Rendered
	 * under the sheet's tooltip rather than replacing it: the spreadsheet copy
	 * is canonical and says why the item matters, which is a different question
	 * from what would satisfy it.
	 */
	itemUnmet: string | null;
	/** What happened to this item since the viewer last looked, if anything. */
	changeKind: "COMPLETED" | "REGRESSED" | "APPEARED" | null;
	/**
	 * Whether the call to action's destination exists for this viewer. A tab
	 * outside their visible set silently redirects to Overview, so the button is
	 * withdrawn rather than left looking broken.
	 */
	ctaReachable: boolean;
	/** The sheet's "Tooltip text" column. */
	itemTooltip: string;
	ctaHref: string;
	/**
	 * Set only on the row whose action opens a view in place instead of
	 * navigating (R15). When set, `ctaHref` and `onCtaClick` are unused: there
	 * is no destination and nothing to spotlight there.
	 */
	onCtaAction?: () => void;
	onCtaClick: () => void;
	/** Set once the item is resolved somehow; null while it is still a gap. */
	stateLabel: string | null;
	t: ReturnType<typeof useTranslations<"readiness">>;
	/** `null` lifts an existing snooze. */
	onSnooze: (until: Date | null) => void;
	onSetNotApplicable: (notApplicable: boolean) => void;
	onRequestHelp: () => void;
	/** Read-only viewers see the state but cannot change it. */
	canAct: boolean;
	/**
	 * This row's own answer to "may this viewer take the call to action",
	 * REPLACING `canAct` where it is given (Fizzy #2457, R21).
	 *
	 * `undefined` on every ordinary row, where the project-role gate is the
	 * right answer and nothing here should change that. It is set on the one row
	 * whose action is an ORGANIZATION-role right that no project role carries —
	 * and it answers in both directions there, because on that row `canAct` is
	 * not a weaker answer to the same question but an answer to a different one:
	 *
	 *  - `true` where the project gate says no, so an ordinary organization
	 *    member (a project role exists only where a `ProjectMember` row does, and
	 *    creating a project seeds none) is offered the one action they can take
	 *    instead of the read-only label.
	 *  - `false` where the project gate says yes, so a project editor whose
	 *    organization role does not carry key creation is not handed a control
	 *    they cannot use. Withdrawing it is the whole fix: the row's `target`
	 *    exists to satisfy the rule type and the CTA drift test, so the button
	 *    that used to render in its place was an enabled "Connect CLI" that
	 *    navigated to the project Overview tab, where nothing about connecting a
	 *    coding tool exists.
	 *
	 * It reaches the call to action and the "View only" label that would
	 * otherwise sit beside a live one, and nothing else: snoozing an item,
	 * marking it Not applicable and taking that back all write readiness state
	 * through a procedure that requires project edit rights, which is `canAct`'s
	 * question and stays `canAct`'s answer.
	 */
	ctaAvailable?: boolean;
}) {
	// A resolved item shows what resolved it, and how to undo that — snoozing
	// something already done is meaningless, but being unable to take back a
	// mis-click is worse. Completion is the one state with no undo, because
	// nobody set it: it is derived, and the way to reverse it is to change the
	// project.
	const resolved = stateLabel !== null;
	const isMustGap = item.needLevel === "MUST" && !resolved;
	const CategoryIcon = itemCategoryIcon(item);
	const remaining = snoozeRemaining(item.snoozeUntil);
	// Whether the row still has work to point at, which is a question about the
	// ITEM rather than about the viewer. A snooze quiets a reminder without
	// taking the work away, so a snoozed row keeps its call to action; an item
	// someone marked Not applicable, or one the project has already satisfied,
	// has nothing left to do and offers none.
	const ctaVisible = item.manualState === "SNOOZED" || !resolved;
	// ...and this is the question about the viewer. It is asked separately from
	// the rest of the cluster because the answer can differ — see
	// {@link CLI_ITEM_KEY} for the one row where it does, and `ctaAvailable` for
	// why that row answers it instead of `canAct` rather than alongside it.
	const ctaPermitted = ctaAvailable ?? canAct;
	const showCta = ctaVisible && ctaPermitted;

	return (
		<li
			className={cn(
				"flex flex-wrap items-center gap-3 bg-card px-4 transition-colors duration-150 hover:bg-muted/30 sm:px-5",
				fullWidth && "lg:col-span-2",
				compact ? "py-2.5" : "py-3",
				isMustGap && "shadow-[inset_3px_0_0_var(--destructive)]",
			)}
		>
			<span
				className={cn(
					"flex size-7 shrink-0 items-center justify-center rounded-md border",
					item.isComplete
						? "border-success/25 bg-success/10 text-success"
						: item.isInProgress || item.manualState === "SNOOZED"
							? "border-highlight/25 bg-highlight/10 text-highlight-ink"
							: resolved || item.needLevel === "NOT_APPLICABLE"
								? "border-border/70 bg-muted/50 text-muted-foreground"
								: isMustGap
									? "border-destructive/25 bg-destructive/[0.06] text-destructive"
									: "border-border/70 bg-muted/60 text-muted-foreground",
				)}
				aria-hidden="true"
			>
				{item.isComplete ? (
					<CheckCircle2Icon className="size-4" />
				) : item.isInProgress ? (
					<Loader2Icon className="size-3.5 motion-safe:animate-spin" />
				) : item.manualState === "SNOOZED" ? (
					<ClockIcon className="size-3.5" />
				) : item.manualState === "NOT_APPLICABLE" ||
					item.needLevel === "NOT_APPLICABLE" ? (
					<MinusCircleIcon className="size-3.5" />
				) : (
					<CategoryIcon className="size-3.5" />
				)}
			</span>
			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-center gap-2">
					{/* The sheet carries a short description and a tooltip for every row
					    and neither was ever rendered — the whole explanation of what an
					    item wants existed in the catalogue and never reached the page:
					    "no understanding what do i need to setup". The name stays a
					    focusable trigger; the short context also renders inline below. */}
					<Tooltip delayDuration={150}>
						<TooltipTrigger asChild>
							{/* A button, not a span with a tabIndex: the explanation has
							    to be reachable without a mouse, and only a genuinely
							    interactive element earns focus. */}
							<button
								type="button"
								className={cn(
									"inline-flex cursor-help items-center rounded-xs text-left text-sm transition-colors duration-150 hover:underline hover:decoration-muted-foreground/60 hover:underline-offset-4",
									"focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
									resolved
										? "font-medium text-muted-foreground"
										: isMustGap
											? "font-semibold text-foreground"
											: "font-medium text-foreground",
								)}
							>
								{label}
							</button>
						</TooltipTrigger>
						<TooltipContent side="bottom" className="max-w-sm">
							<p className="font-medium text-muted-foreground text-xs">
								{t(`needLevel.${item.needLevel}` as never)}
							</p>
							<p className="mt-0.5 font-medium">
								{itemDescription}
							</p>
							<p className="mt-1 text-muted-foreground">
								{itemTooltip}
							</p>
							{itemUnmet && (
								<p className="mt-2 border-border/60 border-t pt-2 font-medium text-foreground">
									{itemUnmet}
								</p>
							)}
						</TooltipContent>
					</Tooltip>
					{/* Only required blockers and phase-excluded rows carry an inline
					    tier badge so recommended items scan cleanly without repetitive
					    badge clutter; every tier still surfaces in the tooltip. */}
					{(isMustGap || item.needLevel === "NOT_APPLICABLE") && (
						<Badge
							status={
								item.needLevel === "MUST"
									? "destructive"
									: "info"
							}
						>
							{t(`needLevel.${item.needLevel}` as never)}
						</Badge>
					)}
					{changeKind && (
						<Badge
							status={
								changeKind === "REGRESSED"
									? "destructive"
									: changeKind === "COMPLETED"
										? "success"
										: "warning"
							}
						>
							{t(`panel.change${changeKind}` as never)}
						</Badge>
					)}
				</div>
				{!resolved && (
					<p className="mt-0.5 line-clamp-1 text-muted-foreground text-xs">
						{itemUnmet ?? itemDescription}
					</p>
				)}
			</div>
			<div className="ml-auto flex shrink-0 flex-wrap items-center gap-1.5 self-center">
				{/* A viewer without edit rights kept every control and got a 403
				    from each — the panel offered work it knew would fail. State
				    still shows; only the verbs are withdrawn. Withheld where the
				    row's own action is available anyway: "View only" printed
				    beside a live button contradicts it. */}
				{!canAct && !ctaPermitted && (
					<Tooltip delayDuration={150}>
						<TooltipTrigger asChild>
							<span className="rounded-sm bg-muted/60 px-1.5 py-0.5 text-muted-foreground text-xs">
								{t("panel.readOnly")}
							</span>
						</TooltipTrigger>
						<TooltipContent side="left" className="max-w-xs">
							{t("panel.readOnlyReason")}
						</TooltipContent>
					</Tooltip>
				)}
				{/* In Progress: the work that satisfies this item is already
				    running. Shown regardless of edit rights, because it is a
				    statement about the project rather than an action — and
				    shown alongside the actions, so a slow scan does not take
				    the item's controls away. */}
				{item.isInProgress && (
					<span className="flex items-center gap-1.5 font-medium text-highlight-ink text-xs">
						<Loader2Icon
							className="size-3 motion-safe:animate-spin"
							aria-hidden="true"
						/>
						{t("panel.stateInProgress")}
					</span>
				)}
				{!canAct ? null : item.manualState === "SNOOZED" ? (
					<>
						{/* Snoozed reads amber because that is what the rollup
						    shows while a snooze is holding the level down. */}
						<span className="font-medium text-highlight-ink text-xs">
							{remaining
								? t("panel.snoozedFor", { duration: remaining })
								: t("panel.stateSnoozed")}
						</span>
						<SnoozeMenu
							t={t}
							label={t("panel.changeSnooze")}
							onPick={onSnooze}
						/>
						{/* A snooze quiets a reminder; it does not take the item
						    away. "I should be able to unsnooze it. I shouldn't
						    lose these actions" — so Not applicable and the
						    call-to-action stay reachable while snoozed, not just
						    the two snooze controls. */}
						<Button
							variant="ghost"
							size="xs"
							onClick={() => onSetNotApplicable(true)}
						>
							{t("panel.notApplicable")}
						</Button>
						<Button
							variant="ghost"
							size="xs"
							onClick={() => onSnooze(null)}
						>
							{t("panel.unsnooze")}
						</Button>
						<Button
							variant="ghost"
							size="xs"
							onClick={onRequestHelp}
						>
							{t("panel.requestHelp")}
						</Button>
					</>
				) : item.manualState === "NOT_APPLICABLE" ? (
					<>
						<Badge status="info">{stateLabel}</Badge>
						<Button
							variant="ghost"
							size="xs"
							onClick={() => onSetNotApplicable(false)}
						>
							{t("panel.markApplicable")}
						</Button>
					</>
				) : resolved ? (
					<Badge status="success">
						<CheckIcon aria-hidden="true" />
						{stateLabel}
					</Badge>
				) : // Not graded in this phase: snoozing a reminder nobody is
				// getting, or marking "not applicable" what already is, changes
				// nothing observable, so this row is offered no actions. Its
				// call to action still renders below — running a scan early is
				// a reasonable thing to want.
				item.needLevel === "NOT_APPLICABLE" ? null : (
					/* FR22 / AC-9 describe one context menu holding the item's
					   actions, not a row of inline buttons. With 26 rows the
					   inline verbs were also most of the panel's visual weight,
					   competing with the item names the reader is actually
					   scanning. Snooze keeps its own submenu inside, because
					   picking a duration is a second choice rather than a
					   second action. */
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button
								variant="ghost"
								size="xs"
								className="size-7 p-0 text-muted-foreground hover:text-foreground"
								aria-label={t("panel.itemActions")}
							>
								<MoreHorizontalIcon className="size-4" />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							<DropdownMenuLabel>
								{t("panel.snooze")}
							</DropdownMenuLabel>
							{SNOOZE_DURATIONS.map((duration) => (
								<DropdownMenuItem
									key={duration.labelKey}
									onSelect={() =>
										onSnooze(snoozeUntilFrom(duration.days))
									}
								>
									{t(`panel.${duration.labelKey}` as never)}
								</DropdownMenuItem>
							))}
							<DropdownMenuSeparator />
							<DropdownMenuItem
								onSelect={() => onSetNotApplicable(true)}
							>
								{t("panel.notApplicable")}
							</DropdownMenuItem>
							<DropdownMenuItem onSelect={onRequestHelp}>
								{t("panel.requestHelp")}
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				)}
				{/* A real link, not a button with a router call: it
				    middle-clicks, it shows its destination on hover, and it
				    survives JavaScript being busy. The click handler only
				    carries the settings sub-tab, which no URL can express.

				    Rendered once, after the state cluster rather than inside
				    it, because it is the one control here that does not answer
				    to `canAct` alone. Its place in the row is unchanged: every
				    branch that showed it showed it last. */}
				{showCta && (
					<ReadinessCta
						t={t}
						reachable={ctaReachable}
						href={ctaHref}
						label={ctaLabel}
						emphasized={isMustGap}
						compact={compact && !resolved}
						onAction={onCtaAction}
						onClick={onCtaClick}
					/>
				)}
			</div>
		</li>
	);
}

/** The duration picker, shared by "Snooze" and "Change". */
function SnoozeMenu({
	t,
	label,
	onPick,
}: {
	t: ReturnType<typeof useTranslations<"readiness">>;
	label: string;
	onPick: (until: Date) => void;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button variant="ghost" size="xs">
					{label}
					<ChevronDownIcon className="ml-1 size-3" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				{SNOOZE_DURATIONS.map((duration) => (
					<DropdownMenuItem
						key={duration.labelKey}
						onSelect={() => onPick(snoozeUntilFrom(duration.days))}
					>
						{t(`panel.${duration.labelKey}` as never)}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/**
 * A checklist item's call to action, or an honest explanation instead.
 *
 * The tab bar is filtered per viewer, and a `?tab=` naming a tab outside that
 * set falls back to Overview without an error. A button that registers the
 * click and moves nothing is worse than no button: the item still says what it
 * wants, and the reason the route is closed is stated rather than left to be
 * discovered.
 */
function ReadinessCta({
	t,
	reachable,
	href,
	label,
	emphasized = false,
	compact = false,
	onAction,
	onClick,
}: {
	t: ReturnType<typeof useTranslations<"readiness">>;
	reachable: boolean;
	href: string;
	label: string;
	emphasized?: boolean;
	compact?: boolean;
	/** Opens a view in place. Set on one row only — see {@link CLI_ITEM_KEY}. */
	onAction?: () => void;
	onClick: () => void;
}) {
	const variant = emphasized ? "default" : "outline";
	const size = compact ? "xs" : "sm";
	/**
	 * One row acts rather than navigates (R15).
	 *
	 * A real `<button>` and not a link, for three reasons: it goes nowhere, so
	 * an anchor would be lying about middle-click and "open in new tab"; the
	 * view it opens hands focus back to whatever opened it (R31), which has to
	 * be a focusable element still in the document when the view closes; and
	 * the item's own `target` names a tab only because the rule type requires
	 * one — following it would land the reader on a page that cannot show them
	 * a secret returned exactly once.
	 *
	 * Same variant and size as every other row action in its tier, because it is
	 * the same kind of control and must not read as a different affordance.
	 */
	if (onAction) {
		return (
			<Button variant={variant} size={size} onClick={onAction}>
				{label}
				{emphasized && (
					<ArrowRightIcon className="size-3.5" aria-hidden="true" />
				)}
			</Button>
		);
	}
	if (reachable) {
		return (
			<Button asChild variant={variant} size={size}>
				<Link href={href} onClick={onClick}>
					{label}
					{emphasized && (
						<ArrowRightIcon
							className="size-3.5"
							aria-hidden="true"
						/>
					)}
				</Link>
			</Button>
		);
	}
	return (
		<Tooltip delayDuration={150}>
			<TooltipTrigger asChild>
				<span>
					<Button variant={variant} size={size} disabled>
						{label}
					</Button>
				</span>
			</TooltipTrigger>
			<TooltipContent side="left" className="max-w-xs">
				{t("panel.targetUnavailable")}
			</TooltipContent>
		</Tooltip>
	);
}

/**
 * The collapsed panel: level, progress and the next thing to do, in one line.
 *
 * The chevron sits where the collapse control was, so the gesture that closed
 * the panel is the gesture that reopens it. The whole strip is the target, not
 * just the chevron — a one-line control that only responds at one end is the
 * same discoverability problem in miniature.
 */
function ReadinessSummaryStrip({
	t,
	hasUnseenChanges,
	level,
	requiredOutstanding,
	completedCount,
	totalCount,
	nextGapKey,
	onExpand,
}: {
	t: ReturnType<typeof useTranslations<"readiness">>;
	/** Something moved while this person was away; marked, never animated. */
	hasUnseenChanges: boolean;
	level: "NOT_READY" | "PARTIALLY_READY" | "READY";
	requiredOutstanding: number;
	completedCount: number;
	totalCount: number;
	nextGapKey: string | null;
	onExpand: () => void;
}) {
	const percent =
		totalCount === 0 ? 0 : Math.round((completedCount / totalCount) * 100);
	return (
		<section
			aria-label="Project readiness"
			className="overflow-hidden rounded-lg border border-border bg-card"
		>
			<button
				type="button"
				onClick={onExpand}
				aria-expanded={false}
				className={cn(
					"flex w-full flex-wrap items-center gap-x-3 gap-y-1.5 bg-card px-4 py-2 text-left sm:px-5",
					"transition-colors duration-150 hover:bg-muted/40",
					"focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
				)}
			>
				<span
					data-testid="readiness-status-dot"
					className={cn(
						"size-2 shrink-0 rounded-full",
						LEVEL_TONE[level],
					)}
					aria-hidden="true"
				/>
				<span className="font-semibold text-foreground text-sm tracking-[-0.01em]">
					{t("panel.label")}
				</span>
				<Badge status={LEVEL_BADGE[level]}>
					{t(`level.${level}` as never)}
				</Badge>
				{hasUnseenChanges && (
					<>
						<span
							className="size-2 shrink-0 rounded-full bg-highlight"
							aria-hidden="true"
						/>
						<span className="sr-only">
							{t("panel.unseenChanges")}
						</span>
					</>
				)}
				{requiredOutstanding > 0 && (
					<span
						className={cn(
							"font-medium text-xs tabular-nums",
							level === "NOT_READY"
								? "text-destructive"
								: "text-highlight-ink",
						)}
					>
						{t("panel.requiredOutstanding", {
							count: requiredOutstanding,
						})}
					</span>
				)}
				{nextGapKey && (
					<span className="hidden truncate text-muted-foreground text-xs md:inline">
						{t("panel.nextUp", {
							item: t(
								`items.${toCamel(nextGapKey)}.name` as never,
							),
						})}
					</span>
				)}
				<div className="ml-auto flex items-center gap-2.5">
					<div
						className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-muted ring-1 ring-border/60 sm:block"
						aria-hidden="true"
					>
						<div
							className={cn(
								"h-full rounded-full",
								LEVEL_TONE[level],
							)}
							style={{ width: `${percent}%` }}
						/>
					</div>
					<span className="text-muted-foreground text-xs tabular-nums">
						{t("panel.progress", {
							completed: completedCount,
							total: totalCount,
							percent,
						})}
					</span>
					<ChevronDownIcon
						className="size-4 text-muted-foreground"
						aria-hidden="true"
					/>
				</div>
				<span className="sr-only">{t("panel.expand")}</span>
			</button>
		</section>
	);
}
