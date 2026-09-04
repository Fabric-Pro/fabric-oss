"use client";

import { useOrganizationId } from "@saas/organizations/hooks/use-organization-context";
import {
	isProjectTabVisibleToViewer,
	useProjectTabCustomization,
	useProjectTabGates,
} from "@saas/projects/lib/project-tab-preferences";
import { useFeatureFlag } from "@saas/shared/components/FeatureFlagProvider";
import { useRoleTagSnapshot } from "@saas/shared/components/RoleTagSnapshotProvider";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SparklesIcon } from "lucide-react";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	type GsItem,
	type GsPage,
	type GsRuntimeGates,
	isNewlyIntroducedPage,
	pageForTab,
} from "../lib/get-started-registry";
import { createSessionFlag, useSessionFlag } from "../lib/session-flag";
import {
	GET_STARTED_OPEN_EVENT,
	GET_STARTED_PAGES_REVEALED_EVENT,
	GET_STARTED_PROJECT_TAB_EVENT,
	GET_STARTED_SPOTLIGHT_EVENT,
	GET_STARTED_SURFACE_EVENT,
	GET_STARTED_TOUR_PAGE_EVENT,
	type OnboardingStep,
	type PagesRevealedEventDetail,
	type ProjectTabEventDetail,
	resolveTourPosition,
	resolveTourSteps,
	type SpotlightEventDetail,
	type SurfaceEventDetail,
	type TourPageEventDetail,
} from "../lib/tour-steps";
import {
	GET_STARTED_ENABLED,
	type OnboardingAction,
	ONBOARDING_STATE_QUERY_KEY as QUERY_KEY,
	type OnboardingStateData as StateData,
	useOnboardingState,
} from "../lib/use-onboarding-state";
import { FunctionTagsOnboardingPrompt } from "./FunctionTagsOnboardingPrompt";
import { isEnforcementLive, shouldEnforce } from "./FunctionTagsRequiredGate";
import { GetStartedDrawer } from "./GetStartedDrawer";
import { GetStartedSpotlight } from "./GetStartedSpotlight";
import { GetStartedWelcomeDialog } from "./GetStartedWelcomeDialog";

/** Per-tab-session suppression for the recurring no-tags prompt (FR4). */
const tagsPromptShown = createSessionFlag("fabric:function-tags-prompt-shown");

type Mode =
	| "idle"
	| "welcome"
	| "drawer"
	| "tour"
	| "spotlight"
	| "pageTour"
	| "tagsPrompt";

/** Build a one-off spotlight step for a drawer item's "Show me". */
function adHocStepFor(item: GsItem, gates: GsRuntimeGates): OnboardingStep {
	const base: Omit<OnboardingStep, "target"> = {
		id: `show-${item.id}`,
		area: "welcome",
		icon: item.icon,
		title: item.label,
		body: item.description,
	};
	if (item.projectTab) {
		// Prefer spotlighting the page's primary in-page component over the tab
		// itself, so "Show me" points at the real thing the user will use.
		const page = pageForTab(item.projectTab, gates);
		const primary = page?.components[0];
		return {
			...base,
			target: primary
				? {
						kind: "projectComponent",
						tab: item.projectTab,
						anchorId: primary.anchor,
						side: "bottom",
					}
				: {
						kind: "projectTab",
						tab: item.projectTab,
						side: "bottom",
					},
		};
	}
	if (item.anchor) {
		return {
			...base,
			target: {
				kind: "anchor",
				anchorId: item.anchor,
				inMobileNav: true,
				side: "bottom",
				navigate: item.href
					? (basePath) => item.href?.({ basePath }) ?? basePath
					: undefined,
			},
		};
	}
	return { ...base, target: { kind: "center" } };
}

/**
 * Build the detailed page tour: one spotlight step per in-page component,
 * skipping conditional components that aren't currently mounted (e.g. the
 * proposals button when there are no proposals). We're already on the page, so
 * steps anchor directly to the in-page component.
 */
