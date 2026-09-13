"use client";

import { useRegisterFabricAgentContext } from "@saas/agents/components/FabricAgentLauncher";
import { useSession } from "@saas/auth/hooks/use-session";
import { ProjectRoleConfirmationPrompt } from "@saas/get-started/components/ProjectRoleConfirmationPrompt";
import {
	GET_STARTED_PAGES_REVEALED_EVENT,
	GET_STARTED_PROJECT_TAB_EVENT,
	type PagesRevealedEventDetail,
} from "@saas/get-started/lib/tour-steps";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { CustomizeProjectTabsDialog } from "@saas/projects/components/CustomizeProjectTabsDialog";
import { CliConnectionNudge } from "@saas/projects/components/cli-connection/CliConnectionNudge";
import { ProjectReadinessPanel } from "@saas/projects/components/readiness/ProjectReadinessPanel";
import { useRecordProjectVisit } from "@saas/projects/hooks/use-record-project-visit";
import {
	resolveProjectTabPaint,
	resolveProjectTabs,
	useProjectTabCustomization,
	useProjectTabGates,
} from "@saas/projects/lib/project-tab-preferences";
import {
	isBetaTab,
	isTabId,
	type TabId,
	tabs,
} from "@saas/projects/lib/project-tabs";
import { useConfirmationAlert } from "@saas/shared/components/ConfirmationAlertProvider";
import { useFeatureFlag } from "@saas/shared/components/FeatureFlagProvider";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { useFocusMode } from "@saas/shared/contexts/FocusModeContext";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ui/components/popover";
import { Skeleton } from "@ui/components/skeleton";
import { cn } from "@ui/lib";
import {
	AlertTriangleIcon,
	CheckCircleIcon,
	ChevronDownIcon,
	CodeIcon,
	ExternalLinkIcon,
	FolderIcon,
	GithubIcon,
	Loader2Icon as Loader2,
	RotateCcwIcon,
	Settings2Icon,
	Trash2Icon,
	XIcon,
} from "lucide-react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
	startTransition,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import {
	type ContextChangeEvent,
	type DocumentChangeEvent,
	useProjectPresence,
} from "../hooks";
import { AgentActivityTab } from "./AgentActivityTab";
// ProjectHeader is always visible, keep static import
import { ProjectHeader } from "./ProjectHeader";
import { ProjectPresenceProvider } from "./ProjectPresenceProvider";
import { ProjectSectionHero } from "./ProjectSectionHero";
import { ProjectTabButton } from "./ProjectTabButton";
import {
	NAVIGATE_TO_SETTINGS_TAB_EVENT,
	type NavigateToSettingsTabDetail,
} from "./settings-tab-navigation";
import { useProjectTabDeepLink } from "./use-project-tab-deep-link";

// Tab content skeleton with fixed height to prevent CLS
function TabContentSkeleton() {
	return (
		<div className="space-y-4" style={{ minHeight: "500px" }}>
			<div className="flex items-center justify-between">
				<Skeleton className="h-8 w-48" />
				<Skeleton className="h-10 w-32" />
			</div>
			<Skeleton className="h-64 w-full" />
			<div className="grid grid-cols-2 gap-4">
				<Skeleton className="h-32 w-full" />
				<Skeleton className="h-32 w-full" />
			</div>
		</div>
	);
}

// Dynamic imports for tab components - only load when tab is active
// Each tab component is 50-200KB, lazy loading significantly reduces initial bundle
const ProjectOverview = dynamic(
	() => import("./ProjectOverview").then((m) => m.ProjectOverview),
	{ loading: () => <TabContentSkeleton />, ssr: false },
);

const DocumentsList = dynamic(
	() => import("./DocumentsList").then((m) => m.DocumentsList),
	{ loading: () => <TabContentSkeleton />, ssr: false },
);

const ProjectContextsList = dynamic(
	() => import("./ProjectContextsList").then((m) => m.ProjectContextsList),
	{ loading: () => <TabContentSkeleton />, ssr: false },
);

const DiagramsList = dynamic(
	() => import("./DiagramsList").then((m) => m.DiagramsList),
	{ loading: () => <TabContentSkeleton />, ssr: false },
);

const ProjectPipeline = dynamic(
	() => import("./ProjectPipeline").then((m) => m.ProjectPipeline),
	{ loading: () => <TabContentSkeleton />, ssr: false },
);

const StoriesRoadmap = dynamic(
	() => import("./stories").then((m) => m.StoriesRoadmap),
	{ loading: () => <TabContentSkeleton />, ssr: false },
);

const TestCasesList = dynamic(
	() => import("./test-cases").then((m) => m.TestCasesList),
	{ loading: () => <TabContentSkeleton />, ssr: false },
);

const PublishingSuiteList = dynamic(
	() =>
		import("@saas/projects/components/publishing-suite").then(
			(m) => m.PublishingSuiteList,
		),
	{ loading: () => <TabContentSkeleton />, ssr: false },
);

const ProjectReports = dynamic(
	() => import("./ProjectReports").then((m) => m.ProjectReports),
	{ loading: () => <TabContentSkeleton />, ssr: false },
);

const ProjectUsage = dynamic(
	() => import("./ProjectUsage").then((m) => m.ProjectUsage),
	{ loading: () => <TabContentSkeleton />, ssr: false },
);

const _ArtifactBrowser = dynamic(
	() =>
		import("@saas/artifacts/components/ArtifactBrowser").then(
			(m) => m.ArtifactBrowser,
		),
	{ loading: () => <TabContentSkeleton />, ssr: false },
);

const ProjectSettings = dynamic(
	() => import("./ProjectSettings").then((m) => m.ProjectSettings),
	{ loading: () => <TabContentSkeleton />, ssr: false },
);

const ProjectAtlas = dynamic(
	() => import("./atlas/ProjectAtlas").then((m) => m.ProjectAtlas),
	{ loading: () => <TabContentSkeleton />, ssr: false },
);

const WeaveDashboard = dynamic(
	() => import("@saas/weave/components").then((m) => m.WeaveDashboard),
	{ loading: () => <TabContentSkeleton />, ssr: false },
);

