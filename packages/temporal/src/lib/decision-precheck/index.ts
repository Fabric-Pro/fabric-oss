/**
 * Async decision pre-check — the single, degradation-safe entry point.
 *
 * After an AI surface produces output, `runDecisionPrecheck` checks it against
 * the project's ACCEPTED/REJECTED architecture decisions and returns any
 * contradiction findings. It is strictly additive: the ENTIRE body is wrapped
 * in one try/catch that logs at `warn` and returns an empty "ok" result, so it
 * can never throw into — or slow down — the generation flow that calls it. This
 * function is THE degradation boundary; the callers just persist/render what it
 * returns.
 */

import type { DecisionPrecheckResult } from "@repo/agent-types";
import { logger } from "@repo/logs";
import { judgeDecisionContradictions } from "./judge";
import { selectCandidateDecisions } from "./select-candidates";

export interface RunDecisionPrecheckInput {
	projectId: string;
	userId: string;
	organizationId?: string;
	artifact: {
		surface: "backlog_proposal" | "document";
		/**
		 * For backlog: one entry per change, `ref.index` preserving the change's
		 * position in the proposal. For a document: a single entry.
		 */
		items: Array<{ ref?: { index: number; title?: string }; text: string }>;
	};
}

function emptyResult(): DecisionPrecheckResult {
	return { checkedAt: new Date().toISOString(), status: "ok", findings: [] };
}

export async function runDecisionPrecheck(
	input: RunDecisionPrecheckInput,
): Promise<DecisionPrecheckResult> {
	const { projectId, userId, organizationId, artifact } = input;
	try {
		const artifactText = artifact.items
			.map((item) => item.text)
			.join("\n\n");

		const candidates = await selectCandidateDecisions({
			projectId,
			artifactText,
		});
		if (candidates.length === 0) {
			return emptyResult();
		}

		const findings = await judgeDecisionContradictions({
			projectId,
			userId,
			organizationId,
			candidates,
			items: artifact.items,
		});

		return {
			checkedAt: new Date().toISOString(),
			status: findings.length > 0 ? "conflicts" : "ok",
			findings,
		};
	} catch (error) {
		logger.warn(
			"[Decision Pre-Check] run failed; proceeding without warnings",
			{
				projectId,
				surface: artifact.surface,
				reason: error instanceof Error ? error.message : String(error),
			},
		);
		return emptyResult();
	}
}

export {
	DECISION_PRECHECK_TIMEOUT_MS,
	type JudgeArtifactItem,
	type JudgeDecisionContradictionsInput,
	judgeDecisionContradictions,
} from "./judge";
export {
	type CandidateDecision,
	selectCandidateDecisions,
} from "./select-candidates";
export { DECISION_JUDGE_STATUS_SEMANTICS } from "./status-semantics";
