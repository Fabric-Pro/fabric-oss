/**
 * LLM-judge for the decision pre-check.
 *
 * Given the produced artifact and a bounded candidate set, asks one model to
 * flag genuine contradictions, then normalizes/validates the raw output against
 * the candidates in code. The model output schema is deliberately LENIENT (no
 * `z.enum`, free-string conflictType, string-or-number confidence): the model
 * is untrusted, so every field is resolved/coerced against the candidate set
 * here rather than being enforced at parse time. On timeout or any error the
 * judge yields an empty finding list so the pre-check degrades silently.
 */

import type { DecisionConflictFinding } from "@repo/agent-types";
import {
	generateObject,
	getAIModelWithMetadata,
	logModelUsageAsync,
} from "@repo/ai";
import { logger } from "@repo/logs";
import { z } from "zod";
import type { CandidateDecision } from "./select-candidates";
import { DECISION_JUDGE_STATUS_SEMANTICS } from "./status-semantics";

/**
 * Default judge timeout. Generous because the whole pre-check is off the
 * request path (async, post-generation); a slow judge must never hold up
 * anything user-facing. Overridable via `DECISION_PRECHECK_TIMEOUT_MS` for
 * tuning without a redeploy.
 */
export const DECISION_PRECHECK_TIMEOUT_MS = 20_000;

function resolveTimeoutMs(): number {
	const raw = Number.parseInt(
		process.env.DECISION_PRECHECK_TIMEOUT_MS ?? "",
		10,
	);
	return Number.isFinite(raw) && raw > 0 ? raw : DECISION_PRECHECK_TIMEOUT_MS;
}

const MID_CONFIDENCE = 0.5;

/**
 * Prompt budget. The judge runs on a COMPLEX-tier model and the document
 * surface passes the ENTIRE saved document as one artifact item, so without a
 * ceiling a huge document (or a long decision body) sends unbounded input
 * tokens on every generation. Cap each decision body field, and the joined
 * artifact text overall. The ceilings sit well above normal document/decision
 * sizes — truncation clips only pathological inputs and never defeats
 * contradiction detection for typical content.
 */
const DECISION_FIELD_CHAR_CAP = 600;
const ARTIFACT_TEXT_CHAR_BUDGET = 24_000;

/** Keep the head of `text`, capped at `maxChars`, with a truncation marker. */
function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) {
		return text;
	}
	return `${text.slice(0, maxChars)}\n[… truncated …]`;
}

/**
 * Lenient model-output schema. Every field is permissive on purpose — the
 * hallucination guard, identifier/title resolution, conflictType mapping,
 * confidence coercion, and changeRef bounds-check all happen in code below.
 */
const DecisionJudgeOutputSchema = z
	.object({
		conflicts: z
			.array(
				z.object({
					decisionId: z.string(),
					decisionIdentifier: z.string().optional(),
					changeIndex: z.number().optional(),
					natureOfConflict: z.string(),
					conflictType: z.string().optional(),
					confidence: z.union([z.number(), z.string()]).optional(),
				}),
			)
			.default([]),
	})
	.default({ conflicts: [] });

type RawConflict = z.infer<
	typeof DecisionJudgeOutputSchema
>["conflicts"][number];

export interface JudgeArtifactItem {
	ref?: { index: number; title?: string };
	text: string;
}

export interface JudgeDecisionContradictionsInput {
	projectId: string;
	userId: string;
	organizationId?: string;
	candidates: CandidateDecision[];
	items: JudgeArtifactItem[];
}

type ConflictType = DecisionConflictFinding["conflictType"];

/** Resolve the model's free-string conflictType, falling back to the candidate status. */
function resolveConflictType(
	raw: string | undefined,
	status: string,
): ConflictType {
	const statusDerived: ConflictType =
		status === "REJECTED" ? "reintroduces_rejected" : "violates_accepted";
	if (!raw) {
		return statusDerived;
	}
	const normalized = raw.toLowerCase();
	if (normalized.includes("violat")) {
		return "violates_accepted";
	}
	if (normalized.includes("reintroduc")) {
		return "reintroduces_rejected";
	}
	return statusDerived;
}

/** Coerce string-or-number confidence to a number in [0, 1]; mid-default if unparseable. */
function coerceConfidence(raw: number | string | undefined): number {
	const value =
		typeof raw === "number"
			? raw
			: typeof raw === "string"
				? Number.parseFloat(raw)
				: Number.NaN;
	if (!Number.isFinite(value)) {
		return MID_CONFIDENCE;
	}
	return Math.min(1, Math.max(0, value));
}

/**
 * Map a model `changeIndex` (a position in the presented items list) to a
 * bounds-checked `changeRef`. The finding carries the item's real change index
 * and title. Returns `undefined` when the index is missing or out of range.
 */
function resolveChangeRef(
	changeIndex: number | undefined,
	items: JudgeArtifactItem[],
): DecisionConflictFinding["changeRef"] {
	if (
		typeof changeIndex !== "number" ||
		!Number.isInteger(changeIndex) ||
		changeIndex < 0 ||
		changeIndex >= items.length
	) {
		return undefined;
	}
	const item = items[changeIndex];
	const index = item.ref?.index ?? changeIndex;
	const title = item.ref?.title;
	return title ? { index, title } : { index };
}

/**
 * Normalize raw model conflicts against the candidate set:
 *  1. drop any whose `decisionId` is not a candidate (hallucination guard);
 *  2. resolve identifier/title from the candidate (never the model echo);
 *  3. map/derive conflictType from the candidate status;
 *  4. coerce + clamp confidence;
 *  5. attach a bounds-checked changeRef.
 */