const DailyBriefTab = dynamic(
	() => import("@saas/daily-brief/components").then((m) => m.DailyBriefTab),
	{ loading: () => <TabContentSkeleton />, ssr: false },
);

const MeetingDigestTab = dynamic(
	() =>
		import("@saas/meeting-digest/components").then(
			(m) => m.MeetingDigestTab,
		),
	{ loading: () => <TabContentSkeleton />, ssr: false },
);

const ReleaseNotesList = dynamic(
	() => import("./ReleaseNotesList").then((m) => m.ReleaseNotesList),
	{ loading: () => <TabContentSkeleton />, ssr: false },
);

const DecisionsList = dynamic(
	() => import("./decisions/DecisionsList").then((m) => m.DecisionsList),
	{ loading: () => <TabContentSkeleton />, ssr: false },
);

const ProjectKanbanRouteView = dynamic(
	() =>
		import("./kanban/ProjectKanbanRouteView").then(
			(m) => m.ProjectKanbanRouteView,
		),
	{ loading: () => <TabContentSkeleton />, ssr: false },
);

const SecurityAccessibilityPage = dynamic(
	() => import("./security").then((m) => m.SecurityAccessibilityPage),
	{ loading: () => <TabContentSkeleton />, ssr: false },
);

/**
 * How the "More" menu groups the tabs that do not fit on the row. The row
 * itself keeps the viewer's saved order; only the overflow is grouped, by what
 * the tab is for, so a tab that has fallen off the row is still easy to find.
 */
const TAB_GROUPS: ReadonlyArray<{ label: string; ids: readonly TabId[] }> = [
	{
		label: "Plan",
		ids: [
			"overview",
			"stories",
			"documents",
			"decisions",
			"context",
			"diagrams",
			"atlas",
		],
	},
	{
		label: "Build",
		ids: [
			"pipeline",
			"kanban",
			"agent-activity",
			"weave",
			"test-cases",
			"security",
		],
	},
	{
		label: "Communicate",
		ids: [
			"daily-brief",
			"meeting-digest",
			"release-notes",
			"publishing-suite",
			"reports",
		],
	},
	{ label: "Manage", ids: ["usage", "settings"] },
];

/** Room the "More" trigger needs once the row overflows, gap included. */
const MORE_TRIGGER_RESERVE_PX = 112;
const TAB_GAP_PX = 4;

type Props = {
	projectId: string;
	organizationSlug?: string;
};

// Tab-scoped (sessionStorage) key for persisting the active project tab. Must
// NOT use localStorage: that is shared across every browser tab of the origin,
// so refreshing one tab would adopt whatever tab another tab last selected.
const TAB_STORAGE_KEY = "fabric-project-active-tab";

// Progress banner for code-based project setup
function CodeAnalysisBanner({
	projectId,
	onComplete,
}: {
	projectId: string;
	onComplete: () => void;
}) {
	const { organizationId } = useOrganizationContext();
	const [dismissed, setDismissed] = useState(false);
	const prevPhaseRef = useRef<string | null>(null);

	const { data: statusData } = useQuery({
		queryKey: ["code-analysis-status", projectId, organizationId],
		queryFn: () =>
			orpcClient.projects.github.setupStatus({
				projectId,
				organizationId: organizationId ?? null,
			}),
		refetchInterval: 5000,
		enabled: !dismissed,
	});

	const phase = statusData?.phase;
	const status = statusData?.codeAnalysisStatus;

	// When status transitions to completed or failed, notify parent
	useEffect(() => {
		if (
			prevPhaseRef.current &&
			prevPhaseRef.current !== phase &&
			(phase === "completed" || phase === "failed")
		) {
			onComplete();
			if (phase === "completed") {
				toast.success("Your documents are ready!", {
					description:
						"Code analysis is complete and all documents have been generated.",
				});
			}
		}
		prevPhaseRef.current = phase ?? null;
	}, [phase, onComplete]);

	if (dismissed) {
		return null;
	}
	if (!status || status === "COMPLETED" || status === "FAILED") {
		return null;
	}

	const phaseLabel =
		phase === "scanning"
			? "Scanning repository..."
			: phase === "generating"
				? "Generating documents..."
				: "Analyzing...";

	const docStatuses = statusData?.documents ?? [];
	const totalDocs = docStatuses.length;
	const completedDocs = docStatuses.filter(
		(d: { status: string }) =>
			d.status === "COMPLETE" ||
			d.status === "PUBLISHED" ||
			d.status === "DRAFT",
	).length;

	return (
		<div className="rounded-xl border border-primary/20 bg-primary/5 p-4">
			<div className="flex items-start gap-3">
				<div className="rounded-lg bg-primary/10 p-2">
					<GithubIcon className="size-5 text-primary" />
				</div>
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<Loader2 className="size-4 animate-spin text-primary" />
						<p className="font-medium text-sm">{phaseLabel}</p>
					</div>
					<p className="text-xs text-muted-foreground mt-1">
						This typically takes about 10 minutes. You can navigate
						away — we'll notify you when it's done.
					</p>

					{/* Phase Progress */}
					<div className="flex items-center gap-4 mt-3">
						<div className="flex items-center gap-1.5">
							{phase === "scanning" ? (
								<Loader2 className="size-3 animate-spin text-primary" />
							) : (
								<CheckCircleIcon className="size-3 text-success" />
							)}
							<span
								className={cn(
									"text-xs",
									phase === "scanning"
										? "text-foreground font-medium"
										: "text-muted-foreground",
								)}
							>
								Scan code
							</span>
						</div>
						<div className="h-px flex-1 max-w-8 bg-foreground/10" />
						<div className="flex items-center gap-1.5">
							{phase === "generating" ? (
								<Loader2 className="size-3 animate-spin text-primary" />
							) : phase === "completed" ? (
								<CheckCircleIcon className="size-3 text-success" />
							) : (
								<CodeIcon className="size-3 text-muted-foreground" />
							)}
							<span
								className={cn(
									"text-xs",
									phase === "generating"
										? "text-foreground font-medium"
										: "text-muted-foreground",
								)}
							>
								Generate docs{" "}
								{phase === "generating" && totalDocs > 0
									? `(${completedDocs}/${totalDocs})`
									: ""}
							</span>
						</div>
					</div>
				</div>
				<button
					type="button"
					onClick={() => setDismissed(true)}
					className="shrink-0 text-muted-foreground hover:text-foreground"
				>
					<XIcon className="size-4" />
				</button>
			</div>
		</div>
	);
}

