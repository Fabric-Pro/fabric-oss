import { getModelForTask, getUserModelPreference } from "@repo/database";
import { logger } from "@repo/logs";
import { type PlanSourceRef, planSourceKey } from "./sources";

/**
 * Which ChatGPT plan model serves which kind of Fabric work (Fizzy #2939).
 *
 * The plan's model catalog describes its models only in words, with no tiers:
 * gpt-6-astra "frontier intelligence for the most demanding work",
 * gpt-5.6-sol "older generation workhorse", gpt-5.6-terra "older balanced
 * model for straightforward work", gpt-5.6-luna "older fast and efficient".
 * Heavy work goes to Astra; light work to the cheaper models, which use less of
 * the plan's window.
 */

/** The model every plan account serves; the fallback for any other choice. */
export const CHATGPT_PLAN_HEAVY_MODEL = "gpt-6-astra";

export type ChatGptPlanReasoningEffort = "low" | "medium" | "high";

/** The task types that can run on the plan: text work only. */
export type ChatGptPlanTaskType =
	| "SIMPLE"
	| "COMPLEX"
	| "REASONING"
	| "CHAT"
	| "TOOL_CALLING"
	| "EVAL";

export interface ChatGptPlanModelChoice {
	model: string;
	reasoningEffort: ChatGptPlanReasoningEffort;
}

/**
 * The code default per task, used when no preference row and no seeded
 * default names a model. Keep in step with the OPENAI_CHATGPT_PLAN entries of
 * `TASK_DEFAULTS` in `@repo/database`'s model catalog.
 */
export const CHATGPT_PLAN_TASK_DEFAULTS: Record<
	ChatGptPlanTaskType,
	ChatGptPlanModelChoice
> = {
	COMPLEX: { model: CHATGPT_PLAN_HEAVY_MODEL, reasoningEffort: "medium" },
	REASONING: { model: CHATGPT_PLAN_HEAVY_MODEL, reasoningEffort: "high" },
	// Agents and tool loops run many turns per request; low effort keeps each
	// turn cheap on the plan's window without giving up the strongest model.
	TOOL_CALLING: { model: CHATGPT_PLAN_HEAVY_MODEL, reasoningEffort: "low" },
	CHAT: { model: "gpt-5.6-sol", reasoningEffort: "low" },
	EVAL: { model: "gpt-5.6-terra", reasoningEffort: "low" },
	SIMPLE: { model: "gpt-5.6-luna", reasoningEffort: "low" },
};

/**
 * The OpenAI API model each plan model is priced as when estimating what plan
 * usage would have cost on API billing. Only an estimate: the plan itself is
 * billed by OpenAI to the member, never to the organization.
 */
export const CHATGPT_PLAN_API_PRICE_REFERENCE: Record<string, string> = {
	"gpt-6-astra": "gpt-6-astra",
	"gpt-5.6-sol": "gpt-6-sol",
	"gpt-5.6-terra": "gpt-6-sol",
	"gpt-5.6-luna": "gpt-6-luna",
};

export function chatGptPlanApiPriceReference(planModel: string): string {
	return (
		CHATGPT_PLAN_API_PRICE_REFERENCE[planModel] ??
		CHATGPT_PLAN_API_PRICE_REFERENCE[CHATGPT_PLAN_HEAVY_MODEL] ??
		CHATGPT_PLAN_HEAVY_MODEL
	);
}

function isPlanTaskType(taskType: string): taskType is ChatGptPlanTaskType {
	return Object.hasOwn(CHATGPT_PLAN_TASK_DEFAULTS, taskType);
}

export function defaultChatGptPlanModel(
	taskType: string,
): ChatGptPlanModelChoice {
	return isPlanTaskType(taskType)
		? CHATGPT_PLAN_TASK_DEFAULTS[taskType]
		: CHATGPT_PLAN_TASK_DEFAULTS.COMPLEX;
}

// Models a plan refused as unsupported (a Plus account cannot use every model
// a Pro account can), per plan source. Per process; the next resolution skips
// them.
const unsupportedBySource = new Map<string, Set<string>>();

export function recordChatGptPlanModelUnsupported(
	source: PlanSourceRef,
	model: string,
): void {
	const key = planSourceKey(source);
	const models = unsupportedBySource.get(key) ?? new Set<string>();
	models.add(model);
	unsupportedBySource.set(key, models);
}

export function __resetChatGptPlanModelMemory(): void {
	unsupportedBySource.clear();
}

/**
 * The plan model for one call. The member's own preference for the plan wins
 * — the plan is theirs, in whichever organization they work — then the
 * organization's preference, then the seeded default for the task, then the
 * code default. A preference row that switches the task off means "use the
 * default" here: there is no organization provider for the plan to fall back
 * to. A model the serving plan already refused is replaced by Astra.
 *
 * An organization's shared account (`source`, Fizzy #2770) is not the
 * member's plan, so their own preference does not apply to it.
 */
export async function resolveChatGptPlanModel(params: {
	userId: string;
	organizationId?: string;
	taskType: string;
	source?: PlanSourceRef;
}): Promise<ChatGptPlanModelChoice> {
	const source: PlanSourceRef = params.source ?? {
		kind: "user",
		userId: params.userId,
	};
	const fallback = defaultChatGptPlanModel(params.taskType);
	let model = fallback.model;
	if (isPlanTaskType(params.taskType)) {
		try {
			const own =
				source.kind === "user"
					? await getUserModelPreference(
							params.userId,
							params.taskType,
							"OPENAI_CHATGPT_PLAN",
						)
					: null;
			const ownModel = own?.model?.providerMappings?.[0]?.providerModelId;
			if (ownModel) {
				model = ownModel;
			} else {
				const resolved = await getModelForTask(
					params.userId,
					"OPENAI_CHATGPT_PLAN",
					params.taskType,
					params.organizationId,
				);
				model = resolved?.providerModelId ?? fallback.model;
			}
		} catch (error) {
			logger.warn(
				"[chatgpt-plan] Model preference lookup failed; using the default",
				{
					taskType: params.taskType,
					error:
						error instanceof Error ? error.message : String(error),
				},
			);
		}
	}
	if (unsupportedBySource.get(planSourceKey(source))?.has(model)) {
		model = CHATGPT_PLAN_HEAVY_MODEL;
	}
	return { model, reasoningEffort: fallback.reasoningEffort };
}