function normalizeConflicts(
	rawConflicts: RawConflict[],
	candidates: CandidateDecision[],
	items: JudgeArtifactItem[],
): DecisionConflictFinding[] {
	const byId = new Map(candidates.map((c) => [c.id, c]));
	const findings: DecisionConflictFinding[] = [];
	for (const raw of rawConflicts) {
		const candidate = byId.get(raw.decisionId);
		if (!candidate) {
			continue;
		}
		const changeRef = resolveChangeRef(raw.changeIndex, items);
		findings.push({
			decisionId: candidate.id,
			decisionIdentifier: candidate.identifier,
			decisionTitle: candidate.title,
			natureOfConflict: raw.natureOfConflict,
			conflictType: resolveConflictType(
				raw.conflictType,
				candidate.status,
			),
			confidence: coerceConfidence(raw.confidence),
			...(changeRef ? { changeRef } : {}),
		});
	}
	return findings;
}

function buildJudgePrompt(
	candidates: CandidateDecision[],
	items: JudgeArtifactItem[],
): string {
	const decisionBlocks = candidates
		.map((candidate) => {
			const guidance =
				DECISION_JUDGE_STATUS_SEMANTICS[
					candidate.status as "ACCEPTED" | "REJECTED"
				] ?? candidate.status;
			const lines = [
				`Decision id: ${candidate.id}`,
				`Identifier: ${candidate.identifier}`,
				`Title: ${candidate.title}`,
				`Status: ${guidance}`,
			];
			if (candidate.domain) {
				lines.push(`Domain: ${candidate.domain}`);
			}
			const contextProblem = truncate(
				candidate.contextProblem.trim(),
				DECISION_FIELD_CHAR_CAP,
			);
			if (contextProblem) {
				lines.push(`Context / Problem: ${contextProblem}`);
			}
			const decision = truncate(
				candidate.decision.trim(),
				DECISION_FIELD_CHAR_CAP,
			);
			if (decision) {
				lines.push(`Decision: ${decision}`);
			}
			const rationale = truncate(
				candidate.rationale.trim(),
				DECISION_FIELD_CHAR_CAP,
			);
			if (rationale) {
				lines.push(`Rationale: ${rationale}`);
			}
			return lines.join("\n");
		})
		.join("\n\n---\n\n");

	// Bound the total artifact text (the document surface passes an entire
	// document as one item) so a huge input can't send unbounded tokens.
	const itemBlocks = truncate(
		items
			.map((item, position) => `Change ${position}:\n${item.text}`)
			.join("\n\n---\n\n"),
		ARTIFACT_TEXT_CHAR_BUDGET,
	);

	return [
		"You are reviewing AI-produced output against a project's logged architecture decisions.",
		"Each decision below is either ACCEPTED (a binding constraint) or REJECTED (an option ruled out and not to be reintroduced).",
		"Flag ONLY genuine contradictions: output that violates an ACCEPTED decision, or reintroduces a REJECTED option. Ignore output that merely relates to a decision without contradicting it.",
		"Never invent decisions. Reference a decision only by the exact `Decision id` shown below; if none contradicts, return an empty list.",
		"",
		"LOGGED DECISIONS:",
		decisionBlocks,
		"",
		"PRODUCED OUTPUT TO CHECK (numbered by change):",
		itemBlocks,
		"",
		'For each real contradiction return: decisionId (the exact id above), changeIndex (the "Change N" number it applies to), natureOfConflict (one concise sentence), conflictType ("violates_accepted" or "reintroduces_rejected"), confidence (0 to 1).',
	].join("\n");
}

function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	onTimeout?: () => void,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			// Signal the caller so it can abort the in-flight model call rather
			// than let it run to completion (wasting tokens) after we've already
			// given up on it.
			onTimeout?.();
			reject(
				new Error(`decision pre-check judge timed out after ${ms}ms`),
			);
		}, ms);
	});
	return Promise.race([promise, timeout]).finally(() => {
		if (timer) {
			clearTimeout(timer);
		}
	});
}

/**
 * Run the contradiction judge over the candidate set and return normalized
 * findings. Never throws: on model error or timeout it logs at `warn` and
 * returns `[]`.
 */
export async function judgeDecisionContradictions(
	input: JudgeDecisionContradictionsInput,
): Promise<DecisionConflictFinding[]> {
	const { projectId, userId, organizationId, candidates, items } = input;
	if (candidates.length === 0 || items.length === 0) {
		return [];
	}

	const startedAt = Date.now();
	try {
		const { model, metadata, trackUsage } = await getAIModelWithMetadata(
			{ taskType: "COMPLEX" },
			{ userId, organizationId },
		);

		// Abort the model call when the timeout fires so a slow judge stops
		// burning tokens the moment we stop waiting for it.
		const abortController = new AbortController();
		const result = await withTimeout(
			generateObject({
				model,
				schema: DecisionJudgeOutputSchema,
				prompt: buildJudgePrompt(candidates, items),
				// Optional fields make Azure/OpenAI reject a strict JSON schema
				// (Bug #1681); disable strict mode — the AI SDK still validates
				// the object against the Zod schema.
				providerOptions: { openai: { strictJsonSchema: false } },
				abortSignal: abortController.signal,
			}),
			resolveTimeoutMs(),
			() => abortController.abort(),
		);

		trackUsage();
		logModelUsageAsync({
			context: { userId, organizationId },
			metadata,
			taskType: "COMPLEX",
			usage: result.usage,
			latencyMs: Date.now() - startedAt,
			projectId,
		});

		return normalizeConflicts(result.object.conflicts, candidates, items);
	} catch (error) {
		logger.warn("[Decision Pre-Check] judge failed", {
			projectId,
			reason: error instanceof Error ? error.message : String(error),
		});
		return [];
	}
}
