"use client";

/**
 * useClarifyingQuestions — wires the in-chat clarifying-question experience into
 * a CopilotKit surface (the AI Assistant sidebar). It does two things:
 *
 *  1. Registers the `ask_clarifying_question` frontend action. CopilotKit
 *     forwards frontend `useCopilotAction`s to the external LangGraph agent as
 *     callable tools (`convertActionsToDynamicStructuredTools`), so the agent
 *     can call it; `renderAndWaitForResponse` renders the ClarifyingQuestionCard
 *     inline and resolves the tool with the user's answer, which resumes the
 *     agent — the same proven mechanism as `select_meetings`/`confirm_changes`.
 *
 *  2. Delivers the project's clarifying-question frequency policy to the model.
 *     The policy is embedded in the tool's `description` (the reliable channel —
 *     a bound tool's schema + description is always sent to the model) and also
 *     published via `useCopilotReadable` as supplementary context. This is the
 *     "pushback agent" frequency knob — it makes MINIMAL genuinely ask less
 *     rather than just hiding questions.
 *
 * On answer the tool resolves `{ answered: true, answer, viaCustom }`; on
 * dismiss `{ answered: false, dismissed: true }` — the agent's prompt
 * (buildFollowUpInstructions) tells it to continue with the answer, or, on
 * dismissal, record the question under Open Questions and pause.
 */

import { useCopilotAction, useCopilotReadable } from "@copilotkit/react-core";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import {
	ClarifyingQuestionCard,
	normalizeClarifyingOptions,
} from "./ClarifyingQuestionCard";

export type ClarifyingQuestionFrequency = "MINIMAL" | "BALANCED" | "THOROUGH";

/**
 * The natural-language policy the agent receives (as readable context) telling
 * it how eagerly to ask clarifying questions. Pure + exported for unit tests.
 */
export function clarifyingQuestionPolicy(
	frequency: ClarifyingQuestionFrequency,
): string {
	switch (frequency) {
		case "MINIMAL":
			return [
				"Clarifying-question policy: MINIMAL.",
				"Avoid interrupting the user with questions. Make a reasonable assumption and proceed.",
				"Only call `ask_clarifying_question` when you genuinely cannot proceed without the user's input —",
				"at most one question, and only when it truly blocks progress.",
			].join(" ");
		case "THOROUGH":
			return [
				"Clarifying-question policy: THOROUGH.",
				"Proactively call `ask_clarifying_question` whenever additional detail would meaningfully improve the result.",
				"You may ask up to 3 focused questions per turn, one card at a time, each with up to 3 short suggested answers.",
			].join(" ");
		default:
			return [
				"Clarifying-question policy: BALANCED.",
				"Call `ask_clarifying_question` when there is material ambiguity that would change the output;",
				"otherwise proceed with a reasonable approach. At most one question per turn.",
			].join(" ");
	}
}

export interface UseClarifyingQuestionsOptions {
	/** Project's configured frequency tier. Defaults to BALANCED. */
	frequency?: ClarifyingQuestionFrequency;
	/** Active organization id (null in personal context) for tenant-scoped prompt resolution. */
	organizationId?: string | null;
}

export function useClarifyingQuestions({
	frequency = "BALANCED",
	organizationId = null,
}: UseClarifyingQuestionsOptions = {}): void {
	// Resolve the editable, admin-tunable frequency policy from the Prompt
	// Library (the `clarifying_questions` prompt for this tier). Falls back to
	// the built-in default when no prompt is seeded/edited. Auth-gated query (no
	// PROMPT_READ requirement) so it works for every user with project access.
	const { data: policyData } = useQuery({
		...orpc.prompts.agents.clarifyingPolicy.queryOptions({
			input: { frequency, organizationId },
		}),
		staleTime: 5 * 60 * 1000,
		retry: false,
	});
	const policy =
		policyData?.policy?.trim() || clarifyingQuestionPolicy(frequency);

	// Supplementary signal: also surface the frequency policy as readable
	// context (the primary delivery is the tool description below).
	useCopilotReadable({
		description:
			"Clarifying-question frequency policy for this project. It controls how often you should ask the user clarifying questions via the ask_clarifying_question tool.",
		value: policy,
	});

	// The interactive card the agent renders when it asks a clarifying question.
	useCopilotAction({
		name: "ask_clarifying_question",
		description:
			"Use this tool to ask the user a single clarifying or follow-up question and wait " +
			"for their answer. ALWAYS call this tool to ask a clarifying question — never write " +
			"the question as plain text. Provide a concise question and up to 3 short, distinct " +
			"suggested answers in `options` (the user can also type their own answer). The tool " +
			"returns the user's answer; continue using it. If the result indicates the user " +
			"dismissed it (answered: false), record the question under an Open Questions section " +
			"and pause instead of guessing. " +
			// The per-project, admin-editable frequency policy is embedded directly
			// in the tool description so it reliably reaches the model (the bound
			// tool's schema + description is always sent to the LLM).
			`${policy} ` +
			"Use calm, neutral language — never imply an answer is required or 'best'.",
		parameters: [
			{
				name: "question",
				type: "string",
				description:
					"The clarifying question to ask the user (one sentence).",
				required: true,
			},
			{
				name: "options",
				type: "string[]",
				description:
					"Up to 3 short, distinct suggested answers the user can click. Keep each concise and parallel in form.",
				required: false,
			},
			{
				name: "allowCustom",
				type: "boolean",
				description:
					"Whether to offer a free-text 'type your own answer' field. Defaults to true; leave unset.",
				required: false,
			},
		],
		renderAndWaitForResponse: ({ args, respond, status, result }) => {
			const question =
				typeof args.question === "string" && args.question.trim()
					? args.question.trim()
					: "Could you clarify how you'd like me to proceed?";

			// Already resolved (post-answer re-render or history replay): show a
			// compact summary of the user's choice instead of the interactive
			// card. CopilotKit re-invokes this with status "complete" and the
			// resolved value in `result`, so read it rather than dropping the
			// outcome.
			if (status === "complete") {
				const resolved = result as
					| { answered?: boolean; answer?: string }
					| undefined;
				if (resolved?.answered === true && resolved.answer) {
					return (
						<div className="rounded-lg border border-border bg-muted/30 p-3 text-sm text-foreground">
							<span className="text-muted-foreground">
								Answered:
							</span>{" "}
							{resolved.answer}
						</div>
					);
				}
				if (resolved?.answered === false) {
					return (
						<div className="rounded-lg border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
							Question skipped — noted as an open item for review.
						</div>
					);
				}
				return (
					<div className="rounded-lg border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
						{question}
					</div>
				);
			}

			return (
				<ClarifyingQuestionCard
					question={question}
					options={normalizeClarifyingOptions(args.options)}
					allowCustom={args.allowCustom !== false}
					onAnswer={({ answer, viaCustom }) =>
						respond?.({ answered: true, answer, viaCustom })
					}
					onDismiss={() =>
						respond?.({ answered: false, dismissed: true })
					}
				/>
			);
		},
	});
}
