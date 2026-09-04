import {
	CompassIcon,
	FileTextIcon,
	FolderKanbanIcon,
	KeyIcon,
	KeyRoundIcon,
	LayoutDashboardIcon,
	LightbulbIcon,
	MapIcon,
	NetworkIcon,
	RocketIcon,
	SparklesIcon,
} from "lucide-react";
import type { ComponentType } from "react";

/**
 * Single source of truth for the "Get started" onboarding tour.
 *
 * ── Keeping this ALWAYS up to date ────────────────────────────────────────
 * Every step here anchors to a real, live component via a stable
 * `data-onboarding-target="<anchorId>"` attribute (sidebar nav items and the
 * project tab bar). When you add / rename / remove a primary feature, nav
 * destination, or project tab, update this registry AND its anchor. The
 * drift-guard test (`__tests__/onboarding-steps.drift.test.ts`) fails CI when
 * a step points at an anchor that no longer exists in the source, or when a
 * required area loses its step — so the guide cannot silently go stale. See
 * the "Onboarding guide upkeep" rule in CLAUDE.md / AGENTS.md.
 */

/** Opens the contextual Get-Started drawer (from the sidebar item / help icon). */
export const GET_STARTED_OPEN_EVENT = "get-started:open";
/**
 * Fired by ProjectDetails whenever the active project tab changes (including
 * the initial mount). Lets the Get-Started controller drive per-page first-visit
 * tours — the active tab is client state, not the URL, so this is the only
 * reliable signal for a manual tab switch. Detail: `{ projectId, tab }`.
 */
export const GET_STARTED_PROJECT_TAB_EVENT = "get-started:project-tab";
export type ProjectTabEventDetail = { projectId: string; tab: string };
/**
 * Fired by a page's "Get started" launcher — asks the controller to open that
 * page's detailed tour (works for any user, unlike the cohort-gated first-visit
 * auto-open). Detail carries the page id so it works on any page, not just the
 * active project tab.
 */
export const GET_STARTED_TOUR_PAGE_EVENT = "get-started:tour-page";
export type TourPageEventDetail = { pageId: string };
/**
 * Fired by `ProjectDetails` when project tabs become visible to the current
 * viewer again (admin re-enabled them, or a personal hide was lifted). The
 * Get-Started controller listens so each revealed page replays its
 * first-visit experience exactly once. Detail: `{ pageIds }`.
 */
export const GET_STARTED_PAGES_REVEALED_EVENT = "get-started:pages-revealed";
export type PagesRevealedEventDetail = { pageIds: string[] };
/**
 * Fired by the Get-Started controller whenever an onboarding surface (drawer,
 * guided tour, "Show me" spotlight, page tour, tags prompt) opens or closes.
 * Lets surfaces rendered OUTSIDE the controller — the launcher pointer lives in
 * the sidebar, a sibling of the controller in the app shell — stay out of the
 * way without duplicating its mode machine. Detail: `{ open }`.
 */
export const GET_STARTED_SURFACE_EVENT = "get-started:surface";
export type SurfaceEventDetail = { open: boolean };

/**
 * Ask the controller to spotlight one in-page component, by anchor.
 *
 * The drawer's "Show me" already does this, but only for items it owns. Other
 * surfaces need the same thing: the readiness checklist sends you to the tab
 * where an item is satisfied, and staging QA found that landing there is not
 * enough — "define feature leads me here and i dont see where to define it".
 * The destination was right; nothing said what to do once you arrived.
 *
 * Carrying the copy in the event keeps the caller's wording next to the caller,
 * rather than forcing every surface into the drawer registry.
 */
export const GET_STARTED_SPOTLIGHT_EVENT = "get-started:spotlight";
export type SpotlightEventDetail = {
	/** `data-onboarding-target` of the element to highlight. */
	anchorId: string;
	/** Project tab the anchor lives on, when it is inside the tabbed project page. */
	projectTab?: ProjectTabId;
	title: string;
	body: string;
};

type Side = "top" | "bottom";

