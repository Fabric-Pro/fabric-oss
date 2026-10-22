import { parseExchangedPlanSource } from "@repo/ai/lib/chatgpt-plan/plan-source-key";
import {
	AI_FEATURE_KEYS,
	featureKeyForAgentId,
} from "@repo/ai/lib/feature-keys";
import { AI_TOKEN_HEADER, verifyAIToken } from "@repo/ai-token";
import {
	type AIProvider,
	getCanonicalNameForProviderModelId,
	getChatGptPlanOrgAccount,
	getModelByCanonicalName,
	getProjectAccessContext,
	logAiUsage,
} from "@repo/database";
import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveUsageFrame } from "../../agents/fabric-ai/resolve-usage-frame";

export const runtime = "nodejs";

const bodySchema = z.object({
	provider: z.string().min(1),
	model: z.string().min(1),
	taskType: z.string().min(1),
	agentId: z.string().optional(),
	conversationId: z.string().optional(),
	projectId: z.string().optional(),
	frameId: z.string().min(1).max(200).optional(),
	// Product-feature attribution (Fizzy #2230): lets out-of-process agent
	// runtimes tag their calls the same way in-process callers do.
	featureKey: z.enum(AI_FEATURE_KEYS).optional(),
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
	const planSource =
		params.provider === "OPENAI_CHATGPT_PLAN" && params.planSource
			? parseExchangedPlanSource(params.planSource)
			: null;
	const accountId = planSource?.kind === "org" ? planSource.id : undefined;
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

		const parsed = bodySchema.safeParse(await request.json());
		if (!parsed.success) {
			return NextResponse.json(
				{ error: "Invalid AI usage" },
				{ status: 400 },
			);
		}
		const body = parsed.data;

		// Drop unverified projectId (still log at user/org level) rather than
		// failing the request — prevents a misbehaving agent from mis-attributing
		// cost. Project access and the token's tenant must both match.
		let verifiedProjectId: string | undefined;
		if (body.projectId) {
			const accessContext = await getProjectAccessContext(
				body.projectId,
				verified.claims.sub,
			);
			if (
				accessContext &&
				(accessContext.organizationId ?? null) ===
					(verified.claims.org ?? null)
			) {
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

		let verifiedFrameId: string | undefined;
		if (body.frameId) {
			if (
				!verified.claims.org ||
				(body.projectId && !verifiedProjectId)
			) {
				return NextResponse.json(
					{ error: "Invalid usage origin" },
					{ status: 403 },
				);
			}
			const frame = await resolveUsageFrame({
				launchFrameId: body.frameId,
				userId: verified.claims.sub,
				organizationId: verified.claims.org,
				projectId: verifiedProjectId,
			});
			if (frame.error) {
				return frame.error;
			}
			verifiedFrameId = frame.usageFrameId;
		}

		// Provider IDs can differ from catalog names beyond a vendor prefix.
		const mappedCanonicalName = await getCanonicalNameForProviderModelId(
			body.model,
			body.provider as AIProvider,
		);
		const catalogModel = mappedCanonicalName
			? null
			: await getModelByCanonicalName(body.model);
		const modelCanonicalName =
			mappedCanonicalName ??
			catalogModel?.canonicalName ??
			body.model.split("/").pop() ??
			body.model;

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
			frameId: verifiedFrameId,
			provider: body.provider as any,
			providerConfigId,
			providerModelId: body.model,
			modelCanonicalName,
			taskType: body.taskType as any,
			agentId: body.agentId,
			conversationId: body.conversationId,
			featureKey: body.featureKey ?? featureKeyForAgentId(body.agentId),
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
