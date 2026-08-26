"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Popover, PopoverAnchor, PopoverContent } from "@ui/components/popover";
import { XIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { createSessionFlag } from "../lib/session-flag";
import {
	GET_STARTED_OPEN_EVENT,
	GET_STARTED_SURFACE_EVENT,
	type SurfaceEventDetail,
} from "../lib/tour-steps";
import {
	GET_STARTED_ENABLED,
	ONBOARDING_STATE_QUERY_KEY,
	type OnboardingStateData,
	useOnboardingState,
} from "../lib/use-onboarding-state";

/** Per-tab-session suppression for the callout (R4). */
const calloutShown = createSessionFlag("fabric:get-started-pointer-shown");

/**
 * Whether the launcher this callout would anchor to is actually on screen.
 *
 * The navigation mounts the launcher twice — the desktop rail keeps its copy in
 * the tree at every width and hides it with `display:none` below `md`, while the
 * mobile sheet renders its own. Popover content is portalled to `document.body`,
 * so an ancestor's `display:none` does NOT hide it: without this check the
 * hidden copy would open a callout floating at the origin, detached from any
 * launcher (R7).
 *
 * Two questions, both required. `checkVisibility` is the only DOM API that
 * accounts for `display:none` on any ancestor — but it answers "is this
 * rendered", not "can it be seen", so a geometry pass follows it for the
 * clipped-by-scrolling case. Nothing defaults to "visible": jsdom implements
 * neither layout nor `checkVisibility`, so tests must model visibility
 * explicitly rather than inherit a permissive default that would make them
 * vacuous.
 */
function isAnchorOnScreen(el: HTMLElement | null): boolean {
	if (!el) {
		return false;
	}

	if (typeof el.checkVisibility === "function") {
		if (!el.checkVisibility()) {
			return false;
		}
	} else if (el.getClientRects().length === 0) {
		// Pre-Chrome-105 / pre-Safari-17.4 fallback. NOT `true`: defaulting to
		// visible would let the hidden copy open a detached callout AND claim
		// the once-per-session flag, losing the nudge on exactly the engines
		// the guard exists for.
		return false;
	}

	// `checkVisibility` answers "is this rendered", not "can it be seen". The
	// launcher sits in a scrolling sidebar, so on a short viewport it is fully
	// rendered yet clipped below its own scroll container's fold — measured on
	// a 698px-tall window, the anchor sat 165px past the fold while the callout
	// drew beside the content area, pointing at nothing. Same R7 failure as the
	// hidden copy, reached through scrolling instead of `display:none`.
	const rect = el.getBoundingClientRect();
	if (rect.width === 0 || rect.height === 0) {
		return false;
	}
	if (isFullyOutside(rect, 0, 0, window.innerWidth, window.innerHeight)) {
		return false;
	}
	for (let parent = el.parentElement; parent; parent = parent.parentElement) {
		const style = getComputedStyle(parent);
		if (!CLIPS.test(style.overflowY) && !CLIPS.test(style.overflowX)) {
			continue;
		}
		const box = parent.getBoundingClientRect();
		if (isFullyOutside(rect, box.left, box.top, box.right, box.bottom)) {
			return false;
		}
	}
	return true;
}

const CLIPS = /^(auto|scroll|hidden|clip)$/;

/** Partly visible still counts — only a rect entirely past an edge is out. */
function isFullyOutside(
	rect: DOMRect,
	left: number,
	top: number,
	right: number,
	bottom: number,
): boolean {
	return (
		rect.bottom <= top ||
		rect.top >= bottom ||
		rect.right <= left ||
		rect.left >= right
	);
}

type Props = {
	/**
	 * Whether this copy of the launcher may open the callout. The marker always
	 * renders; only the persistent chrome earns the interruption.
	 *
	 * False for the mobile navigation sheet: its copy mounts only while the
	 * sheet is open, so a callout there would be anchored inside a 280px drawer
	 * (too narrow for the 288px callout), would cover the nav the user just
	 * opened, and would burn the once-per-session flag the moment they tap a
	 * destination and the sheet unmounts.
	 */
	calloutEnabled?: boolean;
	/**
	 * Renders the launcher. Receives the marker to place over the launcher's
	 * icon and the screen-reader text describing it, or nulls when the user is
	 * not eligible. A render prop keeps the marker and the callout on one piece
	 * of state while letting the navigation own how the launcher is composed.
	 */
	children: (marker: ReactNode | null, markerLabel?: string) => ReactNode;
};

/**
 * Points users who have never engaged with the "Get started" tour at its
 * sidebar launcher.
 *
 * Two layers: a callout that fires at most once per tab session, and a static
 * marker on the launcher icon that persists while the user stays eligible.
 * Eligibility is decided server-side (`eligibleForPointer`) — status is
 * `not_started` and the pointer was never dismissed — with no account-age
 * cohort, because accounts predating the first-login drawer are exactly the
 * population with no other signal.
 *
 * The callout yields to every other onboarding surface, so a brand-new account
 * sees the drawer on day one and this on a later session, never both at once.
 */
export function GetStartedPointer({ calloutEnabled = true, children }: Props) {
	const t = useTranslations();
	const { data, user } = useOnboardingState();
	const queryClient = useQueryClient();

	const userId = user?.id ?? "";

	// Local suppression, held so the UI stays correct even if a concurrent
	// onboarding write overwrites the cached state with a pre-dismissal copy.
	// The server is authoritative and already correct either way.
	const [dismissed, setDismissed] = useState(false);
	const [calloutOpen, setCalloutOpen] = useState(false);
	const [surfaceOpen, setSurfaceOpen] = useState(false);
	const dismissSentRef = useRef(false);
	const anchorRef = useRef<HTMLSpanElement>(null);
	/** Whether focus ever entered the callout — gates the restore on close. */
	const focusEnteredRef = useRef(false);

	// The controller flips `autoLaunched` optimistically the instant the
	// first-login drawer opens, which would make `eligibleForAutoLaunch` look
	// false a moment later. Latch the first answer so "was a drawer expected
	// this session?" stays truthful for the whole session (R6).
	const autoLaunchExpectedRef = useRef<boolean | null>(null);
	if (data && autoLaunchExpectedRef.current === null) {
		autoLaunchExpectedRef.current = data.eligibleForAutoLaunch;
	}

	const active =
		GET_STARTED_ENABLED &&
		!!user &&
		!!data?.eligibleForPointer &&
		!dismissed;

	/** Permanent, cross-device suppression (R10, R11). */
	const dismissPermanently = useCallback(() => {
		setDismissed(true);
		setCalloutOpen(false);
		if (dismissSentRef.current) {
			return;
		}
		dismissSentRef.current = true;
		queryClient.setQueryData<OnboardingStateData>(
			ONBOARDING_STATE_QUERY_KEY,
			(prev) =>
				prev
					? {
							...prev,
							eligibleForPointer: false,
							state: { ...prev.state, pointerDismissed: true },
						}
					: prev,
		);
		orpcClient.users.onboarding
			.update({ action: { type: "dismissPointer" } })
			.catch(() => {
				// The local flag already hides the pointer for this session; the
				// next load re-reads the server and can retry the nudge.
			});
	}, [queryClient]);

	// Track whether any onboarding surface is on screen (R6). A surface opening
	// on top of the callout also closes it — done here rather than in a second
	// effect chained off `surfaceOpen`, which would cost an extra render pass.
	// `surfaceOpen` still has to be state, not a ref: the open effect below has
	// to re-evaluate when a surface CLOSES.
	useEffect(() => {
		const onSurface = (e: Event) => {
			const open =
				(e as CustomEvent<SurfaceEventDetail>).detail?.open === true;
			setSurfaceOpen(open);
			if (open) {
				setCalloutOpen(false);
			}
		};
		window.addEventListener(GET_STARTED_SURFACE_EVENT, onSurface);
		return () =>
			window.removeEventListener(GET_STARTED_SURFACE_EVENT, onSurface);
	}, []);

	// Opening the drawer FROM the launcher ends eligibility (R9). The event is
	// only dispatched by a deliberate launcher click — the controller's
	// first-login auto-launch opens the drawer directly without it, so a
	// brand-new account keeps the pointer for a later session.
	//
	// The on-screen guard matters here as much as it does for the callout: the
	// navigation mounts this component twice, and without it BOTH copies would
	// answer one click with their own suppression write.
	useEffect(() => {
		const onOpen = () => {
			if (active && isAnchorOnScreen(anchorRef.current)) {
				dismissPermanently();
			}
		};
		window.addEventListener(GET_STARTED_OPEN_EVENT, onOpen);
		return () => window.removeEventListener(GET_STARTED_OPEN_EVENT, onOpen);
	}, [active, dismissPermanently]);

	// Open the callout once per tab session, and only with the coast clear.
	// Marked shown AT open so the effect can't re-fire and so an incidental
	// close ("Not now" / Esc / outside click) doesn't reopen it.
	useEffect(() => {
		if (!active || calloutOpen || !calloutEnabled) {
			return;
		}
		// Read the session flag HERE rather than from state: the navigation
		// mounts this component twice, and React state cannot see a sibling
		// instance's write. Storage is the only thing both copies share, so
		// only a read at decision time is authoritative.
		if (calloutShown.read(userId)) {
			return;
		}
		// null = state not loaded yet; true = the first-login drawer owns this
		// session. Only a settled false lets the callout through.
		if (autoLaunchExpectedRef.current !== false) {
			return;
		}
		// Yield to any surface that is actually on screen. Deliberately NOT
		// gated on `eligibleForFunctionTagsPrompt`: that flag is server-computed
		// and stays true for as long as the user has no function tags, so
		// treating it as "a prompt is coming" would suppress this callout
		// permanently for exactly the users it targets. The controller
		// broadcasts a surface event while the prompt is open, which is the
		// signal that actually clears.
		if (surfaceOpen) {
			return;
		}
		// Only the copy of the launcher that is actually on screen may open a
		// callout — and claiming the session flag below stops the other copy.
		if (!isAnchorOnScreen(anchorRef.current)) {
			return;
		}
		calloutShown.write(userId);
		setCalloutOpen(true);
	}, [active, calloutOpen, calloutEnabled, surfaceOpen, userId]);

	// The on-screen check runs once, at open. A viewport that narrows past the
	// sidebar breakpoint hides the rail via CSS — but the callout is portalled
	// to body, so it would survive as an orphan pinned to the origin. Watch for
	// the anchor going away and close it (R7).
	useEffect(() => {
		if (!calloutOpen || typeof ResizeObserver === "undefined") {
			return;
		}
		const check = () => {
			if (!isAnchorOnScreen(anchorRef.current)) {
				setCalloutOpen(false);
			}
		};
		const observer = new ResizeObserver(check);
		observer.observe(document.documentElement);
		window.addEventListener("resize", check);
		// Capture phase: scroll does not bubble, and the anchor's clipping
		// ancestor is the sidebar's own scroller, not the window.
		document.addEventListener("scroll", check, true);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", check);
			document.removeEventListener("scroll", check, true);
		};
	}, [calloutOpen]);

	if (!active) {
		return <>{children(null)}</>;
	}

	// Static, per R12 — the design system treats indefinitely-looping motion as
	// an anti-pattern.
	//
	// The screen-reader text is handed to the launcher separately rather than
	// nested inside it: in the collapsed rail the launcher carries an
	// `aria-label`, which REPLACES the name computed from its contents, so an
	// sr-only child would be silently dropped in exactly the chrome state where
	// the visible label is gone too (R13).
	const markerLabel = t("onboarding.tour.pointer.badge");
	// Position-agnostic on purpose: the navigation places this over the icon in
	// the collapsed rail and as a trailing chip when the label is visible, the
	// same split it already applies to the label itself. `aria-hidden` because
	// the fuller `markerLabel` carries the meaning to assistive tech.
	const marker = (
		<Badge
			variant="default"
			aria-hidden="true"
			className="pointer-events-none h-4 rounded-full px-1.5 font-semibold text-[10px] leading-none"
		>
			{t("onboarding.tour.pointer.newLabel")}
		</Badge>
	);

	return (
		<Popover
			open={calloutOpen}
			onOpenChange={(next) => {
				// Esc / outside click is an incidental close, not a decision —
				// the marker stays and the callout returns next session.
				if (!next) {
					setCalloutOpen(false);
				}
			}}
		>
			<PopoverAnchor asChild>
				<span ref={anchorRef} className="block">
					{children(marker, markerLabel)}
				</span>
			</PopoverAnchor>
			<PopoverContent
				side="right"
				align="start"
				className="w-72"
				aria-labelledby="get-started-pointer-title"
				onFocusCapture={() => {
					focusEnteredRef.current = true;
				}}
				onOpenAutoFocus={(e) => {
					// This callout opens on its OWN, from an effect — not from a
					// click. Radix focuses the first tabbable child on open, which
					// would yank a keyboard user out of whatever they were doing
					// and drop them on the close button. A nudge must not steal
					// focus; keyboard users reach it by tabbing (R13).
					e.preventDefault();
				}}
				onCloseAutoFocus={(e) => {
					e.preventDefault();
					// Radix's own restore is a no-op here: it returns focus to the
					// PopoverTrigger, and this callout is anchored, not triggered,
					// so there is no trigger to return to. Restore by hand — but
					// only when focus was actually inside, or closing would steal
					// focus just as opening would.
					if (!focusEnteredRef.current) {
						return;
					}
					focusEnteredRef.current = false;
					anchorRef.current
						?.querySelector<HTMLElement>("button, a")
						?.focus();
				}}
			>
				<div className="mb-1.5 flex items-start gap-2">
					<h3
						id="get-started-pointer-title"
						className="flex-1 font-semibold text-[15px] leading-snug text-foreground"
					>
						{t("onboarding.tour.pointer.title")}
					</h3>
					<button
						type="button"
						onClick={() => setCalloutOpen(false)}
						aria-label={t("onboarding.tour.pointer.notNow")}
						className="-mr-1 -mt-1 flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
					>
						<XIcon className="size-4" />
					</button>
				</div>
				<p className="mb-3.5 text-[13px] leading-relaxed text-muted-foreground">
					{t("onboarding.tour.pointer.body")}
				</p>
				<div className="flex items-center justify-between gap-2">
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={dismissPermanently}
					>
						{t("onboarding.tour.pointer.dontShowAgain")}
					</Button>
					<Button
						type="button"
						size="sm"
						onClick={() =>
							window.dispatchEvent(
								new CustomEvent(GET_STARTED_OPEN_EVENT),
							)
						}
					>
						{t("onboarding.tour.pointer.cta")}
					</Button>
				</div>
			</PopoverContent>
		</Popover>
	);
}
