import { SubscriptionPlanExhaustedError } from "@repo/agent-types/chatgpt-plan-fetch";
import {
	CHATGPT_PLAN_LABEL_SUFFIX,
	listChatGptPlanModels,
} from "@repo/database";
import { logger } from "@repo/logs";
import { APICallError, generateText } from "ai";
import { wrapModelWithUsageLogging } from "../usage-logging-middleware";
import {
	ChatGptPlanModelNotServedError,
	resolveChatGptPlanModel,
} from "./models";
import {
	CHATGPT_PLAN_RECONNECT_REQUIRED_MESSAGE,
	ChatGptPlanAuthError,
} from "./oauth";
import { createChatGptPlanModel } from "./provider";
import { type PlanSourceRef, planSourceLogFields } from "./sources";

/**
 * What one Test on a ChatGPT plan found (Fizzy #2770):
 * - `ok`: the plan answered, on `model`, in `latencyMs`;
 * - `needs_reconnect`: the sign-in is refused and only a new one helps;
 * - `spent`: the plan's usage window is spent until `resetAt`, if known;
 * - `error`: anything else, said in `message`.
 */
export type ChatGptPlanCheckResult =
	| {
			outcome: "ok";
			model: string;
			modelName: string;
			latencyMs: number;
	  }
	| { outcome: "needs_reconnect"; message: string }
	| { outcome: "spent"; resetAt: Date | null }
	| { outcome: "error"; message: string };

const CHECK_PROMPT = "Reply with the single word OK.";
const CHECK_TIMEOUT_MS = 30_000;
const MAX_MESSAGE_LENGTH = 300;

/** The error itself and whatever it wraps: SDK retry and fetch errors nest the cause. */
function* errorChain(error: unknown): Generator<unknown> {
	const seen = new Set<unknown>();
	const queue = [error];
	while (queue.length > 0) {
		const current = queue.shift();
		if (!current || seen.has(current)) {
			continue;
		}
		seen.add(current);
		yield current;
		if (typeof current === "object") {
			const bag = current as {
				cause?: unknown;
				lastError?: unknown;
				errors?: unknown;
			};
			queue.push(bag.cause, bag.lastError);
			if (Array.isArray(bag.errors)) {
				queue.push(...bag.errors);
			}
		}
	}
}

function findError<T>(
	error: unknown,
	type: abstract new (...args: never[]) => T,
): T | null {
	for (const link of errorChain(error)) {
		if (link instanceof type) {
			return link;
		}
	}
	return null;
}

const GENERIC_FAILURE = "The ChatGPT plan did not answer the test.";
const TIMED_OUT = "The ChatGPT plan did not answer in time.";

/**
 * How the test reads a failed call; see {@link ChatGptPlanCheckResult}. Only
 * the plan's own reasons reach the person: the provider's reply, a refused
 * sign-in, a model the plan does not serve. Anything else — a database or
 * network fault on Fabric's side — reads as the generic failure.
 */
function classifyChatGptPlanCheckError(
	error: unknown,
): Exclude<ChatGptPlanCheckResult, { outcome: "ok" }> {
	const spent = findError(error, SubscriptionPlanExhaustedError);
	if (spent) {
		return { outcome: "spent", resetAt: spent.resetAt };
	}
	const auth = findError(error, ChatGptPlanAuthError);
	if (auth) {
		return auth.reauthRequired && auth.code !== "not_connected"
			? { outcome: "needs_reconnect", message: auth.message }
			: { outcome: "error", message: auth.message };
	}
	const chain = [...errorChain(error)];
	if (
		chain.some(
			(link) =>
				link instanceof Error &&
				(link.name === "TimeoutError" || link.name === "AbortError"),
		)
	) {
		return { outcome: "error", message: TIMED_OUT };
	}
	const notServed = findError(error, ChatGptPlanModelNotServedError);
	if (notServed) {
		return { outcome: "error", message: notServed.message };
	}
	const refused = chain.find((link): link is APICallError =>
		APICallError.isInstance(link),
	);
	if (refused) {
		// A 401 even with a freshly refreshed token: the plan refuses the
		// sign-in itself. A real call does not mark the source for this, so
		// neither does the test.
		if (refused.statusCode === 401) {
			return {
				outcome: "needs_reconnect",
				message: CHATGPT_PLAN_RECONNECT_REQUIRED_MESSAGE,
			};
		}
		const text = refused.message.trim();
		return {
			outcome: "error",
			message: text ? text.slice(0, MAX_MESSAGE_LENGTH) : GENERIC_FAILURE,
		};
	}
	return { outcome: "error", message: GENERIC_FAILURE };
}