/** Project tab ids (must match ProjectDetails `tabs`). */
export type ProjectTabId =
	| "overview"
	| "daily-brief"
	| "meeting-digest"
	| "release-notes"
	| "documents"
	| "decisions"
	| "context"
	| "pipeline"
	| "stories"
	| "test-cases"
	| "publishing-suite"
	| "weave"
	| "kanban"
	| "agent-activity"
	| "diagrams"
	| "reports"
	| "usage"
	| "atlas"
	| "security"
	| "settings";

export type OnboardingArea =
	| "welcome"
	| "aiKey"
	| "assistant"
	| "projects"
	| "overview"
	| "documents"
	| "roadmap"
	| "proposals"
	| "atlas"
	| "apiKey"
	| "wrapup";

/** `data-onboarding-target` values placed on always-present global chrome. */
export const ONBOARDING_ANCHORS = {
	navNexus: "nav-nexus",
	navProjects: "nav-projects",
	launcher: "onboarding-launcher",
	/** The mobile hamburger — small-screen fallback anchor for sidebar steps. */
	mobileNavTrigger: "mobile-nav-trigger",
} as const;

/** `data-onboarding-target` value for a project tab-bar trigger. */
export function anchorForProjectTab(tab: ProjectTabId): string {
	return `project-tab-${tab}`;
}

/**
 * Who is taking the tour, for steps whose destination depends on it.
 *
 * Only role so far. The organization AI-provider page renders read-only for
 * everyone but an admin, so a step that sends every viewer to the same URL
 * strands a member on a form they cannot submit.
 */
type TourViewer = { isOrganizationAdmin: boolean };

/** Builds a href from the active workspace base path (`/app` or `/app/{slug}`). */
type NavHref = (basePath: string, viewer: TourViewer) => string;

type OnboardingStepTarget =
	| {
			kind: "center";
			/**
			 * Optional destination for the card's "Take me there" link.
			 *
			 * A centered step has nothing to spotlight, but it can still be
			 * actionable. Both key steps (Fizzy #2361) point at a settings page
			 * that has no persistent chrome to anchor to — the settings nav only
			 * mounts once you are already in settings — so the link IS the step.
			 */
			navigate?: NavHref;
	  }
	| {
			kind: "anchor";
			anchorId: string;
			/** Sidebar item — open the mobile drawer to reveal it on small screens. */
			inMobileNav?: boolean;
			navigate?: NavHref;
			side?: Side;
	  }
	| { kind: "projectTab"; tab: ProjectTabId; side?: Side }
	| {
			/** Navigate to a project tab, then spotlight an in-page component. */
			kind: "projectComponent";
			tab: ProjectTabId;
			anchorId: string;
			side?: Side;
	  };

export type OnboardingStep = {
	/** Stable id — persisted in per-user progress. Never reuse or renumber. */
	id: string;
	area: OnboardingArea;
	icon: ComponentType<{ className?: string }>;
	target: OnboardingStepTarget;
	/**
	 * Skip the step unless the targeted project tab is visible to the current
	 * viewer — enforced by the controller against tab-visibility prefs (card
	 * #1837), so a hidden tab's step drops out automatically.
	 */
	requiresFeature?: "atlas";
	/** Literal copy for ad-hoc steps (drawer "Show me"); tour steps use i18n. */
	title?: string;
	body?: string;
};

