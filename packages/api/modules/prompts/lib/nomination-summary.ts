import { generatePromptChangeSummary } from "@repo/ai";

/**
 * Summarise how a nominated prompt differs from the one currently in force.
 *
 * FR16 wants the reviewing admin to see what changed without diffing two bodies
 * by eye. The non-functional requirement attached to it is the important half:
 * this must degrade gracefully, because a summariser outage must never be the
 * reason a nomination cannot be reviewed.
 *
 * So the model call is allowed to come back empty-handed — every way it can
 * fail is one answer, `null`, handled here — and what replaces it says plainly
 * that it is a fallback. A reviewer weighs "the model read both prompts"
 * differently from "we counted the characters", and cannot tell them apart
 * unless we say so.
 */

export type NominationSummary = {
	summary: string;
	degraded: boolean;
};

/** What we can always say without a model. */
function describeWithoutAI(
	proposed: string,
	current: string | null,
): NominationSummary {
	if (!current) {
		return {
			summary: `Proposes a prompt where the action currently has none. ${proposed.length} characters.`,
			degraded: true,
		};
	}

	const delta = proposed.length - current.length;
	const direction =
		delta === 0
			? "the same length"
			: delta > 0
				? `${delta} characters longer`
				: `${Math.abs(delta)} characters shorter`;

	return {
		summary: `Automatic summary unavailable. The proposed prompt is ${direction} than the current default (${current.length} → ${proposed.length} characters). Compare the full text below before deciding.`,
		degraded: true,
	};
}

export async function summariseNominationChange({
	proposedContent,
	currentContent,
	userId,
	organizationId,
}: {
	proposedContent: string;
	currentContent: string | null;
	userId: string;
	organizationId?: string | null;
}): Promise<NominationSummary> {
	const summary = await generatePromptChangeSummary({
		proposedContent,
		currentContent,
		userId,
		organizationId,
	});

	if (!summary) {
		return describeWithoutAI(proposedContent, currentContent);
	}

	return { summary, degraded: false };
}
