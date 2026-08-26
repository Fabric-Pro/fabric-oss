/**
 * AI-powered PRD generation from backlog and project context.
 * Accepts a structured payload (backlog summary, codebase, website) and uses
 * AI to generate a Product Requirements Document. Replaces the mock generator
 * in Existing Project onboarding.
 */

import { getAIModelWithMetadata } from "@repo/ai";
import { computeMaxOutputTokenBudget } from "@repo/ai/lib/output-token-budget";
import { auth } from "@repo/auth";
import { logAiUsage } from "@repo/database";
import { AiUsageLimitExceededError } from "@repo/payments";
import { streamText } from "ai";
import { headers } from "next/headers";
import type { NextRequest } from "next/server";
import { after } from "next/server";
import { z } from "zod";

const SectionSchema = z.object({
	source: z.enum(["backlog", "codebase", "website"]),
	label: z.string(),
	priority: z.number(),
	highSignal: z.boolean(),
	content: z.unknown(),
});

const GeneratePrdRequestSchema = z.object({
	projectName: z.string(),
	sections: z.array(SectionSchema),
	hasBacklog: z.boolean(),
	hasCodebase: z.boolean(),
	hasWebsite: z.boolean(),
});

function buildPrdPrompt(
	payload: z.infer<typeof GeneratePrdRequestSchema>,
): string {
	const sources: string[] = [];
	if (payload.hasBacklog) {
		sources.push("backlog");
	}
	if (payload.hasCodebase) {
		sources.push("codebase");
	}
	if (payload.hasWebsite) {
		sources.push("website");
	}
	const sourcesLabel =
		sources.length > 0 ? sources.join(" + ") : "project context";

	let context = `Project: ${payload.projectName}\n\n`;
	for (const section of payload.sections) {
		context += `--- ${section.label} ---\n`;
		if (
			section.source === "backlog" &&
			typeof section.content === "object"
		) {
			const content = section.content as Record<string, unknown>;
			context += `Total items: ${content.totalCount ?? "N/A"}\n`;
			if (content.itemTypes && typeof content.itemTypes === "object") {
				context += `Item types: ${JSON.stringify(content.itemTypes)}\n`;
			}
			if (
				content.statusDistribution &&
				typeof content.statusDistribution === "object"
			) {
				context += `Status distribution: ${JSON.stringify(content.statusDistribution)}\n`;
			}
			if (
				Array.isArray(content.keyThemes) &&
				content.keyThemes.length > 0
			) {
				context += `Key themes: ${content.keyThemes.join(", ")}\n`;
			}
			if (
				Array.isArray(content.majorFeatures) &&
				content.majorFeatures.length > 0
			) {
				context += `Major features: ${content.majorFeatures.join(", ")}\n`;
			}
			if (
				Array.isArray(content.commonWorkflows) &&
				content.commonWorkflows.length > 0
			) {
				context += `Common workflows: ${content.commonWorkflows.join(", ")}\n`;
			}
			if (
				Array.isArray(content.notableGaps) &&
				content.notableGaps.length > 0
			) {
				context += `Notable gaps: ${content.notableGaps.join("; ")}\n`;
			}
			if (
				Array.isArray(content.recentItems) &&
				content.recentItems.length > 0
			) {
				context += "Recent items:\n";

				for (const item of content.recentItems.slice(0, 15) as Array<{
					title: string;
					type?: string;
					status?: string;
				}>) {
					context += `- ${item.title}${item.type ? ` (${item.type})` : ""}${item.status ? ` [${item.status}]` : ""}\n`;
				}
			}
		} else if (
			section.source === "codebase" &&
			typeof section.content === "object"
		) {
			const content = section.content as Record<string, unknown>;
			context += `Repository: ${content.repoUrl ?? "N/A"}\n`;
		} else if (
			section.source === "website" &&
			typeof section.content === "object"
		) {
			const content = section.content as Record<string, unknown>;
			context += `Primary URL: ${content.primaryUrl ?? "N/A"}\n`;
			if (
				Array.isArray(content.additionalUrls) &&
				content.additionalUrls.length > 0
			) {
				context += `Additional URLs: ${(content.additionalUrls as string[]).join(", ")}\n`;
			}
		}
		context += "\n";
	}

	return `Generate a Product Requirements Document (PRD) based on the following context. The output must be valid Markdown.

Use the backlog items as the primary source for product requirements. Infer themes, workflows, and features from the backlog. When backlog is present, prioritize it over other context. Be specific and actionable; avoid generic placeholders when the source data provides enough detail.

${context}

Generate a complete PRD with these sections (use Markdown):

1. **Overview** - Project name, brief description, status
2. **Problem Statement** - What problem does this product solve? (infer from backlog themes when possible)
3. **Goals and Non-Goals** - Clear goals and explicit non-goals
4. **User Personas** - Who are the users? (infer from backlog items when possible)
5. **Key Features** - Derived from backlog themes or major features
6. **Feature Scenarios** - At least 3–5 feature scenarios inferred from backlog items; describe each as "As a [persona], I want to [action] so that [benefit]"
7. **Functional Requirements** - Must Have and Nice to Have
8. **Non-Functional Requirements** - Performance, Security, Reliability (TBD where not inferable)
9. **Technical Architecture** - High-level notes (optional)
10. **Open Questions / Assumptions** - Based on notable gaps or uncertainties

Start with: # Product Requirements Document (PRD)
## [Project Name]

Include a brief note at the top: "AI-generated draft — review and edit before use. Generated from ${sourcesLabel}."

Do not include any meta-commentary or explanations outside the PRD itself. Output only the Markdown document.`;
}

