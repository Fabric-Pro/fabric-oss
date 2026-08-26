/**
 * Assess Risks Node
 *
 * Evaluates risks for each decomposed task.
 */

import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { Command } from "@langchain/langgraph";
import { getRiskAssessmentPrompt } from "../prompts";
import type { TaskPlannerStateType } from "../state";
import type { RiskAnalysis } from "../types";
import { getAgentModelSync, type ProviderConfig, withRetry } from "../utils";

/**
 * Truncate threshold for user-visible error messages (PR 1090 review I-3).
 * Keeps the recommendation card readable while preserving the actionable
 * prefix of the error (provider error code + first line typically fits
 * well under 240 chars). Full stack stays in server logs above.
 */
const MAX_ERROR_CHARS = 240;

/** Unicode ellipsis sentinel used to indicate the error was truncated. */
const ELLIPSIS = "…";

/**
 * Redact common secret patterns before surfacing an error message to the
 * user (PR 1090 review I-2). Provider/gateway SDKs sometimes echo the
 * failing request — including `Authorization: Bearer ...` headers or
 * `api_key=...` query strings — inside their error bodies. Without
 * redaction, a misconfigured customer could see their own credential
 * reflected in the UI recommendation card or copied into a support
 * ticket.
 *
 * Patterns are intentionally broad (case-insensitive, multiple separator
 * variants) because the upstream error wording varies by provider and
 * SDK version. False positives are acceptable — replacing a literal token
 * with `[REDACTED]` in an error message degrades nothing.
 *
 * Exported for tests.
 */
function redactSecretsInError(input: string): string {
	return (
		input
			// `Authorization: Bearer <token>` and `bearer <token>` (case-insensitive)
			.replace(
				/\b(authorization|bearer)\s*[:=]?\s*[A-Za-z0-9._\-+/=]{8,}/gi,
				"$1 [REDACTED]",
			)
			// `api_key=...`, `api-key: ...`, `apiKey: "..."`, etc.
			.replace(
				/\b(api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|secret|password|token)\s*[:=]\s*["']?[A-Za-z0-9._\-+/=]{8,}["']?/gi,
				"$1: [REDACTED]",
			)
			// Bare OpenAI / Anthropic-style API key prefixes (loose — anything
			// that LOOKS like a key, even without a label, is worth scrubbing
			// from a user-visible string).
			.replace(/\bsk-[A-Za-z0-9._-]{20,}/g, "sk-[REDACTED]")
			.replace(/\bsk-ant-[A-Za-z0-9._-]{20,}/g, "sk-ant-[REDACTED]")
	);
}

/**
 * Assess Risks Node
 *
 * Stage 2: Evaluates risks for each task with severity scoring and mitigations.
 */
export async function assessRisksNode(
	state: TaskPlannerStateType,
	config?: RunnableConfig,
): Promise<Command> {
	console.log("[Task Planner] Stage 2: Assessing risks");

	try {
		// Extract provider config from runtime config
		let providerConfig: ProviderConfig | undefined;
		if (config?.configurable) {
			const configurable = config.configurable as Record<string, unknown>;
			if (configurable.ai_api_key && configurable.ai_model) {
				providerConfig = {
					apiKey: String(configurable.ai_api_key),
					model: String(configurable.ai_model),
					provider: configurable.ai_provider
						? String(configurable.ai_provider)
						: undefined,
					baseUrl: configurable.ai_gateway_url
						? String(configurable.ai_gateway_url)
						: undefined,
					// Canonical-derived reasoning signal (Bug #1942 review): gates
					// Databricks <think> stripping when the serving alias is opaque.
					isReasoningModel:
						typeof configurable.ai_is_reasoning === "boolean"
							? configurable.ai_is_reasoning
							: undefined,
				};
			}
		}

		const model = getAgentModelSync(providerConfig, { temperature: 0.2 });
		console.log(
			"[Task Planner] Using model:",
			providerConfig?.model || "groq/llama-3.3-70b-versatile (env)",
		);
		const systemPrompt = getRiskAssessmentPrompt();

		const userMessage = `Assess risks for these tasks:

${JSON.stringify(state.decomposedTasks, null, 2)}

Return a JSON object with "riskAnalysis" containing factors, mitigations, and recommendations.`;

		const response = await withRetry(async () => {
			return model.invoke([
				new SystemMessage(systemPrompt),
				new HumanMessage(userMessage),
			]);
		});

		const content = response.content?.toString() || "{}";
		const jsonMatch = content.match(/\{[\s\S]*\}/);
		const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

		const riskAnalysis: RiskAnalysis = parsed.riskAnalysis || {
			overallScore: 0,
			factors: [],
			mitigations: [],
			recommendations: [],
		};

		console.log("[Task Planner] Risk score:", riskAnalysis.overallScore);

		return new Command({
			goto: "build_dependencies",
			update: {
				riskAnalysis,
				currentStage: "Building dependency graph...",
			},
		});
	} catch (error) {
		console.error("[Task Planner] Risk assessment failed:", error);
		// Continue with empty risk analysis. We deliberately do NOT throw —
		// downstream stages (build_dependencies, generate_document) can still
		// produce a useful plan without risk analysis, and aborting the whole
		// graph here would deny the user any output at all when the optional
		// risk-LLM call hits a transient/config error.
		//
		// Surface the underlying error message in `recommendations[]` so the
		// user can see WHY risk analysis failed (rate limit? bad API key? JSON
		// parse?) instead of the historical cryptic "manual review recommended"
		// stub.
		//
		// Pipeline (order matters): raw → redact secrets → truncate. Redacting
		// FIRST means a long error containing a secret still gets redacted
		// before we slice — otherwise the secret could land in the kept prefix
		// and survive truncation. The full stack stays in server logs above.
		const rawErrorMessage =
			error instanceof Error ? error.message : String(error);
		const redacted = redactSecretsInError(rawErrorMessage);
		const truncated =
			redacted.length > MAX_ERROR_CHARS
				? `${redacted.slice(0, MAX_ERROR_CHARS)}${ELLIPSIS}`
				: redacted;
		return new Command({
			goto: "build_dependencies",
			update: {
				riskAnalysis: {
					overallScore: 0,
					factors: [],
					mitigations: [],
					recommendations: [
						`Risk assessment unavailable — manual review recommended. Reason: ${truncated}`,
					],
				},
			},
		});
	}
}
