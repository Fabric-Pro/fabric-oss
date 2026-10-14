import type {
	ChatGptPlanReportedUsage,
	ChatGptPlanWindow,
	ChatGptPlanWindowCalibration,
} from "@repo/database";

/**
 * How much of a shared account's window is used, and how much of it one
 * member used, as the picker reads it (Fizzy #2770): from the usage OpenAI
 * reported while that report is fresh, else from Fabric's estimate.
 */
export interface ChatGptPlanAccountUsage {
	/** Share of the window used, 0–1 (may exceed 1 on the estimate). */
	share: number;
	/** The member's own share of the window, 0–100. */
	memberPercent: number;
	/** When the window resets, by the same source. */
	resetsAt: Date | null;
	source: "reported" | "estimated";
	/** A real refusal calibrated the budget the estimate is measured against. */
	calibrated: boolean;
}

export function chatGptPlanAccountUsage(params: {
	window: ChatGptPlanWindow | undefined;
	calibration: ChatGptPlanWindowCalibration | undefined;
	reported: ChatGptPlanReportedUsage | null;
	userId: string;
}): ChatGptPlanAccountUsage {
	const { window, reported } = params;
	const total = window?.weightedInputTokens ?? 0;
	const mine = window?.weightedInputTokensByUser?.[params.userId] ?? 0;
	const calibrated = params.calibration?.calibrated ?? false;
	if (reported?.windowFresh && reported.window) {
		// OpenAI reports the account as a whole; the member's part of it is
		// their part of Fabric's calls, scaled to the reported percent.
		const reportedPercent = reported.window.usedPercent;
		return {
			share: reportedPercent / 100,
			memberPercent: total > 0 ? (mine / total) * reportedPercent : 0,
			resetsAt: reported.window.resetsAt ?? window?.resetsAt ?? null,
			source: "reported",
			calibrated,
		};
	}
	const budget = params.calibration?.budget ?? 0;
	return {
		share: budget > 0 ? total / budget : 0,
		memberPercent: budget > 0 ? (mine / budget) * 100 : 0,
		resetsAt: window?.resetsAt ?? null,
		source: "estimated",
		calibrated,
	};
}

/**
 * `within` the member's fair share; `over` it by the estimate alone, which
 * only moves the account down the pick order; `blocked` when the plan's real
 * limits back it up — a fresh report from OpenAI, or a budget a refusal
 * calibrated. Fabric never refuses work OpenAI would still serve on the
 * strength of its own guess.
 */
export type FairShare = "within" | "over" | "blocked";

export function chatGptPlanFairShare(
	usage: ChatGptPlanAccountUsage,
	maxMemberSharePct: number,
): FairShare {
	if (usage.memberPercent < maxMemberSharePct) {
		return "within";
	}
	return usage.source === "reported" || usage.calibrated ? "blocked" : "over";
}