export async function POST(req: NextRequest) {
	const startTime = Date.now();

	try {
		const headersList = await headers();
		const session = await auth.api.getSession({
			headers: headersList,
		});

		if (!session?.user) {
			return new Response(JSON.stringify({ error: "Unauthorized" }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			});
		}

		const body = await req.json();
		const validation = GeneratePrdRequestSchema.safeParse(body);

		if (!validation.success) {
			return new Response(
				JSON.stringify({
					error: "Invalid request",
					details: validation.error.issues,
				}),
				{
					status: 400,
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		const payload = validation.data;
		const userId = session.user.id;
		const organizationId =
			session.session.activeOrganizationId ?? undefined;

		const { model, metadata, trackUsage } = await getAIModelWithMetadata(
			{
				taskType: "COMPLEX",
				modelOverride: undefined,
			},
			{ userId, organizationId },
		);

		trackUsage();

		const prompt = buildPrdPrompt(payload);
		const system =
			"You are a product manager writing a PRD. Be concise and actionable. Infer from the backlog when possible; avoid generic filler when the data is specific. Use Markdown formatting. Output only the PRD document.";

		// Maximal mode: a whole PRD generated from a short structured payload —
		// output ≫ input. Without an explicit budget Databricks/Anthropic-direct
		// truncate the document at their injected defaults (8,192 / 4,096).
		// `undefined` for providers that don't need the workaround.
		const maxOutputTokens = computeMaxOutputTokenBudget(metadata, {
			promptChars: prompt.length + system.length,
		});

		const result = await streamText({
			model,
			prompt,
			system,
			...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
		});

		let fullText = "";
		for await (const textPart of result.textStream) {
			fullText += textPart;
		}

		const usage = await result.usage;
		const finishReason = await result.finishReason;
		const latencyMs = Date.now() - startTime;

		// Surface truncation for observability. The bytes already streamed cannot
		// be retracted (the HTTP contract is unchanged); a "length" finish means
		// the PRD was cut off at the output-token ceiling. Reflecting it in the UI
		// is a follow-up.
		if (finishReason === "length") {
			console.warn(
				"[AI Generate PRD] Output truncated at the model's output-token limit",
				{
					route: "/api/ai/generate-prd-from-backlog",
					promptChars: prompt.length,
					systemChars: system.length,
					maxOutputTokens,
				},
			);
		}

		after(() => {
			logAiUsage({
				userId,
				organizationId: organizationId ?? undefined,
				provider: metadata.provider,
				providerModelId: metadata.modelString,
				modelCanonicalName: metadata.canonicalName,
				billingCategory:
					metadata.billingMode === "included_credit"
						? "INCLUDED_CREDIT"
						: metadata.billingMode === "metered_stripe"
							? "STRIPE_METERED"
							: metadata.billingMode === "platform_unbilled"
								? "PLATFORM_UNBILLED"
								: "EXTERNAL_BYOK",
				billingCustomerId: metadata.billingCustomerId,
				taskType: "COMPLEX",
				inputTokens: usage.inputTokens ?? 0,
				outputTokens: usage.outputTokens ?? 0,
				totalTokens: usage.totalTokens ?? 0,
				latencyMs,
				success: true,
			}).catch((error) => {
				console.error("[AI Generate PRD] Failed to log usage:", error);
			});
		});

		return new Response(
			JSON.stringify({
				text: fullText,
				usage,
			}),
			{
				status: 200,
				headers: { "Content-Type": "application/json" },
			},
		);
	} catch (error: unknown) {
		const latencyMs = Date.now() - startTime;
		const errorMessage =
			error instanceof Error ? error.message : "Internal server error";

		// AI usage-limit chokepoint hit a HARD limit.
		// Surface the rich payload so the PRD-builder
		// client renders the shared destructive toast instead of falling
		// through to the generic 500 path.
		if (error instanceof AiUsageLimitExceededError) {
			return new Response(
				JSON.stringify({
					error: error.message,
					code: "AI_USAGE_LIMIT_EXCEEDED",
					data: {
						limitId: error.limitId,
						dimension: error.dimension,
						window: error.window,
						used: error.used.toString(),
						max: error.max.toString(),
						manageLimitsUrl: error.manageLimitsUrl,
					},
				}),
				{
					status: 429,
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		console.error("[AI Generate PRD] Error:", error);

		after(() => {
			logAiUsage({
				provider: "UNKNOWN" as any,
				providerModelId: "unknown",
				taskType: "COMPLEX",
				inputTokens: 0,
				outputTokens: 0,
				totalTokens: 0,
				latencyMs,
				success: false,
				errorMessage,
			}).catch(() => {});
		});

		return new Response(JSON.stringify({ error: errorMessage }), {
			status: 500,
			headers: { "Content-Type": "application/json" },
		});
	}
}

export const runtime = "nodejs";
