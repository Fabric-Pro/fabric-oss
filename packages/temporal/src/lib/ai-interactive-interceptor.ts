/**
 * Carries "a person started this run" from a workflow's input into every AI
 * step of the run, so each of them may use that person's own ChatGPT plan
 * (Fizzy #2939) — the judge step after a document generation, a clarification
 * or compaction step in a chat turn, a child workflow — without threading
 * `planEligible` through every activity.
 *
 *  1. {@link makeAiInteractiveClientInterceptor} — on `client.workflow.start()`,
 *     stamps {@link TEMPORAL_AI_INTERACTIVE_HEADER} with the input's `userId`,
 *     but only when the starter set `planEligible: true` on the input. The
 *     explicit input field stays the one source of truth: no field, no header.
 *     Started while an admin impersonates the member, the run gets
 *     {@link TEMPORAL_AI_IMPERSONATED_HEADER} instead and its input's
 *     `planEligible` is cleared.
 *  2. `workflows/correlation-workflow-interceptor.ts` forwards the header onto
 *     every activity, child workflow and continue-as-new of the run.
 *  3. {@link AiInteractiveActivityInboundInterceptor} — re-enters
 *     `runWithAiInteractiveContext` for the activity body, so a model
 *     resolution there for that same user, with `planEligible` left unset,
 *     counts as interactive. An explicit `false`, or a call for anyone else,
 *     stays on the organization's provider.
 *
 * The header holds a user id only — never a token or key.
 */

import {
	aiImpersonatedUserId,
	runWithAiInteractiveContext,
} from "@repo/ai/lib/chatgpt-plan/interactive-context";
import type {
	Next as ClientNext,
	WorkflowClientInterceptor,
	WorkflowStartInput,
} from "@temporalio/client";
import {
	defaultPayloadConverter,
	type Headers as TemporalHeaders,
} from "@temporalio/common";
import type {
	ActivityExecuteInput,
	ActivityInboundCallsInterceptor,
	Next as ActivityNext,
} from "@temporalio/worker";

export const TEMPORAL_AI_INTERACTIVE_HEADER = "x-fabric-ai-interactive-user";
/**
 * Set instead, with the member's user id, on a run started while an admin
 * acts as them: every activity of the run then counts as impersonated, so no
 * model call there uses the member's plan and no AI token it mints may hand
 * the plan to an agent.
 */
export const TEMPORAL_AI_IMPERSONATED_HEADER = "x-fabric-ai-impersonated-user";

/** The starting user, when the workflow input is explicitly plan-eligible. */
function interactiveUserFromArgs(args: unknown[]): string | undefined {
	const first = args[0];
	if (!first || typeof first !== "object") {
		return undefined;
	}
	const { planEligible, userId } = first as {
		planEligible?: unknown;
		userId?: unknown;
	};
	return planEligible === true && typeof userId === "string" && userId
		? userId
		: undefined;
}

function decodeUserHeader(
	headers: TemporalHeaders | undefined,
	key: string,
): string | undefined {
	const payload = headers?.[key];
	if (!payload) {
		return undefined;
	}
	try {
		const decoded = defaultPayloadConverter.fromPayload(payload);
		return typeof decoded === "string" && decoded.length > 0
			? decoded
			: undefined;
	} catch {
		return undefined;
	}
}

/**
 * An admin acting as a member started this run: its activities pass the
 * input's `planEligible` straight to the model resolution in the worker, where
 * no request context exists to refuse it — so it is cleared at the start.
 */
function withoutPlanEligibility(input: WorkflowStartInput): WorkflowStartInput {
	const [first, ...rest] = input.options.args ?? [];
	if (!first || typeof first !== "object" || !("planEligible" in first)) {
		return input;
	}
	return {
		...input,
		options: {
			...input.options,
			args: [{ ...first, planEligible: false }, ...rest],
		},
	};
}

export function makeAiInteractiveClientInterceptor(): WorkflowClientInterceptor {
	return {
		async start(
			input: WorkflowStartInput,
			next: ClientNext<WorkflowClientInterceptor, "start">,
		) {
			const impersonatedUserId = aiImpersonatedUserId();
			if (impersonatedUserId) {
				const payload =
					defaultPayloadConverter.toPayload(impersonatedUserId);
				const cleared = withoutPlanEligibility(input);
				return next(
					payload
						? {
								...cleared,
								headers: {
									...cleared.headers,
									[TEMPORAL_AI_IMPERSONATED_HEADER]: payload,
								},
							}
						: cleared,
				);
			}
			const userId = interactiveUserFromArgs(input.options.args ?? []);
			const payload = userId
				? defaultPayloadConverter.toPayload(userId)
				: undefined;
			if (!payload) {
				return next(input);
			}
			return next({
				...input,
				headers: {
					...input.headers,
					[TEMPORAL_AI_INTERACTIVE_HEADER]: payload,
				},
			});
		},
	};
}

export class AiInteractiveActivityInboundInterceptor
	implements ActivityInboundCallsInterceptor
{
	async execute(
		input: ActivityExecuteInput,
		next: ActivityNext<ActivityInboundCallsInterceptor, "execute">,
	): Promise<unknown> {
		const impersonatedUserId = decodeUserHeader(
			input.headers,
			TEMPORAL_AI_IMPERSONATED_HEADER,
		);
		if (impersonatedUserId) {
			return runWithAiInteractiveContext(
				{ userId: impersonatedUserId, impersonated: true },
				() => next(input),
			);
		}
		const userId = decodeUserHeader(
			input.headers,
			TEMPORAL_AI_INTERACTIVE_HEADER,
		);
		if (!userId) {
			return next(input);
		}
		return runWithAiInteractiveContext({ userId }, () => next(input));
	}
}