export function ProjectDetails({ projectId, organizationSlug }: Props) {
	const _t = useTranslations();
	const router = useRouter();
	const { user } = useSession();
	const { organizationId, basePath } = useOrganizationContext();
	const queryClient = useQueryClient();
	const { confirm } = useConfirmationAlert();

	const { isFocusMode, setIsFocusMode } = useFocusMode();

	// Per-user/per-project tab visibility + ordering (card #1837). Both
	// documents load in parallel with projects.get and share the cache with
	// the Get-Started controller.
	const tabCustomization = useProjectTabCustomization({
		projectId,
	});

	// Raw selection (sessionStorage / deep links may name any known tab); see
	// `activeTab` further down for the viewer-resolved value.
	const [rawActiveTab, setActiveTab] = useState<TabId>(() => {
		if (typeof window === "undefined") {
			return "overview";
		}
		const stored = sessionStorage.getItem(
			`${TAB_STORAGE_KEY}-${projectId}`,
		);
		if (stored && isTabId(stored)) {
			return stored;
		}
		return "overview";
	});

	// Reset Focus Mode on tab switch so switching to non-Atlas tabs restores standard chrome
	useEffect(() => {
		setIsFocusMode(false);
	}, [rawActiveTab, setIsFocusMode]);

	const tabGates = useProjectTabGates();

	// Decoration, not a gate — deliberately separate from `tabGates`, which
	// decides which tabs EXIST for this viewer. A beta tab is a visible tab.
	const showBetaLabel = useFeatureFlag("PUBLISHING_SUITE_BETA_LABEL");

	// The tab set this viewer can see, in their saved order. While a tab's
	// feature gate is off (or before the preference queries resolve) this is
	// simply the full static list in its default order.
	const visibleTabs = useMemo(
		() =>
			resolveProjectTabs(tabs, {
				config: tabCustomization.config,
				prefs: tabCustomization.prefs,
				gates: tabGates,
			}),
		[tabCustomization.config, tabCustomization.prefs, tabGates],
	);

	// The active tab as THIS viewer should see it: a stored or deep-linked tab
	// that is no longer visible for them (admin disabled it, personal pref,
	// stale sessionStorage) falls back silently to Overview — the same
	// treatment an unrecognized `?tab=` value already gets. Pure derivation,
	// so there is no window where content renders for a hidden tab.
	const activeTab: TabId = visibleTabs.some((t) => t.id === rawActiveTab)
		? rawActiveTab
		: "overview";

	/**
	 * The trailing breadcrumb crumb: the active tab's own label, or `null` on
	 * Overview.
	 *
	 * Overview IS the project, so naming it again would read as a level of
	 * nesting that is not there. Everything else is a section the reader
	 * navigated into, and the trail should say which.
	 */
	const activeTabLabel =
		activeTab === "overview"
			? null
			: (visibleTabs.find((tab) => tab.id === activeTab)?.label ?? null);

	// Announce visibility transitions (card #1837): when tabs become visible
	// again for this viewer — admin re-enabled one, or a personal hide was
	// lifted — Get Started replays that page's first-visit experience once.
	// Skipped on the very first pass, where everything "appears" revealed.
	const prevVisibleIdsRef = useRef<string[] | null>(null);
	useEffect(() => {
		const ids = visibleTabs.map((t) => t.id);
		const prev = prevVisibleIdsRef.current;
		prevVisibleIdsRef.current = ids;
		if (prev === null) {
			return;
		}
		const revealed = ids.filter((id) => !prev.includes(id));
		if (revealed.length > 0) {
			window.dispatchEvent(
				new CustomEvent<PagesRevealedEventDetail>(
					GET_STARTED_PAGES_REVEALED_EVENT,
					{ detail: { pageIds: revealed } },
				),
			);
		}
	}, [visibleTabs]);

	// Honor a `?tab=<id>` deep link so cross-page CTAs land on the intended
	// tab: the PM-credentials CTAs and Kanban "Check Configuration" send
	// `?tab=settings`, the document editor's back links `?tab=documents`, the
	// sync-log/proposal routes `?tab=stories`, the get-started tour any tab.
	// The param is consumed ONCE and stripped from the URL. Left in place it
	// goes stale on the next manual tab switch (which never rewrites the URL)
	// and then reasserts itself through any unrelated query write — the
	// Roadmap search box preserves foreign params when it writes `?q=`, which
	// used to yank the user back to the stale tab on the first keystroke.
	// Unrecognized values (`?tab=bogus`) are neither applied nor stripped — see
	// the hook's doc comment. The sessionStorage persistence effect below then
	// records the resolved tab as usual.
	const tabDeepLink = useProjectTabDeepLink(isTabId);
	useEffect(() => {
		if (tabDeepLink) {
			setActiveTab(tabDeepLink.tab);
		}
	}, [tabDeepLink]);

	// Deep link into a Project Settings sub-tab (Atlas "Reconnect", the Release
	// Notes gear). The sub-tab is written to sessionStorage by the dispatcher
	// BEFORE the event fires, so when `ProjectSettings` mounts here its
	// `useSettingsTab` initializer reads it. Pure client-side switch — no reload.
	useEffect(() => {
		const handler = (event: Event) => {
			const detail = (event as CustomEvent<NavigateToSettingsTabDetail>)
				.detail;
			if (detail?.projectId === projectId) {
				setActiveTab("settings");
			}
		};
		window.addEventListener(NAVIGATE_TO_SETTINGS_TAB_EVENT, handler);
		return () =>
			window.removeEventListener(NAVIGATE_TO_SETTINGS_TAB_EVENT, handler);
	}, [projectId]);

	const tabRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
	// Callback-ref state: the tab row isn't in the DOM during the loading
	// skeleton render, so a plain object ref would attach after the only effect
	// run. Storing the node in state lets the effect (re-)run when it mounts.
	const [tabRow, setTabRow] = useState<HTMLDivElement | null>(null);
	// Overflow folds into a "More" menu instead of scrolling off-screen. The
	// row shows the viewer's tabs in their order until the width runs out, and
	// `inlineCount` is how many fit. Infinity means all of them — which is also
	// the value under jsdom, where nothing has a width, so tests see every tab.
	const [inlineCount, setInlineCount] = useState(Number.POSITIVE_INFINITY);
	const [moreOpen, setMoreOpen] = useState(false);

	// Settings is pinned at the right end of the bar rather than competing for
	// row space: it is the one tab every project has, and the one people find
	// by position.
	const rowTabs = useMemo(
		() => visibleTabs.filter((tab) => tab.id !== "settings"),
		[visibleTabs],
	);
	const settingsTab = visibleTabs.find((tab) => tab.id === "settings");

	useEffect(() => {
		const el = tabRow;
		if (!el) {
			return;
		}
		const update = () => {
			const width = el.clientWidth;
			if (width <= 0) {
				return;
			}
			// Every row tab stays mounted — an overflowed one is visibility:
			// hidden and out of flow — so each has a real width to measure.
			const widths = rowTabs.map(
				(tab) => tabRefs.current.get(tab.id)?.offsetWidth ?? 0,
			);
			const total = widths.reduce((sum, w) => sum + w + TAB_GAP_PX, 0);
			if (total <= width) {
				setInlineCount(Number.POSITIVE_INFINITY);
				return;
			}
			const available = width - MORE_TRIGGER_RESERVE_PX;
			let used = 0;
			let count = 0;
			for (const w of widths) {
				if (used + w + TAB_GAP_PX > available) {
					break;
				}
				used += w + TAB_GAP_PX;
				count += 1;
			}
			setInlineCount(count);
		};
		update();
		const ro = new ResizeObserver(update);
		ro.observe(el);
		return () => ro.disconnect();
	}, [tabRow, rowTabs]);

	const overflowTabs = useMemo(
		() => rowTabs.filter((_, index) => index >= inlineCount),
		[rowTabs, inlineCount],
	);
	const activeOverflowTab = overflowTabs.find((tab) => tab.id === activeTab);
	const overflowGroups = useMemo(
		() =>
			TAB_GROUPS.map((group) => ({
				label: group.label,
				tabs: overflowTabs.filter((tab) => group.ids.includes(tab.id)),
			})).filter((group) => group.tabs.length > 0),
		[overflowTabs],
	);
	const tabLabel = (tab: (typeof tabs)[number]) =>
		tab.id === "atlas" ? _t("projects.atlas.tabLabel") : tab.label;

	const [kanbanStandaloneUrl, setKanbanStandaloneUrl] = useState<
		string | null
	>(null);

	// Customize-tabs dialog state (card #1837); opened from the tab bar.
	const [customizeOpen, setCustomizeOpen] = useState(false);

	// Persist tab selection to sessionStorage (tab-scoped, see TAB_STORAGE_KEY)
	useEffect(() => {
		sessionStorage.setItem(`${TAB_STORAGE_KEY}-${projectId}`, activeTab);
		// Let the Get-Started controller know which page is on screen so it can
		// drive per-page tours (the active tab is client state, not the URL).
		// Deferred one tick: the controller lives in the app shell (a parent),
		// whose listener attaches after this child effect, so a synchronous
		// dispatch on first mount would be missed.
		const id = setTimeout(() => {
			window.dispatchEvent(
				new CustomEvent(GET_STARTED_PROJECT_TAB_EVENT, {
					detail: { projectId, tab: activeTab },
				}),
			);
		}, 0);
		return () => clearTimeout(id);
	}, [activeTab, projectId]);

	// Wait for org context to load on org routes before querying
	// organizationSlug indicates we're on an org route and need the org context
	const isOrgRoute = !!organizationSlug;
	const orgContextReady = !isOrgRoute || organizationId !== undefined;

	// IMPORTANT: Pass null explicitly for personal context to prevent
	// session fallback which could leak org data to personal pages
	const {
		data,
		isLoading: isQueryLoading,
		refetch,
	} = useQuery({
		...orpc.projects.get.queryOptions({
			input: { id: projectId, organizationId },
		}),
		enabled: orgContextReady,
	});

	// Include org context and tab-preference loading in the overall gate so
	// neither the tab bar nor a content branch paints a set it is about to
	// hide. The preference queries run in parallel with projects.get and are
	// cached across consumers, so this adds no extra round trip.
	const isLoading =
		isQueryLoading || !orgContextReady || !tabCustomization.ready;
	const project = data?.project;

	// Quick-access shortcuts (#1694). Gated on the project having actually
	// resolved and not being soft-deleted, so the not-found and restore views
	// below never record a visit. Not gated by the feature flag — see the hook.
	useRecordProjectVisit({
		projectId,
		organizationId: organizationId ?? null,
		enabled: !!project && !project.deletedAt,
	});

	// Feed the global Fabric Agent a BOUNDED summary of the test cases the user
	// is viewing — fetched only while the QA tab is active (so no cost on
	// any other tab) and capped at 20 rows. Makes the bottom-circle agent
	// test-case-aware on the page without embedding the full list.
	const testCasesContextQuery = useQuery({
		...orpc.projects.testCases.list.queryOptions({
			input: {
				projectId,
				organizationId: organizationId ?? null,
				limit: 20,
				includeSummary: true,
			},
		}),
		enabled: orgContextReady && activeTab === "test-cases",
		staleTime: 30_000,
	});
	const testCasesContext = useMemo(() => {
		const d = testCasesContextQuery.data;
		if (!d || d.total === 0) {
			return null;
		}
		const rows = (d.items ?? [])
			.slice(0, 15)
			.map((c) => {
				const status =
					c.currentResult && c.currentResult !== "NOT_RUN"
						? c.currentResult
						: c.state;
				return `${c.identifier}: ${c.title}${status ? ` [${status}]` : ""}`;
			})
			.join("; ");
		const more = d.total > 15 ? ` …and ${d.total - 15} more` : "";
		return `${d.total} test case(s) in this project — ${rows}${more}`;
	}, [testCasesContextQuery.data]);

	const fabricAgentContext = useMemo(() => {
		const base = project
			? {
					projectId,
					projectName: project.name,
					repositoryUrl: project.repositoryUrl ?? null,
					repositoryOwner: project.repositoryOwner ?? null,
					repositoryName: project.repositoryName ?? null,
					prompt: "Answer using the current project context, roadmap, documents, attached files, links, transcripts, codebase, and related feature context when relevant.",
				}
			: {
					projectId,
					prompt: "Answer using the current project context, attached artifacts, and related feature context when relevant.",
				};
		return testCasesContext ? { ...base, testCasesContext } : base;
	}, [project, projectId, testCasesContext]);

	useRegisterFabricAgentContext(fabricAgentContext);

	// Handle real-time document and context changes
	const handleDocumentChange = useCallback(
		(_event: DocumentChangeEvent) => {
			// Refetch project data when documents change
			refetch();
		},
		[refetch],
	);

	const handleContextChange = useCallback(
		(_event: ContextChangeEvent) => {
			// Refetch project data when contexts change
			refetch();
		},
		[refetch],
	);

	// The project page's ONE presence connection. It stays here, above the
	// loading / not-found / deleted branches, so join and leave don't churn as
	// those branches flip. Everything else on the page that needs presence
	// reads it from the provider below instead of calling the hook again —
	// a second call is a second join, heartbeat interval and SSE stream.
	const presence = useProjectPresence({
		projectId,
		activeTab,
		onDocumentChange: handleDocumentChange,
		onContextChange: handleContextChange,
		enabled: !!user?.id,
	});

	// Restore mutation for deleted projects
	const restoreMutation = useMutation({
		mutationFn: async () => {
			return await orpcClient.projects.restore({ id: projectId });
		},
		onSuccess: () => {
			toast.success("Project restored successfully");
			queryClient.invalidateQueries({ queryKey: ["projects"] });
			refetch();
		},
		onError: (error) => {
			toast.error("Failed to restore project", {
				description:
					error instanceof Error ? error.message : String(error),
			});
		},
	});

	// Permanent delete mutation for deleted projects
	const permanentDeleteMutation = useMutation({
		mutationFn: async () => {
			return await orpcClient.projects.permanentDelete({ id: projectId });
		},
		onSuccess: () => {
			toast.success("Project permanently deleted");
			queryClient.invalidateQueries({ queryKey: ["projects"] });
			router.push(basePath ? `${basePath}/projects` : "/app/projects");
		},
		onError: (error) => {
			toast.error("Failed to permanently delete project", {
				description:
					error instanceof Error ? error.message : String(error),
			});
		},
	});

	const handleRestore = () => {
		restoreMutation.mutate();
	};

	const handlePermanentDelete = (projectName: string) => {
		confirm({
			title: "Permanently Delete Project",
			message: `Are you sure you want to PERMANENTLY delete "${projectName}"? This will delete all documents, contexts, and data. This action CANNOT be undone.`,
			confirmLabel: "Delete Forever",
			cancelLabel: "Cancel",
			destructive: true,
			onConfirm: () => {
				permanentDeleteMutation.mutate();
			},
		});
	};

	// Calculate days until permanent deletion for deleted projects
	const getDaysUntilDeletion = (
		scheduledDate: Date | string | null | undefined,
	) => {
		if (!scheduledDate) {
			return null;
		}
		const deleteDate = new Date(scheduledDate);
		const now = new Date();
		const diffMs = deleteDate.getTime() - now.getTime();
		const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
		return diffDays;
	};

	if (isLoading) {
		return (
			<div className="space-y-6">
				<Skeleton className="h-32 w-full rounded-xl" />
				<Skeleton className="h-12 w-full rounded-xl" />
				<Skeleton className="h-96 w-full rounded-xl" />
			</div>
		);
	}

	if (!project) {
		return (
			<div className="flex flex-col items-center justify-center py-12">
				<div className="mb-4 rounded-2xl bg-muted p-4">
					<FolderIcon className="size-8 text-muted-foreground" />
				</div>
				<p className="mb-2 font-medium text-foreground/70">
					Project not found
				</p>
				<p className="mb-6 text-foreground/50 text-sm">
					The project you're looking for doesn't exist or has been
					deleted.
				</p>
				<Button
					onClick={() => router.push("/app/projects")}
					className="gap-2"
				>
					Back to Projects
				</Button>
			</div>
		);
	}

	// Show deleted project view if the project is soft-deleted
	if (project.deletedAt) {
		const canDeleteProject = project.userRole === "owner";
		if (!canDeleteProject) {
			return (
				<div className="flex flex-col items-center justify-center py-12">
					<div className="mb-4 rounded-2xl bg-muted p-4">
						<FolderIcon className="size-8 text-muted-foreground" />
					</div>
					<p className="mb-2 font-medium text-foreground/70">
						Project not found
					</p>
					<p className="mb-6 text-foreground/50 text-sm">
						The project you're looking for doesn't exist or you
						don't have access.
					</p>
					<Button
						onClick={() =>
							router.push(
								basePath
									? `${basePath}/projects`
									: "/app/projects",
							)
						}
						className="gap-2"
					>
						Back to Projects
					</Button>
				</div>
			);
		}
		const daysUntilDeletion = getDaysUntilDeletion(
			project.scheduledPermanentDeleteAt,
		);
		const projectsUrl = basePath ? `${basePath}/projects` : "/app/projects";

		return (
			<div className="space-y-6">
				{/* Breadcrumb */}
				<PageBreadcrumbs
					items={[
						{ label: "Projects", href: projectsUrl },
						{ label: project.name },
					]}
				/>

				{/* Deleted Project Warning Card */}
				<div className="flex flex-col items-center justify-center py-12">
					<div className="mb-6 rounded-2xl bg-destructive/10 p-6">
						<AlertTriangleIcon className="size-12 text-destructive" />
					</div>

					<h2 className="mb-2 font-bold text-2xl text-foreground">
						{project.name}
					</h2>

					<p className="mb-2 font-medium text-foreground/70">
						This project is in the trash
					</p>

					<p className="mb-4 text-foreground/50 text-sm text-center max-w-md">
						{canDeleteProject
							? "This project was deleted and is scheduled for permanent removal. You can restore it to continue working on it, or delete it permanently."
							: "This project was deleted and is scheduled for permanent removal."}
					</p>

					{/* Countdown */}
					{daysUntilDeletion !== null && (
						<div className="mb-6 px-4 py-2 rounded-lg bg-destructive/10 border border-destructive/20">
							<p className="text-destructive font-medium text-sm">
								{daysUntilDeletion <= 0
									? "Will be permanently deleted soon"
									: daysUntilDeletion === 1
										? "1 day until permanent deletion"
										: `${daysUntilDeletion} days until permanent deletion`}
							</p>
						</div>
					)}

					{/* Actions */}
					<div className="flex flex-col sm:flex-row gap-3">
						{canDeleteProject && (
							<>
								<Button
									variant="outline"
									onClick={handleRestore}
									disabled={restoreMutation.isPending}
									className="gap-2"
								>
									<RotateCcwIcon className="size-4" />
									{restoreMutation.isPending
										? "Restoring..."
										: "Restore Project"}
								</Button>

								<Button
									variant="destructive"
									onClick={() =>
										handlePermanentDelete(project.name)
									}
									disabled={permanentDeleteMutation.isPending}
									className="gap-2"
								>
									<Trash2Icon className="size-4" />
									{permanentDeleteMutation.isPending
										? "Deleting..."
										: "Delete Permanently"}
								</Button>
							</>
						)}
					</div>

					<Button
						variant="ghost"
						onClick={() => router.push(projectsUrl)}
						className="mt-6 text-foreground/50"
					>
						Back to Projects
					</Button>
				</div>
			</div>
		);
	}

	const shouldHideChrome = isFocusMode && activeTab === "atlas";

	return (
		<div className={cn("flex-1 min-w-0 space-y-6")}>
			{/* Per-project role confirmation (Fizzy #2264, AC6-AC10). Mounted
			  BELOW the `!project` and `project.deletedAt` guards above, so it
			  can never fire on a not-found or soft-deleted view — the same
			  discipline `useRecordProjectVisit`'s `enabled` follows. The
			  component decides for itself whether to open. */}
			<ProjectRoleConfirmationPrompt
				key={`role-confirmation-${projectId}`}
				projectId={projectId}
				organizationId={organizationId ?? null}
			/>
			{!shouldHideChrome && (
				<>
					{/* Breadcrumb. Off Overview, surface the section as a
					  trailing crumb and turn the project name into a link back to the
					  project — mirrors the feature editor's "… › {project} › Roadmap"
					  trail so the location reads clearly.

					  Driven by the tab's own `label` rather than a per-tab
					  branch. It was a branch on `test-cases` alone, so every
					  other section — Publishing Suite included — showed
					  "Projects / {project}" and named nothing. Publishing Suite
					  even has its own route that DOES carry the full trail, so
					  the crumb appeared or vanished depending on how you
					  arrived, which is worse than never having it. The active
					  tab is client state, not the URL, so this is the only
					  place that knows where the reader is. */}
					<PageBreadcrumbs
						items={[
							{
								label: "Projects",
								href: basePath
									? `${basePath}/projects`
									: "/app/projects",
							},
							...(activeTabLabel
								? [
										{
											label: project.name,
											href: `${basePath || "/app"}/projects/${project.id}`,
										},
										{ label: activeTabLabel },
									]
								: [{ label: project.name }]),
						]}
					/>

					{/* The provider has to enclose every presence consumer on
					    the page. Today that is just the avatar stack inside
					    ProjectHeader; anything else that needs presence goes
					    inside here too rather than calling the hook again. */}
					<ProjectPresenceProvider value={presence}>
						<ProjectHeader
							project={project}
							currentUserId={user?.id}
							organizationId={organizationId}
							canEdit={
								project.userRole === "owner" ||
								project.userRole === "editor"
							}
						/>
					</ProjectPresenceProvider>

					{/* Readiness panel. Sits in the banner slot directly beneath the
					    title — the "project header/title area" the criteria ask for
					    — rather than in the route-group layout, which can only
					    render above the breadcrumb. Mounting it here also tells the
					    layout's fallback to stand down. */}
					<ProjectReadinessPanel />
				</>
			)}

			{/* The CLI-connection prompt (Fizzy #2457, R3). Same banner slot,
			    directly below the checklist it reads from — the prompt and the
			    "API Key for CLI" row its copy names are then in one place, so a
			    reader who dismisses the prompt can see where the option persists
			    rather than take our word for it.

			    Mounted OUTSIDE the chrome block above — the reason
			    `ProjectRoleConfirmationPrompt` is too — and hidden with a prop
			    rather than by that condition. Focus Mode is a toggle on this
			    page, not a navigation: unmounting the prompt for it would reset
			    the prompt's per-mount onboarding-yield latch and re-fire its
			    render event, counting one impression twice within a single
			    project visit. Its position between the readiness panel and the
			    scan banner is unchanged, and while hidden it occupies no space —
			    `space-y-*` skips a `[hidden]` child.

			    Keyed by project for the reason the role-confirmation prompt
			    above is: this page does not remount between projects,
			    and that latch is per-mount. Without it, a tour taken on one
			    project would keep the prompt suppressed on the next.

			    The project's name is passed straight from the object this
			    component already holds — the issuing view names the project in
			    its starter instruction, and that is not worth a second read of a
			    project already on screen. */}
			<CliConnectionNudge
				key={`cli-nudge-${projectId}`}
				hidden={shouldHideChrome}
				organizationId={organizationId ?? null}
				organizationSlug={organizationSlug}
				projectName={project.name}
			/>

			{/* Code Analysis Progress Banner */}
			{!shouldHideChrome && project.codeAnalysisStatus === "SCANNING" && (
				<CodeAnalysisBanner
					projectId={projectId}
					onComplete={() => refetch()}
				/>
			)}

			{/* Enhanced Tabs */}
			<div className="min-w-0 w-full">
				<div className={shouldHideChrome ? "hidden" : undefined}>
					{/* Tab bar — one hairline row. The viewer's tabs run in their
					    saved order; whatever does not fit folds into a "More" menu
					    grouped by what the tab is for, and Settings is pinned at the
					    right edge beside the customize control. Nothing scrolls, so
					    no tab is ever hidden by position alone. */}
					<div className="flex items-end gap-2 border-b border-border">
						<div
							ref={setTabRow}
							className="relative flex min-w-0 flex-1 items-end gap-1 overflow-hidden"
						>
							{rowTabs.map((tab, index) => (
								<ProjectTabButton
									key={tab.id}
									{...resolveProjectTabPaint(
										tab.id,
										tabCustomization.prefs,
									)}
									label={tabLabel(tab)}
									icon={tab.icon}
									isActive={activeTab === tab.id}
									anchor={`project-tab-${tab.id}`}
									beta={showBetaLabel && isBetaTab(tab.id)}
									overflowed={index >= inlineCount}
									onSelect={() => {
										startTransition(() =>
											setActiveTab(tab.id),
										);
									}}
									registerRef={(el) => {
										if (el) {
											tabRefs.current.set(tab.id, el);
										} else {
											tabRefs.current.delete(tab.id);
										}
									}}
								/>
							))}
							{overflowTabs.length > 0 && (
								<Popover
									open={moreOpen}
									onOpenChange={setMoreOpen}
								>
									<PopoverTrigger asChild>
										<button
											type="button"
											aria-haspopup="menu"
											aria-expanded={moreOpen}
											className={cn(
												"-mb-px relative flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 pt-2 pb-2.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
												activeOverflowTab
													? "border-foreground font-medium text-foreground"
													: "border-transparent text-muted-foreground hover:text-foreground",
											)}
										>
											{/* Each overflowed tab's onboarding anchor lands
											    here, so a tour step that spotlights a tab
											    the row could not fit spotlights the menu that
											    holds it instead of an invisible button. */}
											{overflowTabs.map((tab) => (
												<span
													key={tab.id}
													aria-hidden="true"
													data-onboarding-target={`project-tab-${tab.id}`}
													className="pointer-events-none absolute inset-0"
												/>
											))}
											{activeOverflowTab
												? tabLabel(activeOverflowTab)
												: "More"}
											<ChevronDownIcon
												aria-hidden="true"
												className="size-3.5 text-muted-foreground"
											/>
										</button>
									</PopoverTrigger>
									<PopoverContent
										align="end"
										sideOffset={6}
										className="w-60 rounded-xl p-1.5"
									>
										<div
											role="menu"
											aria-label="More tabs"
											className="space-y-1"
										>
											{overflowGroups.map((group) => (
												<div key={group.label}>
													<p className="px-2.5 pt-2 pb-1 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
														{group.label}
													</p>
													{group.tabs.map((tab) => {
														const Icon = tab.icon;
														const isActive =
															activeTab ===
															tab.id;
														const beta =
															showBetaLabel &&
															isBetaTab(tab.id);
														return (
															<button
																key={tab.id}
																type="button"
																role="menuitem"
																aria-label={
																	beta
																		? `${tabLabel(tab)} (Beta)`
																		: tabLabel(
																				tab,
																			)
																}
																onClick={() => {
																	setMoreOpen(
																		false,
																	);
																	startTransition(
																		() =>
																			setActiveTab(
																				tab.id,
																			),
																	);
																}}
																className={cn(
																	"flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors",
																	isActive
																		? "bg-accent text-foreground"
																		: "text-foreground/80 hover:bg-accent hover:text-foreground",
																)}
															>
																<Icon
																	aria-hidden="true"
																	className="size-4 shrink-0 text-muted-foreground"
																/>
																{tabLabel(tab)}
																{beta && (
																	<span className="ml-auto rounded-sm bg-highlight/15 px-1 py-px font-medium text-[10px] text-highlight uppercase tracking-wide">
																		Beta
																	</span>
																)}
															</button>
														);
													})}
												</div>
											))}
										</div>
									</PopoverContent>
								</Popover>
							)}
						</div>
						<div className="flex shrink-0 items-end gap-1">
							{settingsTab && (
								<ProjectTabButton
									{...resolveProjectTabPaint(
										settingsTab.id,
										tabCustomization.prefs,
									)}
									label={settingsTab.label}
									icon={settingsTab.icon}
									isActive={activeTab === "settings"}
									anchor="project-tab-settings"
									beta={false}
									onSelect={() => {
										startTransition(() =>
											setActiveTab("settings"),
										);
									}}
									registerRef={() => {}}
								/>
							)}
							{/* Per-user tab customization (card #1837). The dialog
							    drafts locally and persists on Done. */}
							<button
								type="button"
								onClick={() => setCustomizeOpen(true)}
								aria-label="Customize tabs"
								title="Customize tabs"
								className="mb-1.5 flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
							>
								<Settings2Icon
									aria-hidden="true"
									className="size-4 shrink-0"
								/>
							</button>
						</div>
					</div>
				</div>

				<CustomizeProjectTabsDialog
					open={customizeOpen}
					onOpenChange={setCustomizeOpen}
					tabs={tabs}
					config={tabCustomization.config}
					prefs={tabCustomization.prefs}
					saving={tabCustomization.savePrefs.isPending}
					onSave={(prefs) =>
						tabCustomization.savePrefs.mutate(prefs, {
							onSuccess: () => setCustomizeOpen(false),
							onError: (error) => {
								toast.error(
									"Couldn't save your tab preferences",
									{
										description:
											error instanceof Error
												? error.message
												: String(error),
									},
								);
							},
						})
					}
				/>

				{/* Tab Content with fade animation */}
				<div className={shouldHideChrome ? undefined : "mt-6"}>
					<div
						key={activeTab}
						className="animate-stagger"
						style={{ animationDelay: "0s" }}
					>
						{activeTab === "overview" && (
							<ProjectOverview
								project={project}
								projectId={projectId}
								organizationId={organizationId}
								onProjectUpdated={refetch}
								onNavigateToTab={setActiveTab}
							/>
						)}
						{activeTab === "daily-brief" && (
							<DailyBriefTab
								projectId={projectId}
								organizationId={organizationId ?? null}
								project={project}
							/>
						)}
						{activeTab === "meeting-digest" && (
							<MeetingDigestTab
								projectId={projectId}
								organizationId={organizationId ?? null}
								userId={user?.id ?? ""}
								// #2170: named in the import confirmation, so
								// "add this to the project" is never a question
								// about which project.
								projectName={project.name}
								canEdit={[
									"owner",
									"admin",
									"project_admin",
									"PROJECT_ADMIN",
								].includes(project.userRole as string)}
							/>
						)}
						{activeTab === "release-notes" && (
							<ReleaseNotesList project={project} />
						)}
						{activeTab === "documents" && (
							<DocumentsList
								projectId={projectId}
								enableDelete
								canEdit={
									project.userRole === "owner" ||
									project.userRole === "editor"
								}
							/>
						)}
						{activeTab === "decisions" && (
							<DecisionsList
								projectId={projectId}
								canEdit={[
									"owner",
									"editor",
									"admin",
									"project_admin",
									"PROJECT_ADMIN",
								].includes(project.userRole as string)}
								canDelete={[
									"owner",
									"admin",
									"project_admin",
									"PROJECT_ADMIN",
								].includes(project.userRole as string)}
							/>
						)}
						{activeTab === "stories" && (
							<StoriesRoadmap
								projectId={projectId}
								organizationSlug={organizationSlug}
							/>
						)}
						{activeTab === "test-cases" && (
							<TestCasesList
								projectId={projectId}
								canEdit={[
									"owner",
									"editor",
									"admin",
									"project_admin",
									"PROJECT_ADMIN",
								].includes(project.userRole as string)}
								canDelete={[
									"owner",
									"admin",
									"project_admin",
									"PROJECT_ADMIN",
								].includes(project.userRole as string)}
								generateManualTestCases={
									project.generateManualTestCases ?? true
								}
							/>
						)}
						{activeTab === "publishing-suite" && (
							<PublishingSuiteList
								projectId={projectId}
								organizationId={organizationId ?? null}
								canEdit={project.canPublish ?? false}
							/>
						)}
						{activeTab === "context" && (
							<ProjectContextsList projectId={projectId} />
						)}
						{activeTab === "diagrams" && (
							<DiagramsList projectId={projectId} />
						)}
						{activeTab === "reports" && (
							<ProjectReports projectId={projectId} />
						)}
						{activeTab === "usage" && (
							<ProjectUsage projectId={projectId} />
						)}
						{/* artifacts tab hidden
						{activeTab === "artifacts" && (
							<ArtifactBrowser projectId={projectId} />
						)} */}
						{activeTab === "pipeline" && (
							<ProjectPipeline
								projectId={projectId}
								project={project}
								onNavigateToTab={setActiveTab}
							/>
						)}
						{activeTab === "weave" && (
							<WeaveDashboard projectId={projectId} />
						)}
						{activeTab === "agent-activity" && (
							<AgentActivityTab projectId={projectId} />
						)}
						{activeTab === "kanban" && (
							<div className="space-y-6">
								<ProjectSectionHero
									eyebrow="Coding Agents"
									title="Local coding agents, built in"
									description="Run AI coding agents directly from your local repository. Pick up features, implement changes, and sync progress back to Fabric automatically."
									getStartedPageId="kanban"
									aside={
										<div
											className="flex h-full flex-col justify-center gap-4"
											data-onboarding-target="kanban-quickstart"
										>
											<p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
												Quick start
											</p>
											<ol className="space-y-3 text-sm text-muted-foreground">
												<li className="flex items-start gap-2">
													<span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">
														1
													</span>
													<span>
														Install the CLI
														<code className="ml-1.5 block mt-1 rounded bg-muted px-2 py-1 font-mono text-xs text-foreground">
															npm i -g
															@fabriccode/kanban@latest
														</code>
													</span>
												</li>
												<li className="flex items-start gap-2">
													<span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">
														2
													</span>
													<span>
														Run in embed mode from
														your repo
														<code className="ml-1.5 block mt-1 rounded bg-muted px-2 py-1 font-mono text-xs text-foreground">
															fabric-kanban
															--embed
														</code>
													</span>
												</li>
												<li className="flex items-start gap-2">
													<span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">
														3
													</span>
													<span>
														Board loads below —
														agents pick up tasks
														automatically
													</span>
												</li>
											</ol>
											{kanbanStandaloneUrl && (
												<a
													href={kanbanStandaloneUrl}
													target="_blank"
													rel="noopener noreferrer"
													className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
												>
													<ExternalLinkIcon className="h-3 w-3" />
													Open in separate tab
												</a>
											)}
										</div>
									}
								/>
								<div
									className="h-[calc(100vh-8rem)] min-h-[900px] overflow-hidden rounded-xl border border-border"
									data-onboarding-target="kanban-board"
								>
									<ProjectKanbanRouteView
										projectId={projectId}
										organizationSlug={organizationSlug}
										embedded
										onStandaloneUrlReady={(url) => {
											try {
												const parsed = new URL(url);
												setKanbanStandaloneUrl(
													`${parsed.origin}${parsed.pathname}`,
												);
											} catch {
												setKanbanStandaloneUrl(url);
											}
										}}
									/>
								</div>
							</div>
						)}
						{activeTab === "security" && (
							<SecurityAccessibilityPage
								projectId={projectId}
								organizationId={organizationId}
							/>
						)}
						{activeTab === "settings" && (
							<ProjectSettings
								project={project}
								canDelete={project.userRole === "owner"}
								tabMeta={tabs}
								currentUserId={user?.id}
							/>
						)}
						{activeTab === "atlas" && (
							<ProjectAtlas
								projectId={projectId}
								organizationSlug={organizationSlug}
							/>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
