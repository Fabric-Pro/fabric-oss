"use client";

import {
	useOrganizationContext,
	useOrganizationId,
} from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { cn } from "@ui/lib";
import {
	CheckIcon,
	ChevronLeftIcon,
	ChevronRightIcon,
	XIcon,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import {
	anchorForProjectTab,
	ONBOARDING_ANCHORS,
	type OnboardingStep,
} from "../lib/tour-steps";

type Props = {
	/** When true, renders a single-component "Show me" highlight (Got it), not a tour. */
	single?: boolean;
	steps: readonly OnboardingStep[];
	index: number;
	onNext: () => void;
	onBack: () => void;
	onSkipStep: () => void;
	onGoTo: (index: number) => void;
	onDismiss: () => void;
	onFinish: () => void;
	/**
	 * Project tab currently on screen, tracked by the controller from
	 * `ProjectDetails`' tab event. The URL cannot answer this: `?tab=` is a
	 * one-shot deep link that is stripped as soon as it is consumed (see
	 * `projects/components/use-project-tab-deep-link.ts`), and a manual tab
	 * switch never writes it. Without this the "already there" check below
	 * always misses and every tab step re-navigates.
	 */
	activeProjectTab?: string | null;
};

/** Rect of the spotlight hole, in viewport coordinates. */
type Rect = { x: number; y: number; w: number; h: number };
type Phase = "resolving" | "spotlight" | "center";

// Wide enough to keep the progress dots and Back/Skip/Next on one line at the
// longest step (9 dots + all three buttons needs ~337px inside the p-4 padding).
const CARD_MAX_W = 380;
const GAP = 14;
const MARGIN = 14;
const PAD = 8;
// Show the centered fallback if the anchor hasn't appeared within this window
// (e.g. a slow navigation still loading); we keep observing and upgrade to a
// spotlight the moment it mounts.
const ANCHOR_GRACE_MS = 1500;
const MOBILE_QUERY = "(max-width: 767px)";

const clamp = (v: number, min: number, max: number) =>
	Math.max(min, Math.min(max, v));

const isSmallScreen = () =>
	typeof window !== "undefined" && window.matchMedia(MOBILE_QUERY).matches;

const prefersReducedMotion = () =>
	typeof window !== "undefined" &&
	window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function projectIdFromPath(pathname: string | null): string | null {
	const match = pathname?.match(/\/projects\/([^/?#]+)/);
	const id = match?.[1];
	return id && id !== "new" ? id : null;
}

/** Resolve the anchor id for a step, adjusting for small screens. */
function anchorIdForStep(step: OnboardingStep): string | null {
	const { target } = step;
	if (target.kind === "center") {
		return null;
	}
	if (target.kind === "projectTab") {
		return anchorForProjectTab(target.tab);
	}
	if (target.kind === "projectComponent") {
		return target.anchorId;
	}
	// Sidebar-anchored step: on small screens the sidebar is hidden, so fall
	// back to spotlighting the always-visible hamburger menu button.
	if (target.inMobileNav && isSmallScreen()) {
		return ONBOARDING_ANCHORS.mobileNavTrigger;
	}
	return target.anchorId;
}

/**
 * Call `onFound` as soon as the anchor is (or becomes) present, and keep
 * observing until disconnected. Unlike a one-shot timeout, this upgrades a
 * slow target too: if a navigation is still compiling/loading when the step
 * starts, the anchor can appear seconds later and still get spotlighted.
 * Returns a disconnect function.
 */
function observeForAnchor(
	anchorId: string,
	onFound: (el: HTMLElement) => void,
): () => void {
	const selector = `[data-onboarding-target="${anchorId}"]`;
	const existing = document.querySelector<HTMLElement>(selector);
	if (existing) {
		onFound(existing);
		return () => {};
	}
	const observer = new MutationObserver(() => {
		const el = document.querySelector<HTMLElement>(selector);
		if (el) {
			observer.disconnect();
			onFound(el);
		}
	});
	observer.observe(document.body, { childList: true, subtree: true });
	return () => observer.disconnect();
}

export function GetStartedSpotlight({
	single = false,
	steps,
	index,
	onNext,
	onBack,
	onSkipStep,
	onGoTo,
	onDismiss,
	onFinish,
	activeProjectTab = null,
}: Props) {
	const t = useTranslations();
	const router = useRouter();
	const pathname = usePathname();
	const { basePath } = useOrganizationContext();
	const organizationId = useOrganizationId();

	const step = steps[index];
	const total = steps.length;
	const isFirst = index === 0;
	const isLast = index === total - 1;

	const [phase, setPhase] = useState<Phase>("resolving");
	const [rect, setRect] = useState<Rect | null>(null);
	const [noProject, setNoProject] = useState(false);
	const [ctaHref, setCtaHref] = useState<string | null>(null);
	const [cardH, setCardH] = useState(220);
	const [mounted, setMounted] = useState(false);
	// Bumped when the viewport crosses the mobile breakpoint, to re-resolve the
	// anchor (sidebar item <-> hamburger) for the current step.
	const [resolveNonce, setResolveNonce] = useState(0);

	const targetElRef = useRef<HTMLElement | null>(null);
	const rafRef = useRef<number | null>(null);
	const rectRef = useRef<Rect | null>(null);
	const cardRef = useRef<HTMLDivElement | null>(null);
	const overlayRef = useRef<HTMLDivElement | null>(null);
	const restoreFocusRef = useRef<HTMLElement | null>(null);
	const projectIdRef = useRef<string | null>(null);
	// Read inside the resolve effect WITHOUT joining its dependencies: the
	// "already on this tab" check is a point-in-time question asked once per
	// step. As a dependency it would re-resolve — and re-navigate — every time
	// the user changed tab mid-tour, which the URL read it replaced never did.
	const activeProjectTabRef = useRef(activeProjectTab);
	activeProjectTabRef.current = activeProjectTab;

	useEffect(() => {
		setMounted(true);
		restoreFocusRef.current = document.activeElement as HTMLElement | null;
		return () => {
			restoreFocusRef.current?.focus?.();
		};
	}, []);

	// The coach-mark asserts `aria-modal` but isn't a native <dialog>. Mark the
	// sibling app content `inert` while it's open: a single primitive that hides
	// it from assistive tech, drops it from the tab order, AND blocks pointer
	// events — so the dimmed backdrop can't leak clicks to the live app and a
	// keyboard user can't Tab out into it (Radix gives the drawer this for free).
	useEffect(() => {
		if (!mounted) {
			return;
		}
		const root = overlayRef.current;
		if (!root) {
			return;
		}
		const inerted: HTMLElement[] = [];
		for (const child of Array.from(document.body.children)) {
			if (
				child === root ||
				!(child instanceof HTMLElement) ||
				child.inert
			) {
				continue;
			}
			child.inert = true;
			inerted.push(child);
		}
		return () => {
			for (const el of inerted) {
				el.inert = false;
			}
		};
	}, [mounted]);

	const stopTracking = useCallback(() => {
		if (rafRef.current !== null) {
			cancelAnimationFrame(rafRef.current);
			rafRef.current = null;
		}
	}, []);

	const startTracking = useCallback((el: HTMLElement) => {
		const tick = () => {
			const node = targetElRef.current ?? el;
			if (node?.isConnected) {
				const r = node.getBoundingClientRect();
				if (r.width > 0 || r.height > 0) {
					const next: Rect = {
						x: r.left - PAD,
						y: r.top - PAD,
						w: r.width + PAD * 2,
						h: r.height + PAD * 2,
					};
					const prev = rectRef.current;
					if (
						!prev ||
						Math.abs(prev.x - next.x) > 0.5 ||
						Math.abs(prev.y - next.y) > 0.5 ||
						Math.abs(prev.w - next.w) > 0.5 ||
						Math.abs(prev.h - next.h) > 0.5
					) {
						rectRef.current = next;
						setRect(next);
					}
				}
			}
			rafRef.current = requestAnimationFrame(tick);
		};
		tick();
	}, []);

	const resolveProjectId = useCallback(async (): Promise<string | null> => {
		const fromPath = projectIdFromPath(pathname);
		if (fromPath) {
			projectIdRef.current = fromPath;
			return fromPath;
		}
		if (projectIdRef.current) {
			return projectIdRef.current;
		}
		try {
			const res = await orpcClient.projects.list({
				organizationId,
				limit: 1,
				// Explicit, and must match the controller's existence probe:
				// the two have to answer the same question or the repeated
				// create-a-project card comes back (Fizzy #2360). Drafts stay
				// out — `list` orders by `updatedAt DESC` and takes one, so
				// counting them would let a half-finished draft outrank a
				// real project and send the tour to components it has not
				// reached yet.
				includeDraft: false,
			});
			const id = res.projects?.[0]?.id ?? null;
			projectIdRef.current = id;
			return id;
		} catch {
			return null;
		}
	}, [pathname, organizationId]);

	// Resolve the current step's target: navigate if needed, wait for the
	// anchor, then start tracking it. Falls back to a centered card whenever a
	// real target can't be shown — the tour never renders a broken highlight.
	useEffect(() => {
		let cancelled = false;
		let disconnect: (() => void) | undefined;
		let graceTimer: ReturnType<typeof setTimeout> | undefined;
		stopTracking();
		targetElRef.current = null;
		rectRef.current = null;
		setRect(null);
		setNoProject(false);
		setCtaHref(null);
		setPhase("resolving");

		const run = async () => {
			const { target } = step;

			if (target.kind === "center") {
				if (!cancelled) {
					setPhase("center");
				}
				return;
			}

			if (
				target.kind === "projectTab" ||
				target.kind === "projectComponent"
			) {
				const projectId = await resolveProjectId();
				if (cancelled) {
					return;
				}
				if (!projectId) {
					setNoProject(true);
					setCtaHref(`${basePath}/projects`);
					setPhase("center");
					return;
				}
				// No "Take me there" link here: this step auto-navigates to the
				// tab and spotlights the component, so a CTA pointing at the same
				// page is redundant and reads as a confusing second action next
				// to Next. (The link is kept only for the no-project fallback and
				// for sidebar steps that don't auto-navigate.)
				const onProject = pathname?.includes(`/projects/${projectId}`);
				if (!onProject || activeProjectTabRef.current !== target.tab) {
					// `scroll: false` because the spotlight scrolls the anchor
					// into view itself a few lines down; letting the router
					// jump to top first fights that.
					router.push(
						`${basePath}/projects/${projectId}?tab=${target.tab}`,
						{ scroll: false },
					);
				}
			} else if (target.navigate) {
				setCtaHref(target.navigate(basePath));
			}

			const anchorId = anchorIdForStep(step);
			if (!anchorId) {
				if (!cancelled) {
					setPhase("center");
				}
				return;
			}

			const showSpotlight = (el: HTMLElement) => {
				if (cancelled) {
					return;
				}
				if (graceTimer) {
					clearTimeout(graceTimer);
					graceTimer = undefined;
				}
				targetElRef.current = el;
				el.scrollIntoView({
					block: "center",
					inline: "center",
					behavior: prefersReducedMotion() ? "auto" : "smooth",
				});
				setPhase("spotlight");
				startTracking(el);
			};

			// Fall back to a centered card if the anchor is slow to appear, but
			// keep observing so a still-loading target upgrades to a spotlight
			// the moment it mounts (see observeForAnchor).
			graceTimer = setTimeout(() => {
				if (!cancelled) {
					setPhase("center");
				}
			}, ANCHOR_GRACE_MS);
			disconnect = observeForAnchor(anchorId, showSpotlight);
		};

		void run();

		return () => {
			cancelled = true;
			if (graceTimer) {
				clearTimeout(graceTimer);
			}
			disconnect?.();
			stopTracking();
		};
	}, [
		step,
		basePath,
		pathname,
		router,
		resolveProjectId,
		startTracking,
		stopTracking,
		resolveNonce,
	]);

	// Re-resolve when the viewport crosses the mobile breakpoint so a sidebar
	// step re-targets the hamburger (and vice versa). rAF tracking already keeps
	// placement correct for ordinary resizes.
	useEffect(() => {
		let wasSmall = isSmallScreen();
		const onResize = () => {
			const small = isSmallScreen();
			if (small !== wasSmall) {
				wasSmall = small;
				setResolveNonce((n) => n + 1);
			}
		};
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, []);

	useLayoutEffect(() => {
		if (cardRef.current) {
			setCardH(cardRef.current.offsetHeight);
		}
	}, [phase, rect, index]);

	// Move focus into the dialog on each step so keyboard users follow along.
	useEffect(() => {
		if (phase === "resolving") {
			return;
		}
		cardRef.current?.focus();
	}, [phase, index]);

	// Keyboard: Esc dismiss, arrows navigate, Tab trapped within the card.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				onDismiss();
			} else if (e.key === "ArrowRight") {
				if (isLast) {
					onFinish();
				} else {
					onNext();
				}
			} else if (e.key === "ArrowLeft") {
				if (!isFirst) {
					onBack();
				}
			} else if (e.key === "Tab") {
				// Trap within the whole overlay (not just the card) so the
				// persistent "Skip tour" button, rendered as a sibling, stays
				// keyboard-reachable.
				const focusables =
					overlayRef.current?.querySelectorAll<HTMLElement>(
						'button, [href], [tabindex]:not([tabindex="-1"])',
					);
				if (!focusables || focusables.length === 0) {
					return;
				}
				const first = focusables[0];
				const last = focusables[focusables.length - 1];
				if (e.shiftKey && document.activeElement === first) {
					e.preventDefault();
					last.focus();
				} else if (!e.shiftKey && document.activeElement === last) {
					e.preventDefault();
					first.focus();
				}
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [isFirst, isLast, onBack, onNext, onDismiss, onFinish]);

	if (!mounted || !step) {
		return null;
	}

	const vw = window.innerWidth;
	const vh = window.innerHeight;
	const cardW = Math.min(CARD_MAX_W, vw - MARGIN * 2);
	// The viewport squeezed the card below the width the footer is sized for,
	// so the nav can't sit beside the dots — see the footer's stacked layout.
	const cardClamped = cardW < CARD_MAX_W;

	// Placement.
	let cardTop: number;
	let cardLeft: number;
	let side: "top" | "bottom" | "center" = "center";
	let arrowX = cardW / 2;

	const spotlight = phase === "spotlight" && rect !== null;

	if (spotlight && rect) {
		const preferred =
			step.target.kind !== "center" ? step.target.side : undefined;
		let placeSide: "top" | "bottom" = preferred ?? "bottom";
		const spaceBelow = vh - (rect.y + rect.h) - GAP - MARGIN;
		const spaceAbove = rect.y - GAP - MARGIN;
		if (
			placeSide === "bottom" &&
			cardH > spaceBelow &&
			spaceAbove > spaceBelow
		) {
			placeSide = "top";
		} else if (
			placeSide === "top" &&
			cardH > spaceAbove &&
			spaceBelow > spaceAbove
		) {
			placeSide = "bottom";
		}
		// If neither side has room, center the card so it is never clipped.
		if (cardH > Math.max(spaceAbove, spaceBelow)) {
			side = "center";
			cardLeft = clamp((vw - cardW) / 2, MARGIN, vw - cardW - MARGIN);
			cardTop = clamp((vh - cardH) / 2, MARGIN, vh - cardH - MARGIN);
		} else {
			side = placeSide;
			cardTop =
				placeSide === "bottom"
					? rect.y + rect.h + GAP
					: rect.y - cardH - GAP;
			cardLeft = clamp(
				rect.x + rect.w / 2 - cardW / 2,
				MARGIN,
				vw - cardW - MARGIN,
			);
			cardTop = clamp(cardTop, MARGIN, vh - cardH - MARGIN);
			arrowX = clamp(rect.x + rect.w / 2 - cardLeft, 22, cardW - 22);
		}
	} else {
		cardLeft = clamp((vw - cardW) / 2, MARGIN, vw - cardW - MARGIN);
		cardTop = clamp((vh - cardH) / 2, MARGIN, vh - cardH - MARGIN);
	}

	const StepIcon = step.icon;
	const title = noProject
		? t("onboarding.tour.noProject.title")
		: (step.title ?? t(`onboarding.tour.steps.${step.id}.title` as string));
	const body = noProject
		? t("onboarding.tour.noProject.body")
		: (step.body ?? t(`onboarding.tour.steps.${step.id}.body` as string));

	const scrimColor =
		"color-mix(in oklch, var(--color-background) 86%, transparent)";

	const goToCta = () => {
		if (ctaHref) {
			router.push(ctaHref);
		}
		onDismiss();
	};

	const overlay = (
		<div
			ref={overlayRef}
			className="pointer-events-none fixed inset-0"
			style={{ zIndex: 200 }}
			role="presentation"
		>
			{/* Render nothing until the target is resolved — never dim the screen
			 * with no card visible (the "dark background, nothing there" bug). */}
			{phase !== "resolving" && (
				<>
					{/* Scrim: for a spotlight, the hole element carries the veil via a
					 * large box-shadow spread. For a centered card, a plain veil. */}
					{spotlight && rect ? (
						<div
							aria-hidden="true"
							className="pointer-events-auto absolute rounded-xl"
							style={{
								left: rect.x,
								top: rect.y,
								width: rect.w,
								height: rect.h,
								boxShadow: `0 0 0 9999px ${scrimColor}, 0 0 0 2px var(--color-primary), 0 0 0 6px color-mix(in oklch, var(--color-primary) 22%, transparent)`,
								transition: prefersReducedMotion()
									? undefined
									: "left .3s cubic-bezier(.16,1,.3,1), top .3s cubic-bezier(.16,1,.3,1), width .3s cubic-bezier(.16,1,.3,1), height .3s cubic-bezier(.16,1,.3,1)",
							}}
						>
							<span
								aria-hidden="true"
								className="motion-safe:animate-pulse pointer-events-none absolute -inset-0.5 rounded-xl border border-primary/60"
							/>
						</div>
					) : (
						<div
							aria-hidden="true"
							className="pointer-events-auto absolute inset-0"
							style={{ background: scrimColor }}
						/>
					)}

					{/* Coach-mark card */}
					<div
						ref={cardRef}
						role="dialog"
						aria-modal="true"
						aria-labelledby="onboarding-tour-title"
						aria-describedby="onboarding-tour-body"
						tabIndex={-1}
						className={cn(
							"pointer-events-auto fixed w-[380px] max-w-[calc(100vw-28px)] rounded-2xl border border-border bg-card p-4 text-card-foreground shadow-xl outline-none",
							"motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95",
						)}
						style={{
							top: cardTop,
							left: cardLeft,
							width: cardW,
						}}
					>
						{side !== "center" && (
							<span
								aria-hidden="true"
								className="absolute size-3.5 rotate-45 border border-border bg-card"
								style={{
									left: arrowX,
									transform: "translateX(-50%) rotate(45deg)",
									...(side === "bottom"
										? {
												top: -7,
												borderRight: "none",
												borderBottom: "none",
											}
										: {
												bottom: -7,
												borderLeft: "none",
												borderTop: "none",
											}),
								}}
							/>
						)}

						<div className="mb-2.5 flex items-center gap-2.5">
							<span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
								<StepIcon className="size-4" />
							</span>
							<span className="flex-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
								{single
									? t("onboarding.tour.showMeEyebrow")
									: t("onboarding.tour.stepCounter", {
											current: index + 1,
											total,
										})}
							</span>
							<button
								type="button"
								onClick={onDismiss}
								aria-label={t("onboarding.tour.dismiss")}
								className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
							>
								<XIcon className="size-4" />
							</button>
						</div>

						<h2
							id="onboarding-tour-title"
							className="mb-1.5 font-semibold text-[15px] leading-snug text-foreground"
						>
							{title}
						</h2>
						<p
							id="onboarding-tour-body"
							className="mb-3.5 text-[13px] leading-relaxed text-muted-foreground"
						>
							{body}
						</p>

						{ctaHref && (
							<button
								type="button"
								onClick={goToCta}
								className="mb-3.5 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-primary transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-sm"
							>
								{noProject
									? t("onboarding.tour.createProject")
									: t("onboarding.tour.goTo")}
								<ChevronRightIcon className="size-3.5" />
							</button>
						)}

						{single ? (
							<div className="flex justify-end">
								<button
									type="button"
									onClick={onFinish}
									className="inline-flex items-center gap-1 rounded-lg bg-primary px-4 py-2 font-semibold text-[13px] text-primary-foreground shadow-sm transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card"
								>
									<CheckIcon className="size-3.5" />
									{t("onboarding.tour.gotIt")}
								</button>
							</div>
						) : (
							// At full width the dots and nav share one line. Once the
							// viewport clamps the card narrower there is no room for
							// that, and no width left to give — so the dots stretch
							// into a full-width bar and the nav centres beneath it.
							<div
								className={cn(
									"flex",
									cardClamped
										? "flex-col gap-3"
										: "flex-wrap items-center justify-between gap-x-3 gap-y-2",
								)}
							>
								{/* Progress dots — each is an individually labelled jump
								 * control ("Go to step N"), so no wrapper role is needed. */}
								<div
									className={cn(
										"flex items-center gap-1.5",
										cardClamped
											? "w-full"
											: "min-w-0 flex-wrap",
									)}
								>
									{steps.map((s, n) => (
										<button
											key={s.id}
											type="button"
											aria-current={
												n === index ? "step" : undefined
											}
											aria-label={t(
												"onboarding.tour.goToStep",
												{
													step: n + 1,
												},
											)}
											onClick={() => onGoTo(n)}
											className={cn(
												"h-1.5 rounded-full transition-[width,background-color] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
												cardClamped
													? "flex-1"
													: n === index
														? "w-5"
														: "w-1.5",
												n === index
													? "bg-primary"
													: n < index
														? "bg-primary/40"
														: "bg-border",
											)}
										/>
									))}
								</div>
								<div
									className={cn(
										"flex shrink-0 items-center gap-1.5",
										cardClamped
											? "justify-center"
											: "ml-auto",
									)}
								>
									{!isFirst && (
										<button
											type="button"
											onClick={onBack}
											className="inline-flex items-center gap-1 rounded-lg border border-border bg-background px-2.5 py-1.5 font-medium text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
										>
											<ChevronLeftIcon className="size-3.5" />
											{t("onboarding.tour.back")}
										</button>
									)}
									{!isLast && (
										<button
											type="button"
											onClick={onSkipStep}
											className="rounded-lg px-2.5 py-1.5 font-medium text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
										>
											{t("onboarding.tour.skip")}
										</button>
									)}
									{isLast ? (
										<button
											type="button"
											onClick={onFinish}
											className="inline-flex items-center gap-1 rounded-lg bg-primary px-4 py-2 font-semibold text-[13px] text-primary-foreground shadow-sm transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card"
										>
											<CheckIcon className="size-3.5" />
											{t("onboarding.tour.done")}
										</button>
									) : (
										<button
											type="button"
											onClick={onNext}
											className="inline-flex items-center gap-1 rounded-lg bg-primary px-4 py-2 font-semibold text-[13px] text-primary-foreground shadow-sm transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card"
										>
											{t("onboarding.tour.next")}
											<ChevronRightIcon className="size-3.5" />
										</button>
									)}
								</div>
							</div>
						)}
					</div>

					{/* Persistent skip-tour affordance — hidden for a single "Show me". */}
					{!single && (
						<button
							type="button"
							onClick={onDismiss}
							className="pointer-events-auto fixed bottom-5 left-5 rounded-full border border-border bg-card px-4 py-1.5 font-medium text-[12.5px] text-muted-foreground shadow-md transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
						>
							{t("onboarding.tour.skipTour")}
						</button>
					)}
				</>
			)}
		</div>
	);

	return createPortal(overlay, document.body);
}
