/**
 * The asset-confirmation loop shared by every Publishing Suite content type
 * (Fizzy #1988).
 *
 * A generated draft ends with the assets it references but cannot vouch for —
 * a link that is not published yet, figures approved in principle but never
 * supplied, a screenshot nobody has cleared — and its own copy tells the reader
 * to confirm each one before the content goes out. There was nowhere to record
 * that they had. The list is written by the generation run, nothing carried it
 * back, so the same items reappeared on every regeneration and a person could
 * do the real-world work with no way to tell Fabric it had happened.
 *
 * Two halves, and both are needed for the loop to close:
 *
 *  - `settledAssetConfirmations` reads the answers a member has already given
 *    and hands them to `promoteConfirmedAssets`, which moves a cleared asset
 *    out of "needs confirmation". Without this half, answering changed nothing
 *    mechanical: the same model was asked the same thing and returned the same
 *    item on the same list.
 *  - `raiseAssetConfirmations` puts whatever is STILL unconfirmed into the
 *    place questions already live, so the next reader has something to answer
 *    rather than an instruction with no button.
 *
 * Both key on the asset's label, normalized the same way on both sides. The
 * asset is the same asset whichever draft names it, so the question is the
 * same question — `deriveQuestionId` hashes `(topicId, decisionKind, subject)`,
 * which is why a Case Study and a Webinar Script that both reference the
 * latency chart find ONE row rather than minting two.
 */

import {
	type DraftRaisedQuestion,
	raiseDraftQuestionsForTopic,
} from "@repo/database";
import { logger } from "@repo/logs";
import {
	ASSET_CONFIRMATION_ANSWERS,
	ASSET_RESTRICTING_KINDS,
	type AssetConfirmationScope,
	assetConfirmationScope,
} from "@repo/utils/publishing-asset-clamp";
import {
	type SettledDecisionThread,
	settledDecision,
} from "@repo/utils/publishing-restrictions";
import { deriveQuestionId } from "../publishing-planning/build-planning-analysis-prompt";

/**
 * The confirmations a member has settled, as `promoteConfirmedAssets` reads
 * them.
 *
 * Restricted to `ASSET_RESTRICTING_KINDS` — the same set the clamp demotes
 * against — so a settled question about framing or claim strength cannot clear
 * an asset. A settled answer that is not one of the offered options yields no
 * scope and is skipped: it still reaches the model in the settled-decisions
 * block, but it does not move anything.
 */
export function settledAssetConfirmations(
	threads: readonly SettledDecisionThread[],
): { label: string; scope: AssetConfirmationScope }[] {
	const out: { label: string; scope: AssetConfirmationScope }[] = [];
	for (const thread of threads) {
		if (!ASSET_RESTRICTING_KINDS.has(thread.root.decisionKind ?? "")) {
			continue;
		}
		const settled = settledDecision(thread);
		if (!settled?.subject) {
			continue;
		}
		const scope = assetConfirmationScope(settled.answer);
		if (scope) {
			out.push({ label: settled.subject, scope });
		}
	}
	return out;
}

/**
 * Assets a member has REFUSED, in the shape the clamp's `restricted` list takes.
 *
 * Closes the other half of the binary gap. The clamp only ever saw UNRESOLVED
 * threads, so a thread settled "no, do not use that screenshot" dropped out of
 * its input exactly as an approval did — and a model that claimed the asset as
 * confirmed kept that claim. The prompts ask for affirmative approval, but
 * nothing server-side enforced it, which made a denial the one answer that
 * changed nothing at all.
 *
 * Attributed to `ASSET_APPROVAL` because that is what the member answered, and
 * it is what the panel renders as the reason for the move.
 */
export function refusedAssetSubjects(
	threads: readonly SettledDecisionThread[],
): { kind: string; label: string }[] {
	return settledAssetConfirmations(threads)
		.filter((entry) => entry.scope === "NOT_APPROVED")
		.map((entry) => ({ kind: "ASSET_APPROVAL", label: entry.label }));
}

