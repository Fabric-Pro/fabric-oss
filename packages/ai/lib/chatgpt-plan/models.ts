import {
	DEFAULT_CHATGPT_PLAN_FALLBACK_MODEL,
	getCachedChatGptPlanOrgPolicy,
	getModelForTask,
	getProviderModelIdForCanonical,
} from "@repo/database";
import { logger } from "@repo/logs";
import {
	chatGptPlanServedSlugs,
	refreshChatGptPlanServedModelsInBackground,
} from "./served-models";
import type { PlanSourceRef } from "./sources";

/**
 * Which ChatGPT plan model serves which kind of Fabric work (Fizzy #2939,
 * #2770).
 *
 * The plan's model catalog (`GET /v1/models` on the plan route, probed
 * 2026-10-06) lists gpt-6-astra "frontier intelligence for the most demanding
 * work", gpt-5.6-sol "older generation workhorse", gpt-5.6-terra "older
 * balanced model for straightforward work" and gpt-5.6-luna "older fast and
 * efficient"; plans now also serve the GPT-6 family. GPT-6.1 Sol serves
 * Fabric's work and GPT-6 Luna the light tasks: both use less of the plan's
 * window than Astra (defaults set 2026-10-08, to be tuned). Which model a call retries on when the plan
 * does not serve the chosen one is the organization's choice (Fizzy #2770
 * F10), Astra by default.
 */

/** The model every plan account serves. */
export const CHATGPT_PLAN_HEAVY_MODEL = "gpt-6-astra";

/**
 * The plan does not serve the model the work asked for, and no fallback could
 * stand in: none is set, it is the same model, or the plan refused it too.
 * Only an admin choosing another model fixes it, so Temporal does not retry it.
 */
export class ChatGptPlanModelNotServedError extends Error {
	constructor(readonly model: string) {
		super(
			`The ChatGPT plan does not serve ${model}. Choose another model in Organization settings → AI Models.`,
		);
		this.name = "ChatGptPlanModelNotServedError";
	}
}

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
	/** Unset: the model's own default reasoning level applies. */
	reasoningEffort?: ChatGptPlanReasoningEffort;
}

/**
 * The code default per task, used when no preference row and no seeded
 * default names a model. Keep in step with the OPENAI_CHATGPT_PLAN entries of
 * `TASK_DEFAULTS` in `@repo/database`'s model catalog. No reasoning effort:
 * each model's own default applies.
 */
export const CHATGPT_PLAN_TASK_DEFAULTS: Record<
	ChatGptPlanTaskType,
	ChatGptPlanModelChoice
> = {
	COMPLEX: { model: "gpt-6.1-sol" },
	REASONING: { model: "gpt-6.1-sol" },
	TOOL_CALLING: { model: "gpt-6.1-sol" },
	CHAT: { model: "gpt-6.1-sol" },
	EVAL: { model: "gpt-6.1-sol" },
	SIMPLE: { model: "gpt-6-luna" },
};

/**
 * The OpenAI API model each plan model is priced as when estimating what plan
 * usage would have cost on API billing. Only an estimate: the plan itself is
 * billed by OpenAI to the member, never to the organization.
 */
export const CHATGPT_PLAN_API_PRICE_REFERENCE: Record<string, string> = {
	"gpt-6-astra": "gpt-6-astra",
	"gpt-6.1-sol": "gpt-6.1-sol",
	"gpt-6-sol": "gpt-6-sol",
	"gpt-6-luna": "gpt-6-luna",
	"gpt-5.6-sol": "gpt-6-sol",
	// No API Terra exists; Sol, the next model up, keeps the estimate on the
	// high side rather than Astra's far higher price.
	"gpt-5.6-terra": "gpt-6-sol",
	"gpt-5.6-luna": "gpt-6-luna",
};

/**
 * The API model a plan model is priced as: the table above, else the known
 * plan model of the same family (a model the plan lists before the catalog
 * knows it, like `gpt-6.1-sol`), else Sol.
 */
