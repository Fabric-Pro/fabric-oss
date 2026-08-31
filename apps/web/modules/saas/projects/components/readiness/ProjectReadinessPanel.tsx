"use client";

import {
	GET_STARTED_SPOTLIGHT_EVENT,
	type ProjectTabId,
	type SpotlightEventDetail,
} from "@saas/get-started/lib/tour-steps";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import {
	resolveProjectTabs,
	useProjectTabCustomization,
} from "@saas/projects/lib/project-tab-preferences";
import { tabs as PROJECT_TABS } from "@saas/projects/lib/project-tabs";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
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
	CheckIcon,
	ChevronDownIcon,
	ChevronUpIcon,
	Loader2Icon,
	MoreHorizontalIcon,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import type { SettingsTab } from "../ProjectSettingsNav";
import { navigateToProjectSettingsTab } from "../settings-tab-navigation";
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
 * `destructive`, not `primary`, for NOT_READY. The running theme resolves
 * `--primary` to a teal (#0d9488) and `--secondary` to an emerald (#34d399),
 * so a panel coloured `primary` for "not ready" and `secondary` for "ready"
 * showed two greens — which is exactly the confusion the 20 Aug review opened
 * with: "it's showing green, but I don't think we're green. We're not ready.
 * It should be like red." Verified on staging before changing it.
 */
const LEVEL_TONE = {
	READY: "bg-secondary",
	PARTIALLY_READY: "bg-highlight",
	NOT_READY: "bg-destructive",
} as const;

/**
 * The panel's own surface. The UI Draft requires readiness be "salient and
 * expanded" while a project is not ready, and the review asked for it three
 * times — "even if it's ugly, like a shade of yellow… it shouldn't feel like
 * this is just something for your eyes to absorb."
 *
 * A tint plus a heavier left rail, held to /10 and /40 so it reads as an alert
 * rather than a poster. A Ready project gets no tint at all: it has nothing to
 * ask for, and the UI Draft wants that state "compact and quiet".
 */
const LEVEL_SURFACE = {
	READY: "border-l-secondary bg-muted/40",
	PARTIALLY_READY: "border-l-highlight bg-highlight/10",
	NOT_READY: "border-l-destructive bg-destructive/10",
} as const;

const LEVEL_TEXT = {
	READY: "text-secondary",
	PARTIALLY_READY: "text-highlight",
	NOT_READY: "text-destructive",
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
 * Project tabs and settings sub-tabs are both client state with no route of
 * their own, so `?tab=` is the only addressable form. It works from anywhere: on
 * the tabbed project page the deep-link hook consumes it in place, and from one
 * of the standalone project routes (the document editor, the feature workspace)
 * it navigates to the page that can honour it.
 *
 * Settings needs a second half — see {@link handleTargetClick} — because the
 * sub-tab is not expressible in the URL.
 */
function readinessTargetHref(
	projectBasePath: string,
	target: ReadinessItem["target"],
): string {
	return target.kind === "tab"
		? `${projectBasePath}?tab=${target.tab}`
		: `${projectBasePath}?tab=settings`;
}

/**
 * Only the settings targets need this: the sub-tab is written to sessionStorage
 * (and announced) before the link navigates, so `ProjectSettings` opens on the
 * right sub-tab when it mounts. Plain tab targets are fully carried by the href.
 *
 * The cast is safe because every `subTab` in the rule registry is checked
 * against the live `SettingsTab` union by
 * `__tests__/modules/saas/projects/readiness/targets.test.ts` — nothing in the
 * type system links a string in `packages/api` to a union in `apps/web`, so that
 * test is the guard.
 */
/**
 * Where each item's call-to-action should point the eye once it has navigated.
 *
 * Staging QA: the destinations were right and useless — "define feature leads
 * me here and i dont see where to define it", "same here with chat app, not
 * sure how to do that". Sending someone to a tab is only half an instruction.
 *
 * Only items whose target is a page with a real anchor appear here; the rest
 * navigate as before. Anchors are the existing `data-onboarding-target`s the
 * Get Started tours already place, so this adds no second highlight mechanism.
 */
const ITEM_SPOTLIGHT: Record<
	string,
	{ anchorId: string; tab?: ProjectTabId; title: string; body: string }
> = {
	"context-source": {
		anchorId: "context-add",
		tab: "context",
		title: "Add your first context source",
		body: "Upload a file, paste a link or a note here. Anything Fabric can read makes its documents and recommendations better grounded.",
	},
	"additional-context-sources": {
		anchorId: "context-add",
		tab: "context",
		title: "Add more source material",
		body: "One source is a start. Add the rest of what the project runs on — specs, research, exports — from here.",
	},
	"wiki-connected": {
		anchorId: "context-add",
		tab: "context",
		title: "Connect your wiki",
		body: "Choose the wiki integration here. Fabric indexes the pages so it can answer from them.",
	},
	"knowledge-base": {
		anchorId: "context-add",
		tab: "context",
		title: "Add your knowledge base",
		body: "Add its URL here and classify it as Knowledge Base / Wiki — the classification is what satisfies this item.",
	},
	"business-case": {
		anchorId: "documents-create",
		tab: "documents",
		title: "Create a business case",
		body: "Generate it here. A PRD supersedes this item, so if you would rather go straight there, create that instead.",
	},
	proposal: {
		anchorId: "documents-create",
		tab: "documents",
		title: "Create a proposal",
		body: "Generate it here. A PRD supersedes this item, so if you would rather go straight there, create that instead.",
	},
	prd: {
		anchorId: "documents-create",
		tab: "documents",
		title: "Create the PRD",
		body: "Generate it here. It also clears the business case and proposal items, which it supersedes.",
	},
	architecture: {
		anchorId: "documents-create",
		tab: "documents",
		title: "Create an architecture document",
		body: "Generate it here. It unlocks the API and technical specification items, which depend on it.",
	},
	"api-spec": {
		anchorId: "documents-create",
		tab: "documents",
		title: "Add an API specification",
		body: "Generate one here, or upload an existing OpenAPI file on the Context tab.",
	},
	"technical-spec": {
		anchorId: "documents-create",
		tab: "documents",
		title: "Create a technical specification",
		body: "Generate it here, once an architecture document exists for it to build on.",
	},
	"qa-strategy": {
		anchorId: "documents-create",
		tab: "documents",
		title: "Create a QA strategy",
		body: "Generate it here. It is what the Testing tab plans against.",
	},
	// Settings sub-tabs carry no project tab: `handleTargetClick` opens the
	// sub-tab, and the spotlight waits for the anchor to mount there.
	"chat-app-connected": {
		anchorId: "settings-chat-monitors",
		title: "Connect a chat app",
		body: "Turn on a Teams or Slack monitor here. Fabric watches the channel and turns what is discussed into work — connecting the workspace alone is not enough.",
	},
	"meeting-transcripts": {
		anchorId: "settings-meeting-transcripts",
		title: "Sync meeting transcripts",
		body: "Link a Teams meeting here. Transcripts arrive 60–90 minutes after each call and become project context.",
	},
	"feature-snapshot": {
		anchorId: "overview-feature-snapshot",
		tab: "overview",
		title: "Describe the main features",
		body: "Edit this card to list the capabilities the project is being built around. Rough is fine — it is context, not a commitment.",
	},
	"tech-stack": {
		anchorId: "overview-tech-stack",
		tab: "overview",
		title: "Record the tech stack",
		body: "Edit this card and name at least one technology. One entry satisfies the item; more makes generated docs sharper.",
	},
};

/**
 * Show someone where an item is satisfied.
 *
 * Opt-in, not automatic. Firing this on every call-to-action meant a dimmed
 * screen and a callout every time you acted on the checklist — a lot of
 * ceremony for a button you have already pressed nine times ("i dont think we
 * need this panel each time"). The primary action just navigates; this sits
 * behind its own control, for arriving somewhere and not seeing what to do.
 *
 * Only items whose target is a tab with a real anchor are in the map. An item
 * pointing at a Settings sub-tab has nothing to aim at yet, so it gets no help
 * control rather than a callout pointing at the wrong page.
 */
function spotlightFor(itemKey: string) {
	const spot = ITEM_SPOTLIGHT[itemKey];
	if (!spot || typeof window === "undefined") {
		return;
	}
	window.dispatchEvent(
		new CustomEvent<SpotlightEventDetail>(GET_STARTED_SPOTLIGHT_EVENT, {
			detail: {
				anchorId: spot.anchorId,
				projectTab: spot.tab,
				title: spot.title,
				body: spot.body,
			},
		}),
	);
}

function handleTargetClick(projectId: string, target: ReadinessItem["target"]) {
	if (target.kind === "settings") {
		navigateToProjectSettingsTab(projectId, target.subTab as SettingsTab);
	}
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
	// A per-viewer "not yet" on the phase-transition offer. Browser-local on
	// purpose: declining the suggestion is not a fact about the project, and one
	// person deferring it should not hide it from their teammates.
	const [transitionDismissed, setTransitionDismissed] = useState(false);
	const { organizationId, organizationSlug } = useOrganizationContext();
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
	const reachableTabIds = useMemo(
		() =>
			new Set(
				resolveProjectTabs(PROJECT_TABS, {
					config: tabCustomization.config,
					prefs: tabCustomization.prefs,
				}).map((tab) => tab.id as string),
			),
		[tabCustomization.config, tabCustomization.prefs],
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
				className="border-border border-b bg-muted/40"
			>
				<div className="flex flex-col gap-3 px-4 py-4 sm:px-6">
					<span className="font-semibold text-[11px] text-muted-foreground uppercase tracking-[0.2em]">
						{t("panel.label")}
					</span>
					<div className="h-1 w-full animate-pulse bg-border" />
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
				requiredOutstanding={
					data.activeGaps.filter((i) => i.needLevel === "MUST").length
				}
				completedCount={data.completedCount}
				totalCount={data.totalCount}
				nextGapKey={data.activeGaps[0]?.key ?? null}
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
	const rows = showAll
		? visible
		: data.activeGaps.slice(0, DEFAULT_GAP_COUNT);
	// Why the level says what it says. The default view shows the next few gaps
	// in checklist order, so the MUSTs holding a project at Not Ready can all sit
	// below the fold — leaving a panel that reads "not ready" above a list of
	// shoulds, with nothing connecting the two.
	const mustGapCount = data.activeGaps.filter(
		(i) => i.needLevel === "MUST",
	).length;
	const hiddenCount = visible.length - data.activeGaps.length;
	// Tier 1 of the attention rules: a static marker on anything that changed
	// since this person last opened the panel. Never animated, so it survives a
	// reload — a pulse a user missed is gone, and the news with it.
	const changeByKey = new Map(
		data.attention.changes.map((change) => [change.key, change.kind]),
	);

	const blockedItems = data.items.filter(
		(i) => !i.isVisible && i.needLevel !== "NOT_APPLICABLE",
	);
	// One warning per prerequisite rather than one per hidden item: a codebase
	// unlocks three things at once, and three separate lines saying "connect a
	// codebase" is the same sentence three times.
	const blockedGroups = [
		...blockedItems
			.reduce((groups, blockedItem) => {
				const prerequisite = blockedItem.blockedBy;
				if (!prerequisite) {
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
	const percent =
		data.totalCount === 0
			? 0
			: Math.round((data.completedCount / data.totalCount) * 100);

	return (
		<section
			aria-label="Project readiness"
			className={cn(
				"border-border border-b border-l-4",
				LEVEL_SURFACE[data.level],
			)}
		>
			<div className="flex flex-col gap-3 px-4 py-4 sm:px-6">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<div className="flex flex-wrap items-baseline gap-2">
						<span className="font-semibold text-[11px] text-muted-foreground uppercase tracking-[0.2em]">
							{t("panel.label")}
						</span>
						{/* The level in words, in the panel itself. The header pill
						    carried it, but a reader looking AT the checklist had to
						    look away from it to learn what it added up to. */}
						<span
							className={cn(
								"font-semibold text-[11px] uppercase tracking-[0.2em]",
								LEVEL_TEXT[data.level],
							)}
						>
							{t(`level.${data.level}` as never)}
						</span>
						{/* Say plainly that nobody chose this phase, and offer the
						    correction, rather than presenting a guess as a decision. */}
						{data.phaseSource === "inferred" && (
							<span className="flex flex-wrap items-center gap-2 rounded-md border border-highlight/40 bg-highlight/10 px-2 py-1 text-xs">
								<span className="text-foreground">
									{t("panel.assumedPhase")}
								</span>
								<DropdownMenu>
									<DropdownMenuTrigger asChild>
										<Button
											variant="ghost"
											size="sm"
											className="h-6 px-2 text-primary underline underline-offset-2"
											disabled={
												setPhase.isPending ||
												!data.canAct
											}
										>
											{t("panel.setPhase")}
											<ChevronDownIcon className="ml-1 size-3" />
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
					<div className="flex items-center gap-3">
						{mustGapCount > 0 && (
							<span className="font-medium text-primary text-xs tabular-nums">
								{t("panel.requiredOutstanding", {
									count: mustGapCount,
								})}
							</span>
						)}
						<span className="text-muted-foreground text-xs tabular-nums">
							{t("panel.progress", {
								completed: data.completedCount,
								total: data.totalCount,
								percent,
							})}
						</span>
						{hiddenCount > 0 && (
							<Button
								variant="ghost"
								size="sm"
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
						<Button
							variant="ghost"
							size="sm"
							onClick={() => setExpanded(false)}
							aria-label={t("panel.collapse")}
						>
							<ChevronUpIcon className="size-4" />
						</Button>
					</div>
				</div>

				{/* A meter, not a divider. At h-1 in bg-border this was visually
				    indistinguishable from the panel's own border, which is why
				    the 20 Aug review asked for a progress bar that already
				    existed. Height and a contrasting track are the whole fix. */}
				<div
					className="h-2 w-full overflow-hidden rounded-full bg-muted"
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

				{/* UI Draft, Phase transition: once Discovery has nothing left
				    owed, offer the next phase rather than leaving the project at
				    Ready against a checklist it has outgrown. */}
				{data.suggestPhaseTransition &&
					!transitionDismissed &&
					data.canAct && (
						<div className="flex flex-wrap items-center gap-3 rounded-md border border-secondary/40 bg-secondary/10 px-3 py-2 text-sm">
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

				{/* What this panel is, for someone meeting it for the first time
				    (20 Aug review). Only while there is work outstanding — a Ready
				    project does not need the instructions. */}
				{data.level !== "READY" && (
					<p className="text-muted-foreground text-xs leading-relaxed">
						{t("panel.intro")}
					</p>
				)}

				{/* Items behind an unmet dependency are not rendered at all, so a
				    reader could not tell "nothing left" from "not unlocked yet".
				    Say how many are waiting and name them. */}
				{/* Grouped by what would unlock them, so the count becomes an
				    instruction. "6 more items appear once earlier steps are
				    done" told a reader something was missing but never what to
				    do about it — the blocked-capability warning the card asks
				    for is this list, naming the prerequisite. Informational
				    only: 4A warns, it never blocks the action (4B gates). */}
				{blockedGroups.length > 0 && (
					<div className="flex flex-col gap-1">
						{blockedGroups.map(([prerequisite, blocked]) => (
							<p
								key={prerequisite}
								className="text-muted-foreground text-xs"
							>
								{t("panel.unlockedBy", {
									prerequisite: t(
										`items.${toCamel(prerequisite)}.name` as never,
									),
									items: blocked
										.map((i) =>
											t(
												`items.${toCamel(i.key)}.name` as never,
											),
										)
										.join(", "),
								})}
							</p>
						))}
					</div>
				)}

				{rows.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						{t("panel.empty")}
					</p>
				) : (
					<ul className="flex flex-col">
						{rows.map((item) => (
							<ReadinessGapRow
								key={item.key}
								item={item}
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
								changeKind={changeByKey.get(item.key) ?? null}
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
								)}
								ctaReachable={
									item.target.kind !== "tab" ||
									reachableTabIds.has(item.target.tab)
								}
								onCtaClick={() => {
									handleTargetClick(projectId, item.target);
									spotlightFor(item.key);
								}}
								stateLabel={
									item.manualState === "SNOOZED"
										? t("panel.stateSnoozed")
										: item.manualState === "NOT_APPLICABLE"
											? t("panel.stateNotApplicable")
											: item.isComplete
												? t("panel.stateComplete")
												: null
								}
								t={t}
								onSnooze={(until) =>
									snooze.mutate({ itemKey: item.key, until })
								}
								onSetNotApplicable={(notApplicable) =>
									setNotApplicable.mutate({
										itemKey: item.key,
										notApplicable,
									})
								}
								canAct={data.canAct}
							/>
						))}
					</ul>
				)}

				{/* Rollup AC-3. Progress is otherwise invisible: the list only
				    ever shows what is still owed, so a user who just finished
				    something watches it vanish with no acknowledgement. The
				    server caps this at two and only counts transitions it
				    actually observed — an item that was already complete the
				    first time Fabric looked is not news. */}
				{data.recentlyCompleted.length > 0 && (
					<div className="rounded-md border border-secondary/30 bg-secondary/10 px-3 py-2">
						<p className="text-muted-foreground text-xs">
							{t("panel.recentlyCompleted")}
						</p>
						{/* One row per item rather than a comma-joined sentence.
						    The review asked to see something struck through or
						    checked off — "I want to feel like I get more than
						    just this number incrementing" — and a list reads as
						    work finished where a sentence reads as a footnote. */}
						<ul className="mt-1 flex flex-col gap-1">
							{data.recentlyCompleted.map((entry) => (
								<li
									key={entry.key}
									className="flex items-center gap-2 text-sm"
								>
									<CheckIcon
										className="size-4 shrink-0 text-secondary"
										aria-hidden="true"
									/>
									<span className="font-medium text-foreground line-through decoration-muted-foreground/50">
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
		</section>
	);
}

function ReadinessGapRow({
	item,
	label,
	ctaLabel,
	itemDescription,
	itemTooltip,
	itemUnmet,
	changeKind,
	ctaReachable,
	ctaHref,
	onCtaClick,
	stateLabel,
	t,
	onSnooze,
	onSetNotApplicable,
	canAct,
}: {
	item: ReadinessItem;
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
	onCtaClick: () => void;
	/** Set once the item is resolved somehow; null while it is still a gap. */
	stateLabel: string | null;
	t: ReturnType<typeof useTranslations<"readiness">>;
	/** `null` lifts an existing snooze. */
	onSnooze: (until: Date | null) => void;
	onSetNotApplicable: (notApplicable: boolean) => void;
	/** Read-only viewers see the state but cannot change it. */
	canAct: boolean;
}) {
	// A resolved item shows what resolved it, and how to undo that — snoozing
	// something already done is meaningless, but being unable to take back a
	// mis-click is worse. Completion is the one state with no undo, because
	// nobody set it: it is derived, and the way to reverse it is to change the
	// project.
	const resolved = stateLabel !== null;
	const remaining = snoozeRemaining(item.snoozeUntil);

	return (
		<li className="flex flex-wrap items-center gap-3 border-border/60 border-t py-2 first:border-t-0">
			{/* The need level was rendered as the raw enum, so a row graded
			    NOT_APPLICABLE for the phase read identically to one a person had
			    marked Not applicable — two unrelated meanings sharing a word, on
			    a row that also offered a "Not applicable" button. Phase
			    non-applicability now says so in its own words. */}
			<span
				className={cn(
					"font-mono text-[10px] uppercase tracking-wider",
					item.needLevel === "MUST"
						? "text-primary"
						: "text-muted-foreground",
				)}
			>
				{t(`needLevel.${item.needLevel}` as never)}
			</span>
			{changeKind && (
				<span
					className={cn(
						"rounded px-1.5 py-0.5 font-medium text-[10px] uppercase tracking-wider",
						changeKind === "REGRESSED"
							? "bg-destructive/15 text-destructive"
							: changeKind === "COMPLETED"
								? "bg-secondary/15 text-secondary"
								: "bg-highlight/15 text-highlight",
					)}
				>
					{t(`panel.change${changeKind}` as never)}
				</span>
			)}
			{/* The sheet carries a short description and a tooltip for every row
			    and neither was ever rendered — the whole explanation of what an
			    item wants existed in the catalogue and never reached the page:
			    "no understanding what do i need to setup". The name stays the
			    row; the reason is one hover away. */}
			<Tooltip delayDuration={150}>
				<TooltipTrigger asChild>
					{/* A button, not a span with a tabIndex: the explanation has
					    to be reachable without a mouse, and only a genuinely
					    interactive element earns focus. */}
					<button
						type="button"
						className={cn(
							"cursor-help text-left text-sm underline decoration-dotted decoration-muted-foreground/40 underline-offset-4",
							"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
							resolved && "text-muted-foreground",
						)}
					>
						{label}
					</button>
				</TooltipTrigger>
				<TooltipContent side="bottom" className="max-w-sm">
					<p className="font-medium">{itemDescription}</p>
					<p className="mt-1 text-muted-foreground">{itemTooltip}</p>
					{itemUnmet && (
						<p className="mt-2 border-border/60 border-t pt-2 font-medium text-foreground">
							{itemUnmet}
						</p>
					)}
				</TooltipContent>
			</Tooltip>
			<div className="ml-auto flex flex-wrap items-center gap-2">
				{/* A viewer without edit rights kept every control and got a 403
				    from each — the panel offered work it knew would fail. State
				    still shows; only the verbs are withdrawn. */}
				{!canAct && (
					<Tooltip delayDuration={150}>
						<TooltipTrigger asChild>
							<span className="text-muted-foreground text-xs">
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
					<span className="flex items-center gap-1.5 font-medium text-highlight text-xs">
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
						<span className="font-medium text-highlight text-xs">
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
							size="sm"
							onClick={() => onSetNotApplicable(true)}
						>
							{t("panel.notApplicable")}
						</Button>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => onSnooze(null)}
						>
							{t("panel.unsnooze")}
						</Button>
						<ReadinessCta
							t={t}
							reachable={ctaReachable}
							href={ctaHref}
							label={ctaLabel}
							onClick={onCtaClick}
						/>
					</>
				) : item.manualState === "NOT_APPLICABLE" ? (
					<>
						<span className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
							{stateLabel}
						</span>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => onSetNotApplicable(false)}
						>
							{t("panel.markApplicable")}
						</Button>
					</>
				) : resolved ? (
					<span className="flex items-center gap-1.5 font-mono text-[10px] text-secondary uppercase tracking-wider">
						<CheckIcon className="size-3" aria-hidden="true" />
						{stateLabel}
					</span>
				) : item.needLevel === "NOT_APPLICABLE" ? (
					/* Not graded in this phase: snoozing a reminder nobody is
					   getting, or marking "not applicable" what already is,
					   changes nothing observable. The call to action stays —
					   running a scan early is a reasonable thing to want. */
					<ReadinessCta
						t={t}
						reachable={ctaReachable}
						href={ctaHref}
						label={ctaLabel}
						onClick={onCtaClick}
					/>
				) : (
					<>
						{/* FR22 / AC-9 describe one context menu holding the
						    item's actions, not a row of inline buttons. With
						    26 rows the inline verbs were also most of the
						    panel's visual weight, competing with the item names
						    the reader is actually scanning. Snooze keeps its own
						    submenu inside, because picking a duration is a
						    second choice rather than a second action. */}
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button
									variant="ghost"
									size="sm"
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
											onSnooze(
												snoozeUntilFrom(duration.days),
											)
										}
									>
										{t(
											`panel.${duration.labelKey}` as never,
										)}
									</DropdownMenuItem>
								))}
								<DropdownMenuSeparator />
								<DropdownMenuItem
									onSelect={() => onSetNotApplicable(true)}
								>
									{t("panel.notApplicable")}
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
						{/* A real link, not a button with a router call: it
						    middle-clicks, it shows its destination on hover, and
						    it survives JavaScript being busy. The click handler
						    only carries the settings sub-tab, which no URL can
						    express. */}
						<ReadinessCta
							t={t}
							reachable={ctaReachable}
							href={ctaHref}
							label={ctaLabel}
							onClick={onCtaClick}
						/>
					</>
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
				<Button variant="ghost" size="sm">
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
	onClick,
}: {
	t: ReturnType<typeof useTranslations<"readiness">>;
	reachable: boolean;
	href: string;
	label: string;
	onClick: () => void;
}) {
	if (reachable) {
		return (
			<Button asChild variant="outline" size="sm">
				<Link href={href} onClick={onClick}>
					{label}
				</Link>
			</Button>
		);
	}
	return (
		<Tooltip delayDuration={150}>
			<TooltipTrigger asChild>
				<span>
					<Button variant="outline" size="sm" disabled>
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
	return (
		<section
			aria-label="Project readiness"
			className="border-border border-b"
		>
			<button
				type="button"
				onClick={onExpand}
				aria-expanded={false}
				className={cn(
					"flex w-full flex-wrap items-center gap-x-3 gap-y-1 border-l-4 px-4 py-2 text-left sm:px-6",
					"transition-colors hover:bg-muted/50",
					"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
					LEVEL_SURFACE[level],
				)}
			>
				{hasUnseenChanges && (
					<span
						className="size-2 shrink-0 rounded-full bg-highlight"
						aria-label={t("panel.unseenChanges")}
					/>
				)}
				<span className="font-semibold text-[11px] uppercase tracking-[0.2em]">
					{t(`level.${level}` as never)}
				</span>
				{requiredOutstanding > 0 && (
					<span className="text-muted-foreground text-xs">
						{t("panel.requiredOutstanding", {
							count: requiredOutstanding,
						})}
					</span>
				)}
				<span className="text-muted-foreground text-xs">
					{t("panel.progress", {
						completed: completedCount,
						total: totalCount,
						percent:
							totalCount === 0
								? 0
								: Math.round(
										(completedCount / totalCount) * 100,
									),
					})}
				</span>
				{nextGapKey && (
					<span className="hidden truncate text-muted-foreground text-xs sm:inline">
						{t("panel.nextUp", {
							item: t(
								`items.${toCamel(nextGapKey)}.name` as never,
							),
						})}
					</span>
				)}
				<ChevronDownIcon
					className="ml-auto size-4 text-muted-foreground"
					aria-hidden="true"
				/>
				<span className="sr-only">{t("panel.expand")}</span>
			</button>
		</section>
	);
}
