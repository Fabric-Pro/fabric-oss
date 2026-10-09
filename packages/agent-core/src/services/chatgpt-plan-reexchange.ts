/**
 * Another ChatGPT plan's token for an agent whose plan refused a call as
 * spent (Fizzy #2770).
 *
 * The exchange hands an agent a plan access token as its provider key, plus
 * the plan's opaque key (`planSource`). The agent's model only ever sees the
 * access token, so this process remembers, per token handed out, the AI token
 * and exchange URL it came from. When the plan refuses a call as spent before
 * any output, the model asks here once for a fresh exchange that skips that
 * plan. Nothing leaves the process: the AI token stays in memory, never in a
 * LangGraph config or checkpoint.
 *
 * Two more things follow a refusal (Fizzy #2770 D1/D2): the refused plan is
 * reported to Fabric, so every process stops sending it work until its window
 * resets, and the run's usage rows name the plan that actually served it — the
 * last one exchanged for the token the run started with.
 */

import {
	AI_TOKEN_HEADER,
	exchangeTokenForKey,
	invalidateCachedKey,
} from "@repo/ai-token";

const CHATGPT_PLAN_PROVIDER = "OPENAI_CHATGPT_PLAN";

interface PlanExchange {
	aiToken: string;
	fabricBaseUrl: string;
	/** Every plan this agent's run was handed and saw refuse, in order. */
	planSources: string[];
	/** The access token the run started with, before any re-exchange. */
	root: string;
	expiresAt: number;
}

const exchanges = new Map<string, PlanExchange>();
/** Per run (its first access token), the plan now serving it. */
const servingByRoot = new Map<
	string,
	{ planSource: string; expiresAt: number }
>();

function sweep(now: number): void {
	for (const [accessToken, exchange] of exchanges) {
		if (exchange.expiresAt <= now) {
			exchanges.delete(accessToken);
		}
	}
	for (const [root, serving] of servingByRoot) {
		if (serving.expiresAt <= now) {
			servingByRoot.delete(root);
		}
	}
}

/** Remembers where a plan access token came from, until it expires. */
export function rememberChatGptPlanExchange(params: {
	accessToken: string;
	aiToken: string;
	fabricBaseUrl: string;
	planSource: string;
	expiresInSeconds: number;
	/** Plans already ruled out for this run. */
	excluded?: string[];
	/** The run's first access token, when this one replaces it. */
	root?: string;
}): void {
	const now = Date.now();
	sweep(now);
	const root = params.root ?? params.accessToken;
	const expiresAt = now + params.expiresInSeconds * 1000;
	exchanges.set(params.accessToken, {
		aiToken: params.aiToken,
		fabricBaseUrl: params.fabricBaseUrl,
		planSources: [...(params.excluded ?? []), params.planSource],
		root,
		expiresAt,
	});
	servingByRoot.set(root, { planSource: params.planSource, expiresAt });
}

/**
 * The plan now serving the run that started with `accessToken` — after a
 * re-exchange, the plan swapped in, not the one handed out first. Null when
 * the token was not handed out here.
 */
export function servingChatGptPlanSource(accessToken: string): string | null {
	const serving = servingByRoot.get(accessToken);
	return serving && serving.expiresAt > Date.now()
		? serving.planSource
		: null;
}

/**
 * Tells Fabric the plan behind `accessToken` refused a call as spent, so every
 * process stops sending it work until its window resets, and drops this
 * process's cached exchange for the run's AI token, which would hand the
 * refused plan out again. Fire-and-forget: an older Fabric without the route
 * answers 404, which changes nothing.
 */
export function reportChatGptPlanExhausted(
	accessToken: string,
	resetAt: Date | null,
	fetchImpl: typeof fetch = fetch,
): void {
	const exchange = exchanges.get(accessToken);
	const planSource = exchange?.planSources.at(-1);
	if (!exchange || !planSource) {
		return;
	}
	void invalidateCachedKey(exchange.aiToken).catch(() => {});
	void fetchImpl(
		`${exchange.fabricBaseUrl}/api/internal/chatgpt-plan/exhausted`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				[AI_TOKEN_HEADER]: exchange.aiToken,
			},
			body: JSON.stringify({
				planSource,
				...(resetAt && { resetAt: resetAt.toISOString() }),
			}),
			signal: AbortSignal.timeout(10_000),
		},
	).catch(() => {});
}

/**
 * A token for another plan, skipping every plan this run already saw spent;
 * null when the access token was not handed out here, when no other plan
 * serves the work, or when the exchange fails.
 */
export async function reexchangeChatGptPlan(
	accessToken: string,
): Promise<string | null> {
	const exchange = exchanges.get(accessToken);
	if (!exchange || exchange.expiresAt <= Date.now()) {
		return null;
	}
	try {
		const next = await exchangeTokenForKey(exchange.aiToken, {
			fabricBaseUrl: exchange.fabricBaseUrl,
			excludeSources: exchange.planSources,
		});
		if (next.provider !== CHATGPT_PLAN_PROVIDER || !next.planSource) {
			return null;
		}
		rememberChatGptPlanExchange({
			accessToken: next.apiKey,
			aiToken: exchange.aiToken,
			fabricBaseUrl: exchange.fabricBaseUrl,
			planSource: next.planSource,
			expiresInSeconds: next.expiresIn,
			excluded: exchange.planSources,
			root: exchange.root,
		});
		return next.apiKey;
	} catch {
		return null;
	}
}

export function __resetChatGptPlanExchanges(): void {
	exchanges.clear();
	servingByRoot.clear();
}
