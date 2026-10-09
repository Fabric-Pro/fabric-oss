"use client";

import { useTranslations } from "next-intl";

/** The part of a plan's usage estimate these lines read. */
export interface PlanWindowEstimate {
	resetsAt: Date | string | null;
	lastRequestAt: Date | string | null;
	topConsumers: Array<{
		kind: "job" | "feature" | "other";
		key: string | null;
		percent: number;
	}>;
}

function clock(date: Date | string): string {
	return new Intl.DateTimeFormat(undefined, {
		hour: "2-digit",
		minute: "2-digit",
	}).format(new Date(date));
}

/**
 * When the plan's anchored window resets and who spent it (Fizzy #2770 F1):
 * "Last request 03:33 · resets at 06:37" and "Used by: Teams channel monitor
 * 92% · Advisor 8%". A job or feature with no label shows its raw key.
 */
export function PlanWindowDetails({
	estimate,
}: {
	estimate: PlanWindowEstimate;
}) {
	const t = useTranslations("settings.chatgptPlanWindow");
	const label = (consumer: PlanWindowEstimate["topConsumers"][number]) => {
		if (consumer.kind === "other" || !consumer.key) {
			return t("otherConsumer");
		}
		const key = `consumers.${consumer.key}`;
		return t.has(key) ? t(key) : consumer.key;
	};

	const timing = estimate.lastRequestAt
		? estimate.resetsAt
			? t("lastRequestResets", {
					last: clock(estimate.lastRequestAt),
					reset: clock(estimate.resetsAt),
				})
			: t("lastRequestNoWindow", { last: clock(estimate.lastRequestAt) })
		: t("noOpenWindow");

	return (
		<div className="space-y-1 text-muted-foreground text-xs">
			<p data-testid="chatgpt-plan-window-timing">{timing}</p>
			{estimate.resetsAt && estimate.topConsumers.length > 0 ? (
				<p data-testid="chatgpt-plan-window-consumers">
					{t("usedBy", {
						consumers: estimate.topConsumers
							.map(
								(consumer) =>
									`${label(consumer)} ${consumer.percent}%`,
							)
							.join(" · "),
					})}
				</p>
			) : null}
		</div>
	);
}
