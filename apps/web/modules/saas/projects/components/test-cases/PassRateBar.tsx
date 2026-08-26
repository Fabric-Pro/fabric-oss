"use client";

import { cn } from "@ui/lib";
import { useTranslations } from "next-intl";
import { RESULT_I18N_KEY, TONE_CLASSES } from "./constants";
import type { PlanPassRateView } from "./plan-pass-rate";

type Props = {
	view: PlanPassRateView;
	className?: string;
};

/**
 * The segmented result-mix bar shared by every surface that shows a pass rate
 * (plan detail, the plan runner's summary, a feature's coverage row).
 *
 * Meaning rides on the labelled breakdown, not the colour: the bar is one
 * `role="img"` with every segment's count named in its accessible label, so a
 * screen-reader user gets the same information sighted users read off the
 * widths (WCAG 1.4.1). Segment fills are design-system tones via
 * `TONE_CLASSES[...].solid` — the component never names a colour itself.
 */
export function PassRateBar({ view, className }: Props) {
	const t = useTranslations("projects.testCases");

	const barAria = t("plans.card.passRateAria", {
		breakdown: view.segments
			.map((s) => `${t(RESULT_I18N_KEY[s.result])}: ${s.count}`)
			.join(", "),
	});

	return (
		<div
			role="img"
			aria-label={barAria}
			className={cn(
				"flex h-2 overflow-hidden rounded-full bg-muted",
				className,
			)}
		>
			{view.segments.map((s) =>
				s.pct > 0 ? (
					<span
						key={s.result}
						className={TONE_CLASSES[s.tone].solid}
						style={{ width: `${s.pct}%` }}
					/>
				) : null,
			)}
		</div>
	);
}

/**
 * The rate itself: the rounded passing percent, or an honest "not run yet" when
 * nothing has been executed. Plain `text-foreground` numerals — a pass rate is
 * data, so it never carries a gradient.
 */
export function PassRateValue({ view }: { view: PlanPassRateView }) {
	const t = useTranslations("projects.testCases");

	if (view.executed === 0) {
		return (
			<span className="text-muted-foreground text-xs">
				{t("plans.card.notRunYet")}
			</span>
		);
	}

	// Rendered exactly as the plan cards do — one presentation for one number.
	return (
		<span className="font-semibold text-foreground text-sm tabular-nums">
			{view.passingPct}%
		</span>
	);
}
