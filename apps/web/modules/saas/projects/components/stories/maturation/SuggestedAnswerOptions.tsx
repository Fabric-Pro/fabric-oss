"use client";

import { Button } from "@ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { PencilIcon, SparklesIcon } from "lucide-react";
import type { SuggestedAnswerOption } from "./types";

/**
 * The words around the options.
 *
 * Passed in rather than read from `useTranslations` here: Feature Maturation is
 * translated under `maturation.summaryQuestions.*` and the Publishing Suite's
 * strings are still hardcoded English. Taking the copy as props lets one
 * component serve both without forcing a translation pass into this change —
 * and when Publishing is translated, only its call site moves.
 */
export interface SuggestedAnswerOptionsLabels {
	heading: string;
	typeYourOwn: string;
	/** The pencil's real name, per option — several render at once, so a bare
	 *  "Edit" is ambiguous to a screen reader. */
	editAria: (optionText: string) => string;
	/** The pencil's tooltip, for sighted pointer users. */
	editTooltip: string;
}

/**
 * The suggested answers under an open question, in ONE dialect.
 *
 * Feature Maturation and the Publishing Suite both offer several AI answers per
 * question, and until now each drew them its own way: an outline `Button` whose
 * whole face accepts with the pencil painted into its corner (Maturation),
 * versus a bordered `div` holding a bare `button` with the pencil as a sibling
 * (Publishing) — under a heading that was `text-secondary` on one surface and
 * `text-muted-foreground` on the other. Two surfaces answering the same
 * question with the same controls should not read as two features, which is
 * design-QA finding #6 ("question card dialect ≠ FMv2") and its proposal 1.
 *
 * ACCEPT AND EDIT ARE SIBLINGS, NOT NESTED. The accept affordance is itself a
 * button, so the pencil cannot live inside it; it is only PAINTED inside, by
 * positioning it over the corner that `pr-10` reserves. Same DOM, two
 * independent hit targets. The pencil is visible at rest rather than revealed
 * on hover — a hover-only control does not exist on touch.
 *
 * WHAT THIS COMPONENT DELIBERATELY DOES NOT DECIDE: how an answer is
 * classified. `onAccept` and `onEdit` are the caller's, and each surface keeps
 * recording `AI_SUGGESTED` / `AI_EDITED` / `MANUAL` exactly as it did before —
 * that column is a measured acceptance metric, so two surfaces must not start
 * naming the same act differently because their buttons were harmonised.
 *
 * READ-ONLY is the same list without the controls: omit `onAccept` and the rows
 * render as static text at identical typography, with no pencil and no "type
 * your own". A reader still needs to see what was proposed.
 */
export function SuggestedAnswerOptions({
	options,
	labels,
	disabled = false,
	className,
	onAccept,
	onEdit,
	onTypeYourOwn,
}: {
	options: readonly SuggestedAnswerOption[];
	labels: SuggestedAnswerOptionsLabels;
	disabled?: boolean;
	className?: string;
	/** Absent for a reader — the list renders without any controls. */
	onAccept?: (option: SuggestedAnswerOption) => void;
	/** Opens the caller's editor seeded with this option's text. */
	onEdit?: (option: SuggestedAnswerOption) => void;
	/** Opens the caller's editor empty. */
	onTypeYourOwn?: () => void;
}) {
	if (options.length === 0) {
		return null;
	}

	const isInteractive = Boolean(onAccept);

	return (
		<div className={cn("space-y-2", className)}>
			<p className="flex items-center gap-1.5 font-medium text-[11px] text-muted-foreground uppercase tracking-[0.12em]">
				<SparklesIcon
					className="size-3 text-primary"
					aria-hidden="true"
				/>
				{labels.heading}
			</p>
			<ul className="space-y-2">
				{options.map((option) => (
					<li key={option.text} className="relative">
						{isInteractive ? (
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => onAccept?.(option)}
								disabled={disabled}
								className="h-auto w-full flex-col items-start gap-0.5 whitespace-normal py-2 pr-10 text-left"
							>
								<span className="font-medium text-xs">
									{option.text}
								</span>
								{option.justification ? (
									<span className="font-normal text-[11px] text-muted-foreground">
										{option.justification}
									</span>
								) : null}
							</Button>
						) : (
							<div className="rounded-md border border-border bg-card px-3 py-2">
								<span className="block font-medium text-xs">
									{option.text}
								</span>
								{option.justification ? (
									<span className="mt-0.5 block font-normal text-[11px] text-muted-foreground">
										{option.justification}
									</span>
								) : null}
							</div>
						)}
						{isInteractive && onEdit ? (
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										type="button"
										variant="ghost"
										size="icon"
										onClick={() => onEdit(option)}
										disabled={disabled}
										aria-label={labels.editAria(
											option.text,
										)}
										className="absolute top-1 right-1 size-7 text-muted-foreground opacity-70 transition-[color,opacity] hover:bg-transparent hover:text-foreground hover:opacity-100 focus-visible:opacity-100"
									>
										<PencilIcon className="size-3.5" />
									</Button>
								</TooltipTrigger>
								<TooltipContent side="left">
									{labels.editTooltip}
								</TooltipContent>
							</Tooltip>
						) : null}
					</li>
				))}
			</ul>
			{isInteractive && onTypeYourOwn ? (
				<Button
					type="button"
					variant="ghost"
					size="sm"
					onClick={onTypeYourOwn}
					disabled={disabled}
					className="text-xs"
				>
					{labels.typeYourOwn}
				</Button>
			) : null}
		</div>
	);
}
