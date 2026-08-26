/**
 * Intent-clarity activity for the Fabric Agent orchestrator.
 *
 * A lightweight LLM call that decides whether the user's request is ambiguous
 * enough to warrant ONE clarifying question before the orchestrator commits to
 * an (expensive) multi-agent plan. Mirrors the clarifying-question card used by
 * the document agents: returns a concise question + up to 3 short suggested
 * answers. Fail-safe — any error returns "no clarification" so the orchestration
 * is never blocked by the clarity check.
 *
 * Modeled on the lightweight LLM-call pattern in activities/weave/loom-routing.ts.
 */

import { logger } from "@repo/logs";

export interface AnalyzeIntentClarityInput {
	message: string;
	projectContext?: string;
	conversationSummary?: string;
	/** Required for model resolution (mirrors loom-routing). */
	userId: string;
	organizationId?: string;
}

export interface AnalyzeIntentClarityResult {
	needsClarification: boolean;
	question?: string;
	options?: string[];
	reasoning?: string;
}

const INTENT_CLARITY_PROMPT = `You are the intake reviewer for a multi-agent software-delivery assistant. Before the system commits to an expensive multi-step plan, decide whether the user's request is ambiguous in a way that would MATERIALLY change the work.

Ask a clarifying question ONLY when there is genuine, material ambiguity — an unclear target or scope, an unstated key decision, or multiple plausible interpretations that lead to very different work. If the request is clear enough to act on, DO NOT ask — let the system proceed.

When you ask, provide ONE concise question and up to 3 short, distinct suggested answers (the user can also type their own). Use calm, neutral language; never imply an answer is required or "best". Be conservative: when in doubt, do NOT ask.

Respond with JSON only:
{ "needsClarification": boolean, "question": "<one concise question; omit when false>", "options": ["<short>", "<short>", "<short>"], "reasoning": "<one short sentence>" }`;

/**
 * Decide whether to ask the user a single clarifying question before planning.
 * Never throws — returns { needsClarification: false } on any failure.
 */
export async function analyzeIntentClarityActivity(
	input: AnalyzeIntentClarityInput,
): Promise<AnalyzeIntentClarityResult> {
	const message = (input.message || "").trim();
	if (!message) {
		return { needsClarification: false, reasoning: "Empty message." };
	}

	try {
		const { generateText } = await import("ai");
		const { getAIModel } = await import("@repo/ai");

		const model = await getAIModel(
			{ taskType: "SIMPLE" },
			{ userId: input.userId, organizationId: input.organizationId },
		);

		const result = await generateText({
			model,
			system: INTENT_CLARITY_PROMPT,
			messages: [
				{
					role: "user",
					content: `## User request\n${message}${
						input.projectContext
							? `\n\n## Project context\n${input.projectContext.slice(0, 2000)}`
							: ""
					}${
						input.conversationSummary
							? `\n\n## Conversation so far\n${input.conversationSummary.slice(0, 2000)}`
							: ""
					}`,
				},
			],
			temperature: 0.1,
			maxOutputTokens: 400,
		});

		const jsonMatch = result.text.match(/\{[\s\S]*\}/);
		if (!jsonMatch) {
			return {
				needsClarification: false,
				reasoning: "No structured response.",
			};
		}

		const parsed = JSON.parse(jsonMatch[0]) as AnalyzeIntentClarityResult;
		if (!parsed.needsClarification) {
			return { needsClarification: false, reasoning: parsed.reasoning };
		}

		const question =
			typeof parsed.question === "string" ? parsed.question.trim() : "";
		if (!question) {
			return {
				needsClarification: false,
				reasoning: "Flagged ambiguous but produced no question.",
			};
		}

		const options = Array.isArray(parsed.options)
			? parsed.options
					.filter(
						(o): o is string =>
							typeof o === "string" && o.trim() !== "",
					)
					.map((o) => o.trim())
					.slice(0, 3)
			: [];

		return {
			needsClarification: true,
			question,
			options,
			reasoning: parsed.reasoning,
		};
	} catch (error) {
		// Never block the orchestration on a clarity-check failure — proceed.
		logger.warn(
			"[analyzeIntentClarity] failed; proceeding without clarification",
			{ error: error instanceof Error ? error.message : String(error) },
		);
		return {
			needsClarification: false,
			reasoning: "Clarity check failed.",
		};
	}
}
