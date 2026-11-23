import { answerModelInfoSchema } from "@repo/ai/lib/answer-model-info";
import { runtimeCustomEventName } from "@saas/agents/lib/runtime-custom-events";
import { DECLINED_RUN_ERROR_CODE } from "@saas/shared/components/copilot/ag-ui-run-error";
import { z } from "zod";

/**
 * Create Plan's "Refine request with AI" over the agent runtime: what the
 * `weave-refine` engine (`modules/saas/agents/runtime/weave-refine-engine.ts`)
 * and the form (`useWeaveRefinement`) agree on.
 *
 * - The run's messages are the exchanges so far; the last one is the
 *   refinement input.
 * - `forwardedProps` names the project and the request being refined
 *   (`weaveRefinePropsSchema`); the runtime request names the organization.
 * - The feedback streams as one assistant text message.
 * - The improved request and whether it is ready arrive as CUSTOM
 *   `fabric.weave-refine.result`, after the text ends and before
 *   RUN_FINISHED.
 * - Nothing is saved: each send is its own thread.
 */

export const WEAVE_REFINE_AGENT_ID = "weave-refine";

export const weaveRefinePropsSchema = z.object({
	projectId: z.string().min(1).max(200),
	currentMessage: z.string().min(1),
});
export type WeaveRefineProps = z.infer<typeof weaveRefinePropsSchema>;

export const WEAVE_REFINE_EVENT = {
	result: runtimeCustomEventName(WEAVE_REFINE_AGENT_ID, "result"),
} as const;

/**
 * The RUN_ERROR code of a refinement the model declined (a content filter
 * or safety refusal), told apart from a failure: the request is unchanged
 * because the model would not refine it, not because something broke.
 */
export const WEAVE_REFINE_DECLINED = DECLINED_RUN_ERROR_CODE;

/** The value of `WEAVE_REFINE_EVENT.result`. */
export const weaveRefineResultEventSchema = z.object({
	updatedMessage: z.string(),
	isReady: z.boolean(),
	model: answerModelInfoSchema.optional().catch(undefined),
});
