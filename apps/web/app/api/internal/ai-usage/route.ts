import { AI_TOKEN_HEADER, verifyAIToken } from "@repo/ai-token";
import {
	getChatGptPlanOrgAccount,
	hasProjectAccess,
	logAiUsage,
} from "@repo/database";
import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";

const bodySchema = z.object({
	provider: z.string().min(1),
	model: z.string().min(1),
	taskType: z.string().min(1),
	agentId: z.string().optional(),
	conversationId: z.string().optional(),
	projectId: z.string().optional(),
	// Product-feature attribution (Fizzy #2230): lets out-of-process agent
	// runtimes tag their calls the same way in-process callers do.
	featureKey: z.string().max(64).optional(),
	promptVersionId: z.string().max(64).optional(),
	latencyMs: z.number().int().nonnegative().default(0),
	inputTokens: z.number().int().nonnegative(),
	outputTokens: z.number().int().nonnegative(),
	totalTokens: z.number().int().nonnegative(),
	cachedInputTokens: z.number().int().nonnegative().optional(),
	cacheCreationInputTokens: z.number().int().nonnegative().optional(),
	reasoningTokens: z.number().int().nonnegative().optional(),
	// Vercel-gateway generation id, if the agent's response exposed it. Lets these
	// out-of-process rows reconcile to the provider's actual cost via the same
	// sweep as in-process gateway calls (they're written costIsActual=false).
	gatewayGenerationId: z.string().optional(),
	billingMode: z.string().optional(),
	billingCustomerId: z.string().optional(),
	// The ChatGPT plan that served the call, by its opaque key (Fizzy #2770).
	planSource: z.string().max(160).optional(),
});

const ORG_PLAN_SOURCE = /^org:([\w-]{1,128})$/;

/**
 * The shared ChatGPT plan account a plan call ran on, as its usage row's
 * `providerConfigId` — only when the account is the token's own
 * organization's. Anything else, a member's own plan included, records none.
 */
async function sharedPlanAccountId(params: {
	provider: string;
	planSource: string | undefined;
	organizationId: string | null | undefined;
}): Promise<string | undefined> {
	const accountId =
		params.provider === "OPENAI_CHATGPT_PLAN"
			? params.planSource?.match(ORG_PLAN_SOURCE)?.[1]
			: undefined;
	if (!accountId || !params.organizationId) {
		return undefined;
	}
	const account = await getChatGptPlanOrgAccount({
		organizationId: params.organizationId,
		accountId,
	});
	return account?.id;
}

function mapBillingCategory(
	billingMode?: string,
):
	| "INCLUDED_CREDIT"
	| "STRIPE_METERED"
	| "PLATFORM_UNBILLED"
	| "EXTERNAL_BYOK" {
	switch (billingMode) {
		case "included_credit":
			return "INCLUDED_CREDIT";
		case "metered_stripe":
			return "STRIPE_METERED";
		case "platform_unbilled":
			return "PLATFORM_UNBILLED";
		default:
			return "EXTERNAL_BYOK";
	}
}

export async function POST(request: Request) {
	try {
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

		const body = bodySchema.parse(await request.json());

		// Drop unverified projectId (still log at user/org level) rather than
		// failing the request — prevents a misbehaving agent from mis-attributing
		// cost. hasProjectAccess covers owners, org members, and project collaborators.
		let verifiedProjectId: string | undefined;
		if (body.projectId) {
			const allowed = await hasProjectAccess(
				body.projectId,
				verified.claims.sub,
				verified.claims.org ?? undefined,
			);
			if (allowed) {
				verifiedProjectId = body.projectId;
			} else {
				console.warn(
					"[Internal AI Usage] Dropping unverified projectId from usage log",
					{
						projectId: body.projectId,
						userId: verified.claims.sub,
						organizationId: verified.claims.org ?? null,
					},
				);
			}
		}

		// Strip provider prefix ("anthropic/claude-haiku-4.5" → "claude-haiku-4.5")
		// so canonicalName matches what Temporal-originated rows already store
		// and the dashboard shows a consistent short name.
		const modelCanonicalName = body.model.includes("/")
			? (body.model.split("/").pop() ?? body.model)
			: body.model;

		const providerConfigId = await sharedPlanAccountId({
			provider: body.provider,
			planSource: body.planSource,
			organizationId: verified.claims.org,
		});

		// AI usage limits: post-record overage detection + notification fan-out runs
		// inside logAiUsage (see packages/database/prisma/queries/ai-models.ts).
		// This route inherits the post-record path automatically; it cannot pre-check
		// because the AI call already happened externally (/).
		await logAiUsage({
			userId: verified.claims.sub,
			organizationId: verified.claims.org,
			projectId: verifiedProjectId,
			provider: body.provider as any,
			providerConfigId,
			providerModelId: body.model,
			modelCanonicalName,
			taskType: body.taskType as any,
			agentId: body.agentId,
			conversationId: body.conversationId,
			featureKey: body.featureKey,
			promptVersionId: body.promptVersionId,
			inputTokens: body.inputTokens,
			outputTokens: body.outputTokens,
			totalTokens: body.totalTokens,
			cachedInputTokens: body.cachedInputTokens,
			cacheCreationInputTokens: body.cacheCreationInputTokens,
			reasoningTokens: body.reasoningTokens,
			gatewayGenerationId: body.gatewayGenerationId,
			latencyMs: body.latencyMs,
			billingCategory: mapBillingCategory(body.billingMode),
			billingCustomerId: body.billingCustomerId,
			// A ChatGPT plan carries no API cost (Fizzy #2939).
			...(body.provider === "OPENAI_CHATGPT_PLAN" && { costUsd: 0 }),
			success: true,
		});

		return NextResponse.json({ ok: true });
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Failed to log AI usage";
		console.error("[Internal AI Usage] Error:", error);
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
