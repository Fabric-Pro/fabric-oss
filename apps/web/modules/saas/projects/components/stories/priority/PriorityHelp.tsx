"use client";

import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from "@ui/components/hover-card";
import {
	HistoryIcon,
	InfoIcon,
	ListOrderedIcon,
	PencilIcon,
	WandSparklesIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";

const SECTIONS = [
	{ key: "rank", Icon: ListOrderedIcon },
	{ key: "reprioritize", Icon: WandSparklesIcon },
	{ key: "override", Icon: PencilIcon },
	{ key: "history", Icon: HistoryIcon },
] as const;

// The signals the Re-prioritize pass weighs, strongest first — mirrors the
// priority_reprioritization prompt so the help stays honest about what drives a
// band. "Confirmed decisions" are the project's ACCEPTED Decisions-tab entries.
const CRITERIA = [
	"criteriaBlocker",
	"criteriaSecurity",
	"criteriaDecisions",
	"criteriaQuestions",
	"criteriaAge",
	"criteriaStage",
] as const;

/**
 * "How priority works" — an (i) icon that reveals the explanation on hover.
 *
 * It was a click-to-open dialog; the ask was to make it a passive affordance
 * that never steals a click and never covers the list — hover (or keyboard
 * focus, which Radix HoverCard also honours) shows a panel and moving away
 * dismisses it. The trigger is a real `<button>` so it is focusable and
 * announced; `openDelay`/`closeDelay` keep it from flickering as the pointer
 * crosses it on the way to the toolbar buttons.
 *
 * Touch is the one exception to "never opens on click": a device with no
 * hover has no other way in, so a tap toggles the card there — and only
 * there. Pointer devices keep the strict hover/focus behaviour.
 */
export function PriorityHelp() {
	const t = useTranslations("projects.stories.priority.help");
	const [open, setOpen] = useState(false);
	const descriptionId = useId();

	const handleClick = () => {
		if (window.matchMedia("(hover: none)").matches) {
			setOpen((prev) => !prev);
		}
	};

	return (
		<>
			<HoverCard
				open={open}
				onOpenChange={setOpen}
				openDelay={120}
				closeDelay={80}
			>
				<HoverCardTrigger asChild>
					<button
						type="button"
						// Not a menu/dialog trigger on pointer devices: it opens
						// nothing on click there, so it carries no
						// aria-expanded/haspopup. Radix HoverCard content is
						// sighted-only (portaled, no aria wiring), so the FULL
						// help text rides on aria-describedby — a screen reader
						// hears the label, then the whole explanation, without
						// needing the visual card at all.
						aria-label={t("trigger")}
						aria-describedby={descriptionId}
						onClick={handleClick}
						className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					>
						<InfoIcon aria-hidden className="size-4" />
					</button>
				</HoverCardTrigger>
				<HoverCardContent
					align="end"
					className="max-h-[var(--radix-hover-card-content-available-height)] w-[min(22rem,calc(100vw-2rem))] overflow-y-auto"
				>
					<p className="font-medium text-foreground text-sm">
						{t("heading")}
					</p>
					<p className="mt-0.5 text-muted-foreground text-xs leading-relaxed">
						{t("intro")}
					</p>
					<ul className="mt-3 space-y-3">
						{SECTIONS.map(({ key, Icon }) => (
							<li key={key} className="flex gap-2.5">
								<span
									aria-hidden
									className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted text-muted-foreground"
								>
									<Icon className="size-3" />
								</span>
								<div className="min-w-0">
									<p className="font-medium text-foreground text-xs">
										{t(`${key}Title`)}
									</p>
									<p className="mt-0.5 text-muted-foreground text-xs leading-relaxed">
										{t(`${key}Body`)}
									</p>
								</div>
							</li>
						))}
					</ul>
					<div className="mt-3">
						<p className="font-medium text-foreground text-xs">
							{t("criteriaHeading")}
						</p>
						<ul className="mt-1.5 space-y-1">
							{CRITERIA.map((key) => (
								<li
									key={key}
									className="flex items-start gap-2 text-muted-foreground text-xs leading-relaxed"
								>
									<span
										aria-hidden
										className="mt-1.5 size-1 shrink-0 rounded-full bg-muted-foreground/60"
									/>
									<span>{t(key)}</span>
								</li>
							))}
						</ul>
					</div>
					{/* The single most predictable support question, answered where
				    people read how the feature works: bands never sync out. */}
					<p className="mt-3 border-border/60 border-t pt-2 text-muted-foreground text-xs">
						{t("fabricOnlyNote")}
					</p>
				</HoverCardContent>
			</HoverCard>
			{/* The aria-describedby source. `hidden`, not sr-only: accessible-name
			    computation still reads hidden describedby targets, but hidden
			    keeps it OUT of the browse-mode reading order (an sr-only sibling
			    sat as ~1k chars of loose text between two toolbar buttons).
			    Deliberately just the intro + the PM-sync line — a description is
			    a summary spoken after the name on every focus, not the full card;
			    the four detailed sections stay a visual/hover surface. */}
			<span id={descriptionId} hidden>
				{t("intro")} {t("fabricOnlyNote")}
			</span>
		</>
	);
}