/** The model's catalog name without the plan label; the slug when unknown. */
async function planModelName(slug: string): Promise<string> {
	try {
		const model = (await listChatGptPlanModels()).find(
			(candidate) => candidate.slug === slug,
		);
		return model
			? model.displayName.replace(CHATGPT_PLAN_LABEL_SUFFIX, "")
			: slug;
	} catch {
		return slug;
	}
}

export interface ChatGptPlanCheckParams {
	/** The person running the test; their usage row records it. */
	userId: string;
	organizationId: string;
	source: PlanSourceRef;
}

/**
 * Sends one tiny request to exactly this plan, through the provider stack
 * every plan call uses: the access token looked up and refreshed when due (a
 * refused refresh marks the source NEEDS_RECONNECT), the exhaustion breaker
 * (a spent window is remembered, and an open breaker answers without a
 * request) and the request rules. No rotation: a spent plan reports itself
 * rather than handing the test to another one. The model is the plan's
 * choice for light work. No output cap: the plan route rejects one, so the
 * prompt asks for one word. The usage row is tagged `chatgpt-plan-test`.
 */
export async function testChatGptPlanSource({
	userId,
	organizationId,
	source,
}: ChatGptPlanCheckParams): Promise<ChatGptPlanCheckResult> {
	// The card refetches once the test answers, so the plan's reported usage
	// must be stored by then.
	const usageReports: Promise<void>[] = [];
	try {
		const choice = await resolveChatGptPlanModel({
			userId,
			organizationId,
			taskType: "SIMPLE",
			source,
		});
		let servedBy = choice.model;
		const usage = {
			userId,
			organizationId,
			providerConfigId:
				source.kind === "org" ? source.accountId : undefined,
			provider: "OPENAI_CHATGPT_PLAN" as const,
			providerModelId: choice.model,
			modelCanonicalName: choice.model,
			taskType: "SIMPLE" as const,
			billingCategory: "EXTERNAL_BYOK" as const,
			billingCustomerId: null,
			featureKey: "chatgpt-plan-test",
			costUsd: 0,
		};
		const model = wrapModelWithUsageLogging(
			createChatGptPlanModel({
				userId,
				source,
				onUsageReport: (write) => usageReports.push(write),
				modelId: choice.model,
				fallbackModelId: choice.fallbackModel,
				reasoningEffort: choice.reasoningEffort,
				onModelFallback: (modelId) => {
					servedBy = modelId;
					usage.providerModelId = modelId;
					usage.modelCanonicalName = modelId;
				},
			}),
			usage,
		);
		const started = Date.now();
		await generateText({
			model,
			prompt: CHECK_PROMPT,
			// A failed test is not worth paying for again.
			maxRetries: 0,
			abortSignal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
		});
		await Promise.all(usageReports);
		return {
			outcome: "ok",
			model: servedBy,
			modelName: await planModelName(servedBy),
			latencyMs: Date.now() - started,
		};
	} catch (error) {
		await Promise.all(usageReports);
		const result = classifyChatGptPlanCheckError(error);
		logger.info("[chatgpt-plan] Plan test failed", {
			...planSourceLogFields(source),
			outcome: result.outcome,
			error: error instanceof Error ? error.message : String(error),
		});
		return result;
	}
}