/**
 * The stable half of an asset entry, used as the question's subject.
 *
 * `needsConfirmation` entries are prose, not labels: their schema allows 300
 * characters where `confirmed` allows 200, precisely so an entry can say what
 * has to be confirmed. That explanation is MODEL-WRITTEN and rewritten on every
 * generation — and `deriveQuestionId` hashes the subject, so hashing the whole
 * sentence would mint a fresh question every run and pile duplicates onto a
 * topic instead of finding the row somebody already answered.
 *
 * So the subject is the text before the first separator — the asset itself —
 * with the explanation dropped. Capped at the 200 characters a confirmed label
 * is allowed, because past that it is not a label whatever it looks like.
 */
export function assetSubject(entry: string): string {
	const collapsed = entry.replace(/\s+/g, " ").trim();
	const [head] = collapsed.split(/\s+[—–-]\s+|:\s+/);
	return (head ?? collapsed).trim().slice(0, 200);
}

/**
 * Why an unconfirmed asset is worth a member's attention, in the words the
 * Summary & Questions tab shows under the question.
 */
function whyItMatters(label: string, contentTypeLabel: string): string {
	return `The ${contentTypeLabel} draft references ${label} but cannot confirm it. Until this is answered the draft keeps listing it as unconfirmed, and every regeneration asks again.`;
}

/**
 * The three answers offered, with the consequence of each spelled out.
 *
 * Fixed texts, because `assetConfirmationScope` reads the scope back by
 * matching them. The justification is display copy and free to change.
 */
function answerOptions(): { text: string; justification: string }[] {
	return [
		{
			text: ASSET_CONFIRMATION_ANSWERS.ANY_AUDIENCE,
			justification:
				"Every draft may present it as confirmed, in any format.",
		},
		{
			text: ASSET_CONFIRMATION_ANSWERS.INTERNAL_ONLY,
			justification:
				"Recorded, but no published format may present it as confirmed — every content type here leaves the company.",
		},
		{
			text: ASSET_CONFIRMATION_ANSWERS.NOT_APPROVED,
			justification:
				"Drafts keep writing around it rather than referencing it as available.",
		},
	];
}

/**
 * Raise a confirmation question for each asset this draft could not vouch for.
 *
 * Mint-if-absent and reactivate, never a sweep — see `raiseDraftQuestions`,
 * which explains why a draft run must not retract what another content type
 * raised.
 *
 * Failure is logged and swallowed. This runs AFTER the draft has been
 * committed: the draft is the deliverable, it is already on the page, and
 * throwing here would mark a finished generation failed over a question that
 * the next run will raise again anyway.
 */
export async function raiseAssetConfirmations(input: {
	topicId: string;
	projectId: string;
	organizationId: string | null;
	userId: string | null;
	postType: string;
	contentTypeLabel: string;
	assets: readonly string[];
}): Promise<void> {
	const seen = new Set<string>();
	const questions: DraftRaisedQuestion[] = [];
	for (const asset of input.assets) {
		const subject = assetSubject(asset);
		if (!subject || seen.has(subject.toLowerCase())) {
			continue;
		}
		seen.add(subject.toLowerCase());
		const question = `Is ${subject} confirmed for use?`;
		questions.push({
			questionId: deriveQuestionId({
				topicId: input.topicId,
				decisionKind: "ASSET_APPROVAL",
				subject,
				question,
			}),
			decisionKind: "ASSET_APPROVAL",
			subject,
			question,
			answerOptions: answerOptions(),
			whyItMatters: whyItMatters(subject, input.contentTypeLabel),
		});
	}
	if (questions.length === 0) {
		return;
	}

	try {
		const outcome = await raiseDraftQuestionsForTopic({
			topicId: input.topicId,
			projectId: input.projectId,
			organizationId: input.organizationId,
			userId: input.userId,
			postType: input.postType,
			questions,
		});
		if (outcome.minted > 0 || outcome.reactivated > 0) {
			logger.info(
				"[publishing] raised asset confirmations from a draft",
				{
					topicId: input.topicId,
					projectId: input.projectId,
					postType: input.postType,
					...outcome,
				},
			);
		}
	} catch (error) {
		logger.error("[publishing] could not raise asset confirmations", {
			topicId: input.topicId,
			projectId: input.projectId,
			postType: input.postType,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
