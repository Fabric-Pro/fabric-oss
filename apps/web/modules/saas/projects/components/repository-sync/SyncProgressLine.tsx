"use client";

import { Progress } from "@ui/components/progress";
import { Loader2Icon } from "lucide-react";

/**
 * One line of "where is this run": what it is doing, and how far it has got.
 *
 * Shared by the Coding Instructions tab (upload checks, repository sync) and
 * Living Memory's sync, so a count reads the same wherever it appears.
 *
 * `phase` is the name of the step alone and `text` the full visible line
 * (usually the phase with its "X of Y"). Only `phase` is announced: it lives
 * in the screen-reader-only span, inside the live region its caller already
 * provides, and `text` is `aria-hidden`. The count therefore changes on every
 * poll without being read out again each time; what a screen reader hears is
 * the step changing. A determinate bar appears only when `total` is known,
 * and is hidden from assistive technology for the same reason.
 *
 * There is no percentage anywhere and no estimate of the time left: a count
 * is the work that has finished, as the server reported it.
 */
export function SyncProgressLine({
	phase,
	text,
	done,
	total,
	showSpinner = true,
	className = "inline-flex items-center gap-1.5",
	testId,
}: {
	phase: string;
	text: string;
	done?: number | null;
	total?: number | null;
	showSpinner?: boolean;
	className?: string;
	testId?: string;
}) {
	const barKnown =
		typeof done === "number" &&
		typeof total === "number" &&
		total > 0 &&
		done <= total;
	return (
		<span className="flex flex-col gap-1" data-testid={testId}>
			<span className={className}>
				{showSpinner ? (
					<Loader2Icon
						className="size-3.5 motion-safe:animate-spin"
						aria-hidden="true"
					/>
				) : null}
				<span className="sr-only">{phase}</span>
				<span aria-hidden="true">{text}</span>
			</span>
			{barKnown ? (
				<Progress
					aria-hidden="true"
					className="h-1 w-48"
					value={(done / total) * 100}
					data-testid="sync-progress-bar"
				/>
			) : null}
		</span>
	);
}
