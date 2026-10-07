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
 */

import { exchangeTokenForKey } from "@repo/ai-token";

const CHATGPT_PLAN_PROVIDER = "OPENAI_CHATGPT_PLAN";

interface PlanExchange {
	aiToken: string;
	fabricBaseUrl: string;
	/** Every plan this agent's run was handed and saw refuse, in order. */
	planSources: string[];
	expiresAt: number;
}

const exchanges = new Map<string, PlanExchange>();

function sweep(now: number): void {
	for (const [accessToken, exchange] of exchanges) {
		if (exchange.expiresAt <= now) {
			exchanges.delete(accessToken);
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
}): void {
	const now = Date.now();
	sweep(now);
	exchanges.set(params.accessToken, {
		aiToken: params.aiToken,
		fabricBaseUrl: params.fabricBaseUrl,
		planSources: [...(params.excluded ?? []), params.planSource],
		expiresAt: now + params.expiresInSeconds * 1000,
	});
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
		});
		return next.apiKey;
	} catch {
		return null;
	}
}

export function __resetChatGptPlanExchanges(): void {
	exchanges.clear();
}