export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
	{
		id: "welcome",
		area: "welcome",
		icon: RocketIcon,
		target: { kind: "center" },
	},
	// Fizzy #2361. The first thing the tour actually SAYS, ahead of every
	// feature step: nothing here works until an AI provider key exists.
	//
	// Shown unconditionally, including to a viewer who already has a key.
	// Skipping it would need a third tri-state probe in the controller
	// alongside `hasProject`, and #2360 is the standing lesson on what an
	// unsettled probe does to a step list — it must never strip steps. The
	// slide is one sentence and the tour is replayable; the trade is not
	// close.
	//
	// The DESTINATION is not unconditional, though. Fizzy #1875 already
	// established that these are two pages for two audiences: the
	// organization page is where an admin configures the keys the whole
	// tenant runs on and renders read-only for everyone else, while the
	// account page is where any member adds a key of their own — which
	// resolves for them when their organization has none. Sending both
	// audiences to the org page would put a form a member cannot submit
	// behind a button that promises they can.
	{
		id: "aiKey",
		area: "aiKey",
		icon: KeyRoundIcon,
		target: {
			kind: "center",
			navigate: (base, viewer) =>
				viewer.isOrganizationAdmin
					? `${base}/settings/ai-providers`
					: `${base}/settings/account/ai-providers`,
		},
	},
	{
		id: "assistant",
		area: "assistant",
		icon: SparklesIcon,
		target: {
			kind: "anchor",
			anchorId: ONBOARDING_ANCHORS.navNexus,
			inMobileNav: true,
			navigate: (base) => `${base}/agents/fabric-ai`,
			side: "bottom",
		},
	},
	{
		id: "projects",
		area: "projects",
		icon: FolderKanbanIcon,
		target: {
			kind: "anchor",
			anchorId: ONBOARDING_ANCHORS.navProjects,
			inMobileNav: true,
			navigate: (base) => `${base}/projects`,
			side: "bottom",
		},
	},
	{
		id: "overview",
		area: "overview",
		icon: LayoutDashboardIcon,
		target: {
			kind: "projectComponent",
			tab: "overview",
			anchorId: "overview-readiness",
			side: "bottom",
		},
	},
	{
		id: "documents",
		area: "documents",
		icon: FileTextIcon,
		target: {
			kind: "projectComponent",
			tab: "documents",
			anchorId: "documents-create",
			side: "bottom",
		},
	},
	{
		id: "roadmap",
		area: "roadmap",
		icon: MapIcon,
		target: {
			kind: "projectComponent",
			tab: "stories",
			anchorId: "roadmap-board",
			side: "bottom",
		},
	},
	{
		id: "proposals",
		area: "proposals",
		icon: LightbulbIcon,
		target: {
			kind: "projectComponent",
			tab: "stories",
			anchorId: "roadmap-review-proposals",
			side: "bottom",
		},
	},
	{
		id: "atlas",
		area: "atlas",
		icon: NetworkIcon,
		requiresFeature: "atlas",
		target: { kind: "projectTab", tab: "atlas", side: "bottom" },
	},
	// Fizzy #2361. Sits at the END, not next to `aiKey`: a provider key is
	// required for Fabric to work at all, while a Fabric API key is an optional
	// way to drive it from outside. Stacking both at the top would open the tour
	// with two settings detours before the viewer has seen a single feature.
	{
		id: "apiKey",
		area: "apiKey",
		icon: KeyIcon,
		target: {
			kind: "center",
			navigate: (base) => `${base}/settings/api-keys`,
		},
	},
	{
		id: "wrapup",
		area: "wrapup",
		icon: CompassIcon,
		target: {
			kind: "anchor",
			anchorId: ONBOARDING_ANCHORS.launcher,
			inMobileNav: true,
			side: "top",
		},
	},
] as const;

/**
 * The project tab a step lives on, or `null` if it isn't project-scoped.
 *
 * One spelling of "does this step need a project": the two target kinds that
 * do both carry a `tab`, and every caller wants either the tab or the fact
 * that there isn't one.
 */
function projectTabOf(step: OnboardingStep): ProjectTabId | null {
	const { target } = step;
	return target.kind === "projectTab" || target.kind === "projectComponent"
		? target.tab
		: null;
}

type TourStepContext = {
	/**
	 * Whether the viewer has at least one project. `undefined` while the
	 * lookup is still in flight — see the collapse rule below.
	 */
	hasProject: boolean | undefined;
	/** Tab-visibility predicate for this viewer (card #1837). */
	isTabVisible: (tab: string) => boolean;
};

