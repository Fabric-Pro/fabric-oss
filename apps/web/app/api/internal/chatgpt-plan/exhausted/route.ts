/**
 * An agent's ChatGPT plan refused a call as spent (Fizzy #2770 D1). Agents see
 * the refusal in their own process; this records it in the shared breaker
 * every web and worker process reads, so none of them sends that plan more
 * work until its window resets. With no reset time from OpenAI the breaker
 * estimates it, from the plan's anchored window for a shared account.
 *
 * Authenticated by the agent's AI token. The plan named must be one that token
 * may run on — the member's own, or one of the token's organization's shared
 * accounts; anything else is ignored. Answers 202 either way, so a caller
 * learns nothing about plans that are not its own.
 *
 * The key the exchange handed out also names the sign-in whose token the
 * agent used (Fizzy #3037), and the refusal is recorded only while the plan
 * still has that sign-in. A key without one, from an exchange before it named
 * them, is recorded against whatever sign-in the plan has now.
 */

import { SubscriptionPlanExhaustedError } from "@repo/agent-types/chatgpt-plan-fetch";
import {
	chatGptPlanExhaustedMessage,
	recordReportedChatGptPlanSourceExhausted,
} from "@repo/ai/lib/chatgpt-plan/exhaustion-breaker";
import {
	type ExchangedPlanSource,
	parseExchangedPlanSource,
} from "@repo/ai/lib/chatgpt-plan/plan-source-key";
import type { PlanSourceRef } from "@repo/ai/lib/chatgpt-plan/sources";
import { AI_TOKEN_HEADER, verifyAIToken } from "@repo/ai-token";
import { getChatGptPlanOrgAccount } from "@repo/database";
import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";

const bodySchema = z.object({
	/** The opaque key the exchange handed out with the plan's token. */
	planSource: z.string().min(1).max(160),
	resetAt: z.iso.datetime().optional(),
});

// One five-hour window. A report is the agent's word, not OpenAI's to this
// process: closing a plan longer than one window on it — a weekly reset, or a
// wrong one — would stop it for every member far longer than needed. If it is
// still spent then, its next call is refused again and says so itself.
const MAX_RESET_MS = 5 * 60 * 60_000;

function clampedResetAt(
	resetAt: string | undefined,
	now = Date.now(),
): Date | null {
	if (!resetAt) {
		return null;
	}
	return new Date(Math.min(new Date(resetAt).getTime(), now + MAX_RESET_MS));
}

/** The plan `planSource` names, when the token's member may run on it. */
async function ownedPlanSource(
	planSource: ExchangedPlanSource,
	claims: { sub: string; org?: string | null },
): Promise<PlanSourceRef | null> {
	const { kind, id } = planSource;
	if (kind === "user") {
		return id === claims.sub ? { kind: "user", userId: id } : null;
	}
	if (!claims.org) {
		return null;
	}
	const account = await getChatGptPlanOrgAccount({
		organizationId: claims.org,
		accountId: id,
	});
	return account
		? { kind: "org", organizationId: claims.org, accountId: account.id }
		: null;
}

export async function POST(request: Request) {
	const token = request.headers.get(AI_TOKEN_HEADER);
	if (!token) {
		return NextResponse.json(
			{ error: `Missing ${AI_TOKEN_HEADER} header` },
			{ status: 401 },
		);
	}
	const verified = await verifyAIToken(token);
	if (!verified.valid) {
		return NextResponse.json(
			{ error: verified.error, code: verified.code },
			{ status: 401 },
		);
	}
	const parsed = bodySchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		return NextResponse.json({ error: "Invalid body" }, { status: 400 });
	}

	const planSource = parseExchangedPlanSource(parsed.data.planSource);
	const source = planSource
		? await ownedPlanSource(planSource, verified.claims)
		: null;
	if (planSource && source) {
		const resetAt = clampedResetAt(parsed.data.resetAt);
		await recordReportedChatGptPlanSourceExhausted(
			source,
			new SubscriptionPlanExhaustedError(
				chatGptPlanExhaustedMessage(resetAt),
				resetAt,
			),
			planSource.credentialFingerprint,
		);
	}
	return NextResponse.json({ accepted: true }, { status: 202 });
}
