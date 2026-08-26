/**
 * AI Generate Text Step
 * Generates text using AI models via Vercel AI Gateway
 *
 * Features:
 * - Dynamic model selection from user/org AI provider settings
 * - Fabric AI enrichment (Strategy → Context → Pattern composition)
 * - Auto-detection of appropriate Fabric components from prompt
 *
 * Fabric AI Integration:
 * Node config can include:
 * - fabricStrategy: Reasoning methodology (cot, tot, reflexion)
 * - fabricContext: Identity/expertise (security_expert, senior_dev)
 * - fabricPattern: Task execution pattern (summarize, review_code)
 * - fabricAutoDetect: Enable auto-detection from prompt (default: true)
 */

import {
	generateText,
	getAIModelWithMetadata,
	logModelUsageAsync,
} from "@repo/ai";
import { computeMaxOutputTokenBudget } from "@repo/ai/lib/output-token-budget";
import type { NodeExecutionResult, StepParams } from "../../types";
import {
	applyFabricEnrichment,
	extractFabricConfig,
} from "./fabric-enrichment";
import { interpolateTemplate } from "./utils";

export async function executeAiGenerateTextStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const {
		aiPrompt,
		// Model can be explicitly set in workflow node config, or will use dynamic selection
		aiModel,
		systemPrompt,
	} = params.nodeConfig as {
		aiPrompt?: string;
		aiModel?: string;
		systemPrompt?: string;
	};

	if (!aiPrompt) {
		return { success: false, error: "Prompt is required" };
	}

	const interpolatedPrompt = interpolateTemplate(aiPrompt, params.inputs);

	try {
		// Use centralized single entry point for AI model access
		const { model, metadata, trackUsage } = await getAIModelWithMetadata(
			{ taskType: "SIMPLE" },
			{
				userId: params.userId,
				organizationId: params.organizationId,
				projectId: params.projectId,
				jobType: params.jobType,
			},
		);

		console.log("[ai-generate-text] Model selected:", {
			provider: metadata.provider,
			modelString: metadata.modelString,
			selectionSource: metadata.selectionSource,
		});

		// Track usage (fire-and-forget)
		trackUsage();

		// Apply Fabric AI enrichment to system prompt
		const fabricConfig = extractFabricConfig(params.nodeConfig);
		const enrichment = await applyFabricEnrichment(
			interpolatedPrompt,
			fabricConfig,
			systemPrompt,
		);

		console.log("[ai-generate-text] Fabric enrichment result:", {
			fabricUsed: enrichment.fabricUsed,
			components: enrichment.components,
			fallbackUsed: enrichment.fallbackUsed,
		});

		// The aiModel field in workflow config is now deprecated - we use the user's
		// configured default for the SIMPLE task type instead
		if (aiModel && aiModel !== metadata.modelString) {
			console.log(
				`[ai-generate-text] Workflow specified model "${aiModel}" but using configured default "${metadata.modelString}" ` +
					`for provider "${metadata.provider}". Configure model preferences in Settings → AI Models.`,
			);
		}

		console.log("[ai-generate-text] Calling generateText...");

		// Generic user-configured step (arbitrary prompt, no output contract) —
		// maximal mode. Without an explicit budget Databricks/Anthropic-direct cap
		// output at their injected defaults (8,192 / 4,096) and silently truncate.
		const maxOutputTokens = computeMaxOutputTokenBudget(metadata, {
			promptChars:
				(enrichment.systemPrompt?.length ?? 0) +
				interpolatedPrompt.length,
		});

		const generationStart = Date.now();
		const result = await generateText({
			model,
			prompt: interpolatedPrompt,
			system: enrichment.systemPrompt || undefined,
			...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
		});
		// User-configured workflow step: don't throw on a truncated result (the
		// user controls the prompt), but surface it loudly so the truncation is
		// diagnosable rather than a silently short output.
		if (result.finishReason === "length") {
			console.warn(
				"[ai-generate-text] Output truncated at the model's output-token limit",
				{
					provider: metadata.provider,
					modelString: metadata.modelString,
					maxOutputTokens,
					textLength: result.text.length,
				},
			);
		}
		logModelUsageAsync({
			context: {
				userId: params.userId,
				organizationId: params.organizationId,
			},
			metadata,
			taskType: "SIMPLE",
			usage: result.usage,
			latencyMs: Date.now() - generationStart,
		});

		console.log(
			"[ai-generate-text] generateText completed successfully, text length:",
			result.text.length,
		);

		return {
			success: true,
			output: {
				text: result.text,
				fabricEnrichment: enrichment.fabricUsed
					? enrichment.components
					: undefined,
			},
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : String(error);
		const errorStack = error instanceof Error ? error.stack : undefined;
		console.error("[ai-generate-text] Error details:", {
			error: errorMessage,
			stack: errorStack,
		});
		return {
			success: false,
			error: `AI request failed: ${errorMessage}`,
		};
	}
}
