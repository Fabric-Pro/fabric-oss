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
import {
	askClarifyingQuestionAction,
	type ClarifyingQuestionFrequency,
	clarifyingQuestionPolicy,
} from "@repo/utils/editor-frontend-actions";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import {
	ClarifyingQuestionCard,
	normalizeClarifyingOptions,
} from "./ClarifyingQuestionCard";

// The built-in policy text and the action's definition are shared with the
// agent, which binds the same definition on a client Proposal's chat.
export { type ClarifyingQuestionFrequency, clarifyingQuestionPolicy };

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
	// The per-project, admin-editable frequency policy is embedded directly in
	// the tool description so it reliably reaches the model (the bound tool's
	// schema + description is always sent to the LLM).
	const action = askClarifyingQuestionAction(policy);
	useCopilotAction({
		name: action.name,
		description: action.description,
		parameters: action.parameters,
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