export function chatGptPlanApiPriceReference(planModel: string): string {
	const known = CHATGPT_PLAN_API_PRICE_REFERENCE[planModel];
	if (known) {
		return known;
	}
	const family = planModel.split("-").at(-1);
	const sameFamily = Object.entries(CHATGPT_PLAN_API_PRICE_REFERENCE).find(
		([slug]) => slug.split("-").at(-1) === family,
	);
	return sameFamily?.[1] ?? "gpt-6-sol";
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

/** The plan slug of a chat's model choice, when the serving plan serves it. */
async function servedOverride(
	override: string | undefined,
	served: Set<string> | null,
): Promise<string | null> {
	if (!override || !served) {
		return null;
	}
	const slug =
		(await getProviderModelIdForCanonical(
			override,
			"OPENAI_CHATGPT_PLAN",
		).catch(() => null)) ?? override;
	if (served.has(slug)) {
		return slug;
	}
	logger.debug(
		"[chatgpt-plan] Ignoring a chat's model the plan does not serve",
		{
			override,
		},
	);
	return null;
}

/** The organization's fallback model; the default where it never chose. */
async function organizationFallbackModel(
	organizationId: string | undefined,
): Promise<string | null> {
	if (!organizationId) {
		return DEFAULT_CHATGPT_PLAN_FALLBACK_MODEL;
	}
	try {
		return (await getCachedChatGptPlanOrgPolicy(organizationId))
			.fallbackModel;
	} catch {
		return DEFAULT_CHATGPT_PLAN_FALLBACK_MODEL;
	}
}

/**
 * The plan model for one call (Fizzy #2770): the organization's choice for
 * the task, then the seeded default, then the code default. The organization
 * decides — for a member's own plan as for a shared account — and a member
 * who connects a plan agrees to it. A preference row that switches the task
 * off means "use the default" here: there is no organization provider for
 * the plan to fall back to.
 *
 * A model the serving plan no longer lists (its last `GET /v1/models`) goes
 * to the organization's fallback model; with no fallback the plan serves,
 * resolution fails with {@link ChatGptPlanModelNotServedError}. The fallback
 * also travels with the choice, for the one retry a live refusal gets.
 *
 * `override` is a person's choice for one chat (Fizzy #2770 F13), a catalog
 * model name. It wins only when the serving plan is known to serve it; a
 * stale, unknown or unserved choice is ignored, never an error.
 */
export async function resolveChatGptPlanModel(params: {
	userId: string;
	organizationId?: string;
	taskType: string;
	source?: PlanSourceRef;
	override?: string;
}): Promise<ChatGptPlanModelChoice & { fallbackModel: string | null }> {
	const source: PlanSourceRef = params.source ?? {
		kind: "user",
		userId: params.userId,
	};
	const fallback = defaultChatGptPlanModel(params.taskType);
	let model = fallback.model;
	if (isPlanTaskType(params.taskType)) {
		try {
			const resolved = await getModelForTask(
				params.userId,
				"OPENAI_CHATGPT_PLAN",
				params.taskType,
				params.organizationId,
			);
			model = resolved?.providerModelId ?? fallback.model;
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
	const [fallbackModel, served] = await Promise.all([
		organizationFallbackModel(params.organizationId),
		chatGptPlanServedSlugs(source),
	]);
	const chosen = await servedOverride(params.override, served);
	if (chosen) {
		// The chat picks the model, not how hard it thinks: the task's
		// reasoning effort stays.
		return {
			model: chosen,
			fallbackModel,
			...(fallback.reasoningEffort && {
				reasoningEffort: fallback.reasoningEffort,
			}),
		};
	}
	if (served && !served.has(model)) {
		if (
			!fallbackModel ||
			fallbackModel === model ||
			!served.has(fallbackModel)
		) {
			// The stored list may be stale; re-read it so the next call sees
			// what the plan serves now, without an admin opening AI Models.
			refreshChatGptPlanServedModelsInBackground(source);
			throw new ChatGptPlanModelNotServedError(model);
		}
		logger.warn(
			"[chatgpt-plan] The plan no longer lists the chosen model; using the fallback",
			{ model, fallback: fallbackModel },
		);
		model = fallbackModel;
	}
	return {
		model,
		fallbackModel,
		...(fallback.reasoningEffort && {
			reasoningEffort: fallback.reasoningEffort,
		}),
	};
}
