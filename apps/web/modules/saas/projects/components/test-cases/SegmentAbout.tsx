"use client";

import { Button } from "@ui/components/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ui/components/popover";
import { InfoIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import type { Segment } from "./use-test-cases-view";

/**
 * "What is this tab for?", answered where the question is asked.
 *
 * The QA page has six segments that do genuinely different jobs — authoring,
 * grouping, coverage, execution history, pull-request reads, open questions —
 * and the page-level subtitle can only describe one of them at a time. So each
 * segment explains itself: what it is, what belongs in it, and what it does NOT
 * do, which is usually the part that saves someone looking in the wrong place.
 *
 * Deliberately a popover rather than always-on prose. This is reference text a
 * reader wants once and then never again, and permanent explanation above a
 * working list is the thing people learn to scroll past.
 *
 * Distinct from the guided tour beside it: the tour walks the page in order for
 * someone seeing it for the first time; this answers one question about the one
 * segment in front of you, at any time.
 *
 * Takes `Segment`, not `string`: both lookups below are template keys, so a
 * segment with no copy renders a raw key rather than failing. Binding to the
 * union makes the next segment a compile error here until its copy exists.
 */
export function SegmentAbout({ segment }: { segment: Segment }) {
	const t = useTranslations("projects.testCases.about");

	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button
					type="button"
					data-onboarding-target="test-cases-about"
					variant="ghost"
					size="icon"
					className="size-7 shrink-0 text-muted-foreground"
					// Named per segment so a screen-reader user is told WHICH tab
					// this explains — several of these can exist on one page over
					// the life of a session, and "About" alone identifies none.
					aria-label={t("trigger", {
						segment: t(`${segment}.title`),
					})}
				>
					<InfoIcon className="size-4" aria-hidden="true" />
				</Button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-80 text-sm">
				<p className="font-medium">{t(`${segment}.title`)}</p>
				<p className="mt-1 text-muted-foreground text-xs leading-relaxed">
					{t(`${segment}.body`)}
				</p>
			</PopoverContent>
		</Popover>
	);
}
