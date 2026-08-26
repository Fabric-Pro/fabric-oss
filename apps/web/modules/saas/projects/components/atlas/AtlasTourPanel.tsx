"use client";

/**
 * Business onboarding tour panel (AC#10 — Business view only).
 *
 * Shows `status.businessTour.intro` then steps through `TourStep[]`:
 *   - Each step highlights/focuses the named capability node in the graph.
 *   - Displays step title + narrative in a card with Next/Back/Skip.
 *   - Respects `prefers-reduced-motion` via `motion-safe:` variants.
 *   - Warm, plain-language presentation for non-technical newcomers.
 *
 * This component is positioned as a floating overlay card above the graph area.
 * Parent is responsible for showing/hiding it (activeStep !== null).
 */
import type { BusinessTour } from "@repo/atlas/types";
import { Button } from "@ui/components/button";
import { cn } from "@ui/lib";
import {
	ArrowLeftIcon,
	ArrowRightIcon,
	CheckIcon,
	ChevronLeftIcon,
	ChevronRightIcon,
	FocusIcon,
	SparklesIcon,
	XIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { ScrollFade } from "./ScrollFade";

interface AtlasTourPanelProps {
	tour: BusinessTour;
	activeStep: number; // 0 = intro, 1..n = steps[0..n-1]
	onStepChange: (step: number) => void;
	onFocusNode: (key: string) => void;
	/** Dismiss handler for the card-variant skip (X). Unused by `variant="hero"`. */
	onClose?: () => void;
	/** Always-on placement (Overview dashboard): hide the skip (X) and make
	 *  Finish loop back to the intro instead of closing. */
	persistent?: boolean;
	/** Auto-focus a step's node on navigation. Off on the Overview, where no
	 *  graph is mounted — focusing happens only via the explicit "Show in graph". */
	autoFocusOnStep?: boolean;
	/**
	 * Presentation:
	 *  - `"card"` (default): self-contained bordered card with its own header —
	 *    a floating overlay above the graph, or a standalone panel.
	 *  - `"hero"`: chrome-less walkthrough that lives INSIDE the Overview hero,
	 *    directly beneath the editorial label + serif title (which the hero owns).
	 *    No card/border/header — just the paged body and a compact prev/next nav.
	 */
	variant?: "card" | "hero";
	/**
	 * Override the fixed body height of the `"hero"` variant (default `h-32`). The
	 * Overview hero tightens this so its left column stays short beside the stats.
	 */
	heroBodyClassName?: string;
}

export function AtlasTourPanel({
	tour,
	activeStep,
	onStepChange,
	onFocusNode,
	onClose,
	persistent = false,
	autoFocusOnStep = true,
	variant = "card",
	heroBodyClassName = "h-32",
}: AtlasTourPanelProps) {
	const t = useTranslations("projects.atlas.tour");

	// Step 0 = intro; steps 1..n = tour.steps[0..n-1]
	const totalSteps = tour.steps.length;
	const isIntro = activeStep === 0;
	const stepIndex = isIntro ? null : activeStep - 1;
	const currentStep = stepIndex !== null ? tour.steps[stepIndex] : null;

	const handleNext = () => {
		if (activeStep < totalSteps) {
			onStepChange(activeStep + 1);
			// Focus the capability node for the step we're moving into.
			const nextStep = tour.steps[activeStep]; // activeStep 0-indexed into steps when activeStep >= 1
			if (autoFocusOnStep && nextStep) {
				onFocusNode(nextStep.capabilityKey);
			}
		} else if (persistent) {
			// Always-on placement: Finish loops back to the intro.
			onStepChange(0);
		} else {
			onClose?.();
		}
	};

	const handleBack = () => {
		if (activeStep > 0) {
			onStepChange(activeStep - 1);
			// Focus the capability node for the step we're moving back to.
			if (autoFocusOnStep && activeStep > 1) {
				const prevStep = tour.steps[activeStep - 2];
				if (prevStep) {
					onFocusNode(prevStep.capabilityKey);
				}
			}
		}
	};

	const handleFocusCurrent = () => {
		if (currentStep) {
			onFocusNode(currentStep.capabilityKey);
		}
	};

	const isLast = activeStep === totalSteps;

	// ── Hero variant ────────────────────────────────────────────────────────
	// Lives inside the Overview hero, beneath the editorial label + serif title,
	// spanning the FULL hero width (the language mix sits below, not beside).
	// No card chrome / header (the hero owns those) — just the paged body and a
	// looping prev · dots · next navigator. It is a true carousel: Next on the
	// last page wraps to the first and Back on the first wraps to the last. The
	// dots are real buttons (click to jump); an aria-live caption announces the
	// position on change.
	if (variant === "hero") {
		const totalPages = totalSteps + 1; // intro (page 0) + one page per step
		// Wrap-around navigation — the modulo keeps every target in range so
		// Next/Back loop seamlessly past either end.
		const goTo = (page: number) =>
			onStepChange(((page % totalPages) + totalPages) % totalPages);

		return (
			<div className="mt-5">
				{/* Paged body. FIXED height so the pager never moves as pages
				    change length — different narrative lengths and a title that
				    wraps to 1 vs 2 lines would otherwise reflow the hero. A longer
				    page scrolls internally; `ScrollFade` makes that obvious (a
				    visible thin scrollbar + a soft bottom fade while there's more
				    below) and never decorates a page that already fits. The key
				    restarts the entrance fade and re-measures on each page. */}
				<ScrollFade
					key={activeStep}
					wrapperClassName="mt-5 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300"
					className={cn("pr-1", heroBodyClassName)}
				>
					{isIntro ? (
						<p className="max-w-none text-sm leading-relaxed text-muted-foreground">
							{tour.intro}
						</p>
					) : currentStep ? (
						<div className="space-y-2">
							<h3 className="max-w-none font-serif text-lg font-normal leading-snug text-foreground">
								{currentStep.title}
							</h3>
							<p className="max-w-none text-sm leading-relaxed text-muted-foreground">
								{currentStep.narrative}
							</p>
							<button
								type="button"
								onClick={handleFocusCurrent}
								className="inline-flex items-center gap-1.5 rounded text-xs font-medium text-primary transition-colors hover:text-primary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							>
								<FocusIcon
									aria-hidden="true"
									className="size-3.5"
								/>
								{t("focusNode")}
							</button>
						</div>
					) : null}
				</ScrollFade>

				{/* Carousel navigator: clickable page dots on the LEFT (the active
				    one is a filled, wider pill marked aria-current); a "N / total"
				    pill plus looping Back / Next on the RIGHT. Each dot is a real
				    button — keyboard-operable, with a hit area padded out past the
				    1.5px bar. An sr-only live region announces the position on
				    change; a pager is a minor navigation landmark — a labelled
				    <nav>. */}
				<nav
					aria-label={t("title")}
					className="mt-4 flex items-center justify-between gap-3 border-t border-border/50 pt-3"
				>
					<div className="flex items-center gap-1.5">
						{/* Accessible position — announced politely on change. */}
						<span className="sr-only" aria-live="polite">
							{t("pageOf", {
								current: activeStep + 1,
								total: totalPages,
							})}
						</span>
						{/* `-my-2` cancels each dot's `py-2` hit-area padding so the
						    enlarged tap target adds no vertical height to the row. */}
						<div className="-my-2 flex items-center">
							{Array.from({ length: totalPages }, (_, i) => {
								const isActive = i === activeStep;
								return (
									<button
										key={i}
										type="button"
										onClick={() => onStepChange(i)}
										aria-label={t("goToPage", {
											page: i + 1,
										})}
										aria-current={
											isActive ? "true" : undefined
										}
										className="group/dot flex cursor-pointer items-center px-1 py-2 focus-visible:outline-none"
									>
										<span
											className={cn(
												"h-1.5 rounded-full motion-safe:transition-[width,background-color] motion-safe:duration-200 group-hover/dot:bg-primary/60 group-focus-visible/dot:ring-2 group-focus-visible/dot:ring-ring",
												isActive
													? "w-4 bg-primary"
													: "w-1.5 bg-muted-foreground/30",
											)}
										/>
									</button>
								);
							})}
						</div>
					</div>

					<div className="flex items-center gap-2">
						{/* Visible page indicator (mirrors the dots for sighted
						    users who aren't tracking the active pill). */}
						<span
							aria-hidden="true"
							className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground"
						>
							{activeStep + 1} / {totalPages}
						</span>
						<Button
							type="button"
							variant="outline"
							size="icon-sm"
							aria-label={t("back")}
							onClick={() => goTo(activeStep - 1)}
						>
							<ChevronLeftIcon
								aria-hidden="true"
								className="size-4"
							/>
						</Button>
						<Button
							type="button"
							size="sm"
							onClick={() => goTo(activeStep + 1)}
							className="gap-1"
						>
							{t("next")}
							<ChevronRightIcon
								aria-hidden="true"
								className="size-4"
							/>
						</Button>
					</div>
				</nav>
			</div>
		);
	}

	return (
		<div
			className={cn(
				"rounded-xl border border-primary/20 bg-card shadow-md",
				"motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-2",
			)}
		>
			{/* Header */}
			<div className="flex items-start justify-between border-b border-border/60 px-4 py-3">
				<div className="flex items-start gap-2">
					<SparklesIcon
						aria-hidden="true"
						className="mt-0.5 size-4 shrink-0 text-primary"
					/>
					<div>
						<p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
							{t("intro")}
						</p>
						{!isIntro && (
							<p className="text-xs text-muted-foreground">
								{t("stepOf", {
									current: activeStep,
									total: totalSteps,
								})}
							</p>
						)}
					</div>
				</div>
				{!persistent && (
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						aria-label={t("skip")}
						onClick={() => onClose?.()}
					>
						<XIcon aria-hidden="true" className="size-4" />
					</Button>
				)}
			</div>

			{/* Body */}
			<div className="px-4 py-3">
				{isIntro ? (
					<p className="text-sm text-foreground leading-relaxed">
						{tour.intro}
					</p>
				) : currentStep ? (
					<div className="space-y-2">
						<h4 className="font-serif text-base text-foreground">
							{currentStep.title}
						</h4>
						<p className="text-sm text-foreground leading-relaxed">
							{currentStep.narrative}
						</p>
					</div>
				) : null}
			</div>

			{/* Footer controls */}
			<div className="flex items-center justify-between border-t border-border/60 px-4 py-2.5">
				<div className="flex items-center gap-1.5">
					{/* Dot indicators */}
					<div className="flex items-center gap-1">
						{Array.from({ length: totalSteps + 1 }, (_, i) => (
							<button
								key={i}
								type="button"
								onClick={() => {
									onStepChange(i);
									if (autoFocusOnStep && i > 0) {
										const s = tour.steps[i - 1];
										if (s) {
											onFocusNode(s.capabilityKey);
										}
									}
								}}
								aria-label={
									i === 0
										? t("intro")
										: t("stepOf", {
												current: i,
												total: totalSteps,
											})
								}
								className={cn(
									"size-1.5 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
									i === activeStep
										? "bg-primary"
										: "bg-muted-foreground/30",
								)}
							/>
						))}
					</div>
				</div>

				<div className="flex items-center gap-1.5">
					{/* Focus current node button (only on steps, not intro) */}
					{!isIntro && currentStep && (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={handleFocusCurrent}
							className="gap-1.5 text-xs"
						>
							<FocusIcon
								aria-hidden="true"
								className="size-3.5"
							/>
							{t("focusNode")}
						</Button>
					)}
					{activeStep > 0 && (
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={handleBack}
							className="gap-1"
						>
							<ArrowLeftIcon
								aria-hidden="true"
								className="size-3.5"
							/>
							{t("back")}
						</Button>
					)}
					<Button
						type="button"
						size="sm"
						onClick={handleNext}
						className="gap-1"
					>
						{isLast ? (
							<>
								<CheckIcon
									aria-hidden="true"
									className="size-3.5"
								/>
								{persistent ? t("restart") : t("finish")}
							</>
						) : (
							<>
								{t("next")}
								<ArrowRightIcon
									aria-hidden="true"
									className="size-3.5"
								/>
							</>
						)}
					</Button>
				</div>
			</div>
		</div>
	);
}