function buildPageTourSteps(page: GsPage): OnboardingStep[] {
	return page.components
		.filter(
			(c) =>
				!c.conditional ||
				document.querySelector(
					`[data-onboarding-target="${c.anchor}"]`,
				) !== null,
		)
		.map((c) => ({
			id: `page-${page.tab}-${c.id}`,
			area: "welcome",
			icon: page.icon,
			title: c.title,
			body: c.body,
			// A plain in-page anchor with NO `navigate`: page tours must not
			// carry a "Go to" CTA. That CTA would call the shared `onDismiss`,
			// which `dismissPageTour` reads as a reject → a spurious opt-out.
			target: { kind: "anchor", anchorId: c.anchor, side: "bottom" },
		}));
}

/**
 * Global controller for the "Get started" experience: the contextual drawer,
 * the guided spotlight tour, and one-off "Show me" component highlights.
 * Mounted once in the authenticated shell. Owns first-login auto-launch and
 * server-side tour progress.
 */
export function GetStartedController() {
	const { data, user } = useOnboardingState();
	const queryClient = useQueryClient();
	const pathname = usePathname();

	// The project currently on screen (tracked via ProjectDetails' tab event —
	// the active tab is client state, not the URL). Keys the tab-visibility
	// queries; null outside projects, where nothing needs filtering.
	const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
	const tabCustomization = useProjectTabCustomization({
		projectId: activeProjectId ?? "",
		enabled: activeProjectId !== null,
	});
	const tabGates = useProjectTabGates();
	// Publishing Suite's availability is per-organization, so the registry
	// hands the decision to whoever renders it. Derived from `tabGates` — the
	// same flag read, not a second one — and threaded down; the drawer takes
	// the same object.
	const gsGates: GsRuntimeGates = useMemo(
		() => ({ publishingSuite: tabGates.publishingSuiteEnabled }),
		[tabGates],
	);
	// A tour step / drawer entry pointing at a project tab this viewer can't
	// see would navigate nowhere or spotlight a missing anchor — drop it.
	const isTabVisible = useCallback(
		(tab: string) =>
			isProjectTabVisibleToViewer(
				tab,
				tabGates,
				tabCustomization.config,
				tabCustomization.prefs,
			),
		[tabGates, tabCustomization.config, tabCustomization.prefs],
	);

	// Does this viewer have a project at all? `resolveTourSteps` needs the
	// answer to collapse the project-scoped steps (Fizzy #2360 — the reasoning
	// lives on that function). Read on mount rather than lazily, so it has
	// usually settled before the welcome dialog's "Start tour" is reachable,
	// and `limit: 1` because existence is the only question.
	//
	// `includeDraft: false` is explicit, not incidental, and MUST stay in step
	// with `GetStartedSpotlight`'s own lookup — the two have to answer the
	// same question or the repeat comes straight back. If this one counted
	// drafts and that one did not, the controller would keep all five project
	// steps while the spotlight still failed to resolve a project.
	//
	// Excluding them is also the right answer on its own. `list` orders by
	// `updatedAt DESC` and takes one, so counting drafts would let a
	// half-finished draft outrank a real project and send the tour to
	// spotlight components that may not be there yet. An account whose only
	// project is still a draft hasn't finished making one — pointing it at
	// "Create your first project", once, is the correct guidance.
	const organizationId = useOrganizationId();
	const projectProbe = useQuery(
		orpc.projects.list.queryOptions({
			input: { organizationId, limit: 1, includeDraft: false },
		}),
	);
	// Only a SUCCESSFUL empty response collapses. Pending and failed both read
	// as "don't know", which `resolveTourSteps` leaves uncollapsed.
	//
	// The tempting alternative — treat a failure as "no project", since the
	// spotlight resolves through the same endpoint and turns its own errors
	// into the same card — is wrong, and the trade is worth writing down so it
	// doesn't get flipped back. Sharing an endpoint is not sharing an outcome:
	// the spotlight's lookup happens later and can succeed where this one
	// failed. Collapsing on a transient error would then hide four real steps
	// from someone who does have projects, and the freeze below would hold
	// that mistake for the whole run.
	//
	// Residual, accepted: while this endpoint is failing outright, the five
	// project steps each fall back to the same card again — the pre-#2360
	// behaviour. Nothing here can tell "no projects" from "can't reach the
	// API", and during an outage the tour is already degraded (it navigates to
	// project pages that won't load). Narrowing that to a real outage, instead
	// of every new account, is the win.
	const hasProject = projectProbe.isSuccess
		? (projectProbe.data?.projects?.length ?? 0) > 0
		: undefined;

	// Per-user session key for the recurring prompt. `user` is nullable here
	// (the hooks run before the `!user` guard), so fall back to "" — when there
	// is no user the query is disabled and the guard returns null, so the prompt
	// never opens and the empty-key read/write is inert.
	const userId = user?.id ?? "";
	// The hook re-seeds on an in-place identity change (Codex F1
	// defense-in-depth). The controller survives navigation in AppWrapper;
	// `userId` is stable across the in-place org switch and a different-user
	// login remounts this tree, so this is belt-and-suspenders — it keeps the
	// per-user session key honest if an in-place account switcher is ever added.
	const [tagsPromptShownThisSession, markTagsPromptShown] = useSessionFlag(
		tagsPromptShown,
		userId,
	);

	// Read UNCONDITIONALLY at the top level. Appending this call to the
	// `functionTagsPromptPending` chain below would short-circuit it away
	// while `data` is undefined and then invoke it once the query resolves,
	// changing the hook count between renders and crashing React.
	const roleTagEnforcement = useFeatureFlag("ROLE_TAG_ENFORCEMENT");

	// Same inputs, same predicate as `FunctionTagsRequiredGate`. This reads
	// the SAME query cache key, so it costs no extra request. `enabled`
	// mirrors the gate's own query: with the flag off, `shouldEnforce` short-
	// circuits before it ever reads `data`, so firing this request would be
	// pure waste — and the global constraint is that nothing changes (not
	// even background requests) until an admin turns the flag on.
	const roleTagSnapshot = useRoleTagSnapshot();
	const { data: myTags } = useQuery({
		...orpc.functionTags.getMyDefault.queryOptions(),
		enabled: roleTagEnforcement,
	});
	const roleTagGateUp = shouldEnforce(
		roleTagEnforcement,
		roleTagSnapshot,
		myTags,
	);

	// The LIVE counterpart to `roleTagEnforcement` (that value rides the frozen
	// RSC payload). One shared definition with the gate and the project prompt,
	// so the three surfaces cannot drift into disagreeing about whether
	// enforcement is on.
	const enforcementLive = isEnforcementLive(roleTagEnforcement, myTags);

	// FR4: show to any eligible (flag + no default tags + not opted out, from the
	// server) user once the welcome drawer is settled — `autoLaunched` once it has
	// fired, or immediately for users not in the auto-launch cohort — and at most
	// once per tab session.
	//
	// Suppressed while role-tag enforcement is LIVE (Fizzy #2264), not merely
	// while the frozen flag is on: the blocking `FunctionTagsRequiredGate`
	// covers the same users, and showing both would stack two modals on one
	// person. This can never actually stack: the gate only renders when
	// `shouldEnforce` is true, which itself requires `enforcementEnabled` —
	// so whenever this prompt is permitted (`enforcementLive` is false), the
	// gate is necessarily hidden already.
	const functionTagsPromptPending =
		!enforcementLive &&
		!!data?.eligibleForFunctionTagsPrompt &&
		(data.state.autoLaunched || !data.autoLaunchCohort) &&
		!tagsPromptShownThisSession;

	const [mode, setMode] = useState<Mode>("idle");
	const [index, setIndex] = useState(0);

	// Freeze the COLLAPSE DECISION for a run — one boolean, not the step list.
	//
	// Freezing the whole list is tempting and wrong. Tab visibility resolves
	// per project (`useProjectTabCustomization` is disabled until
	// `activeProjectId` is set), and a tour launched from the sidebar starts
	// outside any project — so at that moment every tab still looks visible.
	// A frozen list would keep steps for tabs this viewer turns out not to
	// have, and then wait on anchors that never render. Visibility has to stay
	// live; the index clamp below is what makes a shrinking list safe.
	//
	// The decision itself is frozen so a routine refetch can't reshape a run
	// in progress, and it is taken only once the probe has answered — freezing
	// "don't know" would strand a tour that started during a slow request on
	// the uncollapsed nine steps for its whole duration.
	const [frozenHasProject, setFrozenHasProject] = useState<
		boolean | undefined
	>(undefined);
	useEffect(() => {
		if (
			mode === "tour" &&
			frozenHasProject === undefined &&
			hasProject !== undefined
		) {
			setFrozenHasProject(hasProject);
		}
	}, [mode, frozenHasProject, hasProject]);

	const tourSteps = useMemo(
		() =>
			resolveTourSteps({
				hasProject: mode === "tour" ? frozenHasProject : hasProject,
				isTabVisible,
			}),
		[mode, frozenHasProject, hasProject, isTabVisible],
	);
	const [adHocStep, setAdHocStep] = useState<OnboardingStep | null>(null);
	const [pageTourSteps, setPageTourSteps] = useState<OnboardingStep[]>([]);
	// The project tab currently on screen (client state in ProjectDetails, so
	// tracked via its event, not the URL). Null when not inside a project.
	const [activeTab, setActiveTab] = useState<string | null>(null);
	const startedRef = useRef(false);
	// Pages whose first-visit tour we've already launched this session, to guard
	// the window before `markPageSeen` round-trips to the server.
	const seenPagesRef = useRef<Set<string>>(new Set());
	// Pages just made visible to this viewer (card #1837) whose tour should
	// replay once regardless of cohort; consumed by the auto-open effect.
	const revealedRef = useRef<Set<string>>(new Set());
	// Whether the active page tour was auto-launched (first-visit) vs started
	// manually — dismissing an auto one opts the user out of further auto-opens.
	const pageTourAutoRef = useRef(false);
	// Where the active spotlight was launched from. The drawer's "Show me"
	// hands the user back to the drawer they came from; a spotlight raised by
	// another surface (GET_STARTED_SPOTLIGHT_EVENT) must close to nothing —
	// opening a drawer the user never asked for buries the thing the callout
	// just pointed at.
	const spotlightFromDrawerRef = useRef(false);

	// Serialize progress writes so the server read-modify-write can't race.
	const chainRef = useRef<Promise<unknown>>(Promise.resolve());
	const persist = useCallback(
		(action: OnboardingAction) => {
			chainRef.current = chainRef.current
				.then(() => orpcClient.users.onboarding.update({ action }))
				.then((res) => {
					queryClient.setQueryData<StateData>(QUERY_KEY, (prev) =>
						prev
							? {
									...prev,
									state: res.state,
									// Narrow the pointer projection as the tour
									// progresses. The server derives this from
									// `status`, and nothing refetches within a
									// session (staleTime is infinite), so without
									// this the launcher keeps its "you haven't
									// seen this" marker for the whole session —
									// including while the tour is running (R8).
									// Only ever narrows: never re-enables a
									// pointer the server had already ruled out.
									eligibleForPointer:
										prev.eligibleForPointer &&
										res.state.status === "not_started" &&
										!res.state.pointerDismissed,
								}
							: {
									state: res.state,
									eligibleForAutoLaunch: false,
									autoLaunchCohort: false,
									eligibleForFunctionTagsPrompt: false,
									eligibleForPointer: false,
								},
					);
				})
				.catch(() => {});
			return chainRef.current;
		},
		[queryClient],
	);

	// Permanent opt-out ("Don't ask again"), enqueued on the SAME chainRef as
	// `persist` so it can't be reordered behind a concurrent onboarding write
	// (e.g. a `markPageSeen` enqueued first but whose response arrives later)
	// and reverted. Unlike `persist`, it does NOT swallow the error on `run`
	// itself: it REJECTS to the caller (the modal) so a failed opt-out can be
	// retried, while still keeping the shared chain alive via a separate
	// `.catch`.
	const optOutTagsPrompt = useCallback(() => {
		const run = chainRef.current
			.then(() =>
				orpcClient.users.onboarding.update({
					action: { type: "optOutFunctionTagsPrompt" },
				}),
			)
			.then((res) => {
				queryClient.setQueryData<StateData>(QUERY_KEY, (prev) =>
					prev ? { ...prev, state: res.state } : prev,
				);
			});
		chainRef.current = run.catch(() => {});
		return run;
	}, [queryClient]);

	const openDrawer = useCallback(() => setMode("drawer"), []);

	const startTour = useCallback(() => {
		setIndex(0);
		setTourStepId(tourSteps[0]?.id ?? null);
		setFrozenHasProject(hasProject);
		setMode("tour");
		persist({ type: "start" });
	}, [persist, hasProject, tourSteps]);

	const showComponent = useCallback(
		(item: GsItem) => {
			spotlightFromDrawerRef.current = true;
			setAdHocStep(adHocStepFor(item, gsGates));
			setMode("spotlight");
		},
		[gsGates],
	);

	const launchPageTour = useCallback(
		(page: GsPage, auto: boolean) => {
			const steps = buildPageTourSteps(page);
			if (steps.length === 0) {
				return;
			}
			pageTourAutoRef.current = auto;
			seenPagesRef.current.add(page.tab);
			revealedRef.current.delete(page.tab); // bypass consumed
			persist({ type: "markPageSeen", pageId: page.tab });
			setPageTourSteps(steps);
			setIndex(0);
			setMode("pageTour");
		},
		[persist],
	);

	// Open a specific page's tour by id (from a page's "Get started" launcher).
	const startPageTourById = useCallback(
		(pageId: string) => {
			const page = pageForTab(pageId, gsGates);
			if (page) {
				launchPageTour(page, false);
			}
		},
		[launchPageTour, gsGates],
	);

	// "Tour this page" from the drawer — walks the current page's components.
	const startPageTour = useCallback(() => {
		const page = pageForTab(activeTab, gsGates);
		if (page) {
			launchPageTour(page, false);
		}
	}, [activeTab, launchPageTour, gsGates]);

	// First-login auto-launch — opens the welcome dialog once for the eligible
	// (new) cohort, then marks itself so it never auto-opens again. It replaces
	// the drawer at this moment rather than stacking on top of it: with
	// enforcement off, a brand-new account already meets the tags prompt right
	// after, and three surfaces before the user has clicked anything is not an
	// onboarding; with enforcement on, the blocking gate has already met them
	// (see `roleTagGateUp` below) before this dialog would ever get a chance
	// to run. The drawer stays reachable from the sidebar launcher.
	useEffect(() => {
		// `roleTagGateUp`: don't run the welcome tour underneath a modal the
		// user cannot dismiss. Once they set a tag the gate closes and this
		// fires normally.
		if (!data || startedRef.current || mode !== "idle" || roleTagGateUp) {
			return;
		}
		if (data.eligibleForAutoLaunch) {
			startedRef.current = true;
			// Optimistically flip `autoLaunched` in the cache immediately (ahead of
			// the `markAutoLaunched` round-trip) so `functionTagsPromptPending` is
			// already correct the instant the dialog closes — otherwise a fast
			// dismiss could race the network response and briefly under-report
			// eligibility, or a page tour could sneak in first. This same flag is
			// what makes the dialog one-shot; no separate field is needed.
			queryClient.setQueryData<StateData>(QUERY_KEY, (prev) =>
				prev
					? { ...prev, state: { ...prev.state, autoLaunched: true } }
					: prev,
			);
			persist({ type: "markAutoLaunched" });
			setMode("welcome");
		}
	}, [data, mode, persist, queryClient, roleTagGateUp]);

	// Open the function-tags prompt once per tab session, strictly after the
	// welcome drawer (see `functionTagsPromptPending`) and only when nothing else
	// is showing. Mark the session shown AT open so the effect can't re-fire and
	// so a reopen after a plain dismiss ("Not now" / X / Esc) is suppressed
	// without any server write.
	useEffect(() => {
		if (mode !== "idle" || !functionTagsPromptPending) {
			return;
		}
		markTagsPromptShown();
		setMode("tagsPrompt");
	}, [mode, functionTagsPromptPending, markTagsPromptShown]);

	// Track which project page is on screen, from ProjectDetails' tab event.
	useEffect(() => {
		const onTab = (e: Event) => {
			const detail = (e as CustomEvent<ProjectTabEventDetail>).detail;
			if (detail?.tab) {
				setActiveTab(detail.tab);
				setActiveProjectId(detail.projectId);
			}
		};
		window.addEventListener(GET_STARTED_PROJECT_TAB_EVENT, onTab);
		return () =>
			window.removeEventListener(GET_STARTED_PROJECT_TAB_EVENT, onTab);
	}, []);

	// Card #1837: when tabs become visible to this viewer again, clear their
	// per-page seen markers so the next visit replays that page's tour exactly
	// once — regardless of cohort. The reveal set also lets the auto-open
	// effect below bypass its cohort/new-page gate for exactly these pages.
	useEffect(() => {
		const onRevealed = (e: Event) => {
			const detail = (e as CustomEvent<PagesRevealedEventDetail>).detail;
			for (const id of detail?.pageIds ?? []) {
				revealedRef.current.add(id);
				persist({ type: "clearPageSeen", pageId: id });
			}
		};
		window.addEventListener(
			GET_STARTED_PAGES_REVEALED_EVENT,
			onRevealed as EventListener,
		);
		return () =>
			window.removeEventListener(
				GET_STARTED_PAGES_REVEALED_EVENT,
				onRevealed as EventListener,
			);
	}, [persist]);

	// Leaving a project clears the active tab so page tours don't leak across pages.
	useEffect(() => {
		const inProject = /\/projects\/(?!new)[^/?#]+/.test(pathname ?? "");
		if (!inProject) {
			setActiveTab(null);
			setActiveProjectId(null);
		}
	}, [pathname]);

	// Per-page first-visit auto-open. The new-account cohort sees every covered
	// page's detailed tour once as they explore. Existing users aren't replayed
	// the whole app — but a page introduced AFTER the baseline is a new feature,
	// so it auto-opens once for them too (that's how a new page "gets started"
	// for everyone). Opt-out and already-seen pages are always respected.
	useEffect(() => {
		if (
			!data ||
			mode !== "idle" ||
			data.state.pageToursOptedOut ||
			functionTagsPromptPending ||
			// Fizzy #2264: don't spotlight in-page components underneath the
			// blocking function-tags gate. This uses `roleTagGateUp`, not the
			// raw `roleTagEnforcement` used by `functionTagsPromptPending`
			// above — the modal only occupies the screen while the user
			// actually has no tags, so a user who already has tags should
			// still get their page tour normally.
			roleTagGateUp
		) {
			return;
		}
		const page = pageForTab(activeTab, gsGates);
		if (!page) {
			return;
		}
		// Never auto-open a tour for a tab this viewer can't see.
		if (!isTabVisible(page.tab)) {
			return;
		}
		if (
			data.state.seenPages[page.tab] ||
			seenPagesRef.current.has(page.tab)
		) {
			return;
		}
		// A just-revealed page (card #1837) replays its first-visit experience
		// once, regardless of cohort; the reveal handler clears the server
		// seen-marker and this bypass consumes itself on launch.
		const revealed = revealedRef.current.has(page.tab);
		if (
			!revealed &&
			!data.autoLaunchCohort &&
			!isNewlyIntroducedPage(page)
		) {
			return;
		}
		// Give the page a beat to render its anchors (including conditional
		// ones) before building the sequence.
		let cancelled = false;
		const timer = setTimeout(() => {
			if (!cancelled) {
				launchPageTour(page, true);
			}
		}, 900);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [
		data,
		mode,
		activeTab,
		launchPageTour,
		functionTagsPromptPending,
		roleTagGateUp,
		isTabVisible,
		gsGates,
	]);

	// Launchers: the sidebar item opens the drawer; the per-page "?" button on a
	// covered project page opens that page's detailed tour directly.
	useEffect(() => {
		const onOpen = () => openDrawer();
		const onTourPage = (e: Event) => {
			const pageId = (e as CustomEvent<TourPageEventDetail>).detail
				?.pageId;
			if (pageId) {
				startPageTourById(pageId);
			}
		};
		/**
		 * Spotlight one component on request. Same machine as the drawer's
		 * "Show me" — navigate if needed, wait for the anchor to mount, scroll,
		 * highlight — but driven by an anchor and copy the caller supplies, so a
		 * surface outside the drawer can point at the thing it just sent someone
		 * to. The readiness checklist is the first caller.
		 */
		const onSpotlight = (e: Event) => {
			const d = (e as CustomEvent<SpotlightEventDetail>).detail;
			if (!d?.anchorId) {
				return;
			}
			setAdHocStep({
				id: `spotlight-${d.anchorId}`,
				area: "welcome",
				icon: SparklesIcon,
				title: d.title,
				body: d.body,
				target: d.projectTab
					? {
							kind: "projectComponent",
							tab: d.projectTab,
							anchorId: d.anchorId,
							side: "bottom",
						}
					: { kind: "anchor", anchorId: d.anchorId, side: "bottom" },
			});
			spotlightFromDrawerRef.current = false;
			setMode("spotlight");
		};
		window.addEventListener(GET_STARTED_OPEN_EVENT, onOpen);
		window.addEventListener(GET_STARTED_TOUR_PAGE_EVENT, onTourPage);
		window.addEventListener(GET_STARTED_SPOTLIGHT_EVENT, onSpotlight);
		return () => {
			window.removeEventListener(GET_STARTED_OPEN_EVENT, onOpen);
			window.removeEventListener(GET_STARTED_TOUR_PAGE_EVENT, onTourPage);
			window.removeEventListener(
				GET_STARTED_SPOTLIGHT_EVENT,
				onSpotlight,
			);
		};
	}, [openDrawer, startPageTourById]);

	// Broadcast whether any onboarding surface is on screen. Keyed on `mode` so
	// every path that opens or closes one is covered without touching each
	// handler; drawer -> tour and similar surface-to-surface moves stay "open"
	// throughout, so listeners never see a spurious close between them.
	useEffect(() => {
		window.dispatchEvent(
			new CustomEvent<SurfaceEventDetail>(GET_STARTED_SURFACE_EVENT, {
				detail: { open: mode !== "idle" },
			}),
		);
	}, [mode]);

	// Where the viewer is, resolved by STEP rather than by slot — the list is
	// live and steps can vanish mid-run. See `resolveTourPosition`.
	const [tourStepId, setTourStepId] = useState<string | null>(null);
	const tourIndex = resolveTourPosition(tourSteps, tourStepId);
	const shownStepId = tourSteps[tourIndex]?.id;
	// Adopt whatever is actually on screen as the new anchor. When the
	// remembered step was removed, the resolver moves the viewer to its
	// successor — and the id has to follow, or a later visibility result that
	// RESTORES the removed step (a refetch, or a different project's config)
	// would find it again and jump the viewer backwards to a step they have
	// already been walked past. Converges in one render: once the id matches
	// what is shown, the resolver returns that same index and this no-ops.
	useEffect(() => {
		if (mode === "tour" && shownStepId && shownStepId !== tourStepId) {
			setTourStepId(shownStepId);
		}
	}, [mode, shownStepId, tourStepId]);

	/** Move to `target`, remembering the step there rather than the number. */
	const goToIndex = useCallback(
		(target: number, steps: readonly OnboardingStep[]) => {
			const clamped = Math.min(
				Math.max(0, target),
				Math.max(0, steps.length - 1),
			);
			setIndex(clamped);
			setTourStepId(steps[clamped]?.id ?? null);
		},
		[],
	);

	const advance = useCallback(
		(outcome: "completed" | "skipped") => {
			const current = tourSteps[tourIndex];
			const next = tourSteps[tourIndex + 1];
			if (current) {
				persist({
					type: "step",
					stepId: current.id,
					outcome,
					currentStepId: next?.id ?? current.id,
				});
			}
			goToIndex(tourIndex + 1, tourSteps);
		},
		[tourSteps, tourIndex, persist, goToIndex],
	);

	const goBack = useCallback(() => {
		const prev = tourSteps[tourIndex - 1];
		if (prev) {
			persist({ type: "setCurrent", stepId: prev.id });
		}
		goToIndex(tourIndex - 1, tourSteps);
	}, [tourSteps, tourIndex, persist, goToIndex]);

	const goTo = useCallback(
		(target: number) => {
			const s = tourSteps[target];
			if (s) {
				persist({ type: "setCurrent", stepId: s.id });
				goToIndex(target, tourSteps);
			}
		},
		[tourSteps, persist, goToIndex],
	);

	// Thaw on exit so the next run decides fresh.
	const endTour = useCallback(() => {
		setFrozenHasProject(undefined);
		setTourStepId(null);
		setMode("idle");
	}, []);

	const dismissTour = useCallback(() => {
		persist({ type: "dismiss" });
		endTour();
	}, [persist, endTour]);

	const finishTour = useCallback(() => {
		const current = tourSteps[tourIndex];
		if (current) {
			persist({ type: "step", stepId: current.id, outcome: "completed" });
		}
		persist({ type: "complete" });
		endTour();
	}, [tourSteps, tourIndex, persist, endTour]);

	// A one-off "Show me" ends by returning to the drawer so users keep exploring.
	const endSpotlight = useCallback(
		() => setMode(spotlightFromDrawerRef.current ? "drawer" : "idle"),
		[],
	);
	const noop = useCallback(() => {}, []);

	// Page-tour navigation is transient (no per-step persistence — the visit is
	// already recorded via markPageSeen when it launches).
	const advancePageTour = useCallback(
		() => setIndex((i) => Math.min(pageTourSteps.length - 1, i + 1)),
		[pageTourSteps.length],
	);
	const backPageTour = useCallback(
		() => setIndex((i) => Math.max(0, i - 1)),
		[],
	);
	const endPageTour = useCallback(() => {
		setPageTourSteps([]);
		setIndex(0);
		setMode("idle");
	}, []);

	// Dismissing an AUTO-launched page tour (X / Esc / "Skip tour") is a clear
	// "not now" — stop auto-opening the rest. A manually-started one, or one run
	// to completion, leaves auto-opens on.
	const dismissPageTour = useCallback(() => {
		if (pageTourAutoRef.current) {
			persist({ type: "markPageToursOptedOut" });
		}
		endPageTour();
	}, [persist, endPageTour]);

	const pageTourAvailable = pageForTab(activeTab, gsGates) !== null;

	if (!GET_STARTED_ENABLED || !user) {
		return null;
	}

	return (
		<>
			{mode === "welcome" && (
				<GetStartedWelcomeDialog
					onStartTour={startTour}
					onDismiss={() => setMode("idle")}
				/>
			)}
			{mode === "drawer" && (
				<GetStartedDrawer
					onClose={() => setMode("idle")}
					onStartTour={startTour}
					onShowComponent={showComponent}
					onTourPage={pageTourAvailable ? startPageTour : undefined}
					isTabVisible={isTabVisible}
					gates={gsGates}
				/>
			)}
			{mode === "tour" && tourSteps[tourIndex] && (
				<GetStartedSpotlight
					steps={tourSteps}
					index={tourIndex}
					onNext={() => advance("completed")}
					onSkipStep={() => advance("skipped")}
					onBack={goBack}
					onGoTo={goTo}
					onDismiss={dismissTour}
					onFinish={finishTour}
					activeProjectTab={activeTab}
				/>
			)}
			{mode === "spotlight" && adHocStep && (
				<GetStartedSpotlight
					single
					steps={[adHocStep]}
					index={0}
					onNext={noop}
					onSkipStep={noop}
					onBack={noop}
					onGoTo={noop}
					onDismiss={endSpotlight}
					onFinish={endSpotlight}
					activeProjectTab={activeTab}
				/>
			)}
			{mode === "pageTour" && pageTourSteps[index] && (
				<GetStartedSpotlight
					steps={pageTourSteps}
					index={index}
					onNext={advancePageTour}
					onSkipStep={advancePageTour}
					onBack={backPageTour}
					onGoTo={setIndex}
					onDismiss={dismissPageTour}
					onFinish={endPageTour}
					activeProjectTab={activeTab}
				/>
			)}
			{mode === "tagsPrompt" && (
				<FunctionTagsOnboardingPrompt
					onOptOut={optOutTagsPrompt}
					onClose={() => setMode("idle")}
				/>
			)}
		</>
	);
}