/**
 * The steps a given viewer should actually be walked through.
 *
 * Two filters, in this order:
 *
 * 1. Drop any project-scoped step whose tab is hidden from this viewer — it
 *    would navigate nowhere or spotlight a missing anchor.
 * 2. When the viewer has NO project, keep only the FIRST surviving
 *    project-scoped step and drop the rest.
 *
 * Step 2 is the fix for Fizzy #2360. Five steps target a project, and the
 * spotlight falls back to the same "Create your first project" card whenever
 * it cannot resolve one — correct for a single step, but it meant a brand-new
 * account saw that identical card five times in a row at positions 4-8. The
 * spotlight renders one step at a time and cannot know it is about to repeat
 * itself; only the step list can. Keeping one step preserves the call to
 * action in its natural position, right after "Projects hold your work".
 *
 * "First SURVIVING" matters: tab customization can hide Overview, and keeping
 * a step the viewer cannot reach would trade one bug for another.
 *
 * `hasProject: undefined` deliberately does NOT collapse. Stripping real steps
 * from a viewer who does have projects, because a query had not settled yet,
 * is a worse failure than the repeated card.
 *
 * Kept pure and exported so it can be tested directly over arrays, the way
 * `anchorIdsUsedBySteps` is.
 */
export function resolveTourSteps({
	hasProject,
	isTabVisible,
}: TourStepContext): readonly OnboardingStep[] {
	const visible = ONBOARDING_STEPS.filter((step) => {
		const tab = projectTabOf(step);
		return tab === null || isTabVisible(tab);
	});

	if (hasProject !== false) {
		return visible;
	}

	const firstProjectStep = visible.find(
		(step) => projectTabOf(step) !== null,
	);
	return visible.filter(
		(step) => projectTabOf(step) === null || step === firstProjectStep,
	);
}

/**
 * Where a tour sits, given the step it was last on.
 *
 * The visible list is live — tab visibility resolves per project, only once
 * the tour has navigated into one — so steps can vanish underneath a run. A
 * bare array index cannot survive that: drop a step BEFORE the current one and
 * every later index shifts down, silently moving the viewer somewhere else.
 *
 * So the position is resolved from the step's id:
 *
 * - the step is still there -> its new position, wherever it moved to;
 * - it was removed -> the first step AFTER it in REGISTRY order that survived.
 *
 * That second rule has to consult the registry rather than reuse the old
 * index, because one visibility result can remove several steps at once. If
 * the viewer is on `documents` and both `overview` and `documents` disappear,
 * the old index no longer addresses `documents`' successor at all — it points
 * a step further on, skipping `roadmap`.
 *
 * Falls back to the last step when nothing after it survived, and to the first
 * when there is no id yet. Never returns an out-of-range index, which is what
 * keeps the tour mounted: its render gate is `steps[index]`.
 */
export function resolveTourPosition(
	steps: readonly OnboardingStep[],
	stepId: string | null,
): number {
	if (steps.length === 0) {
		return 0;
	}
	if (!stepId) {
		return 0;
	}
	const surviving = steps.findIndex((step) => step.id === stepId);
	if (surviving !== -1) {
		return surviving;
	}
	const wasAt = ONBOARDING_STEPS.findIndex((step) => step.id === stepId);
	for (let i = wasAt + 1; i >= 0 && i < ONBOARDING_STEPS.length; i++) {
		const next = steps.findIndex(
			(step) => step.id === ONBOARDING_STEPS[i].id,
		);
		if (next !== -1) {
			return next;
		}
	}
	return steps.length - 1;
}

/**
 * Areas the tour MUST always cover. The drift test asserts
 * each has at least one enabled step; dropping one fails CI.
 */
export const ONBOARDING_REQUIRED_AREAS: readonly OnboardingArea[] = [
	"aiKey",
	"assistant",
	"projects",
	"overview",
	"documents",
	"roadmap",
	"proposals",
	"atlas",
	"apiKey",
];

/** Every `data-onboarding-target` id a step depends on (for the drift test). */
export function anchorIdsUsedBySteps(): string[] {
	const ids = new Set<string>();
	for (const step of ONBOARDING_STEPS) {
		if (step.target.kind === "anchor") {
			ids.add(step.target.anchorId);
		} else if (step.target.kind === "projectComponent") {
			ids.add(step.target.anchorId);
		} else if (step.target.kind === "projectTab") {
			ids.add(anchorForProjectTab(step.target.tab));
		}
	}
	return [...ids];
}
