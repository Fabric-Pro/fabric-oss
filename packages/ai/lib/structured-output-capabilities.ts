import type { AIProvider } from "@repo/database";

export type StructuredOutputCapability = {
	mode: "strict" | "native" | "non-strict";
	namespaces: readonly { write: string; reads: readonly string[] }[];
	evidence: string;
};

const OPENAI = { write: "openai", reads: ["openai"] };
const GROQ = { write: "groq", reads: ["groq"] };
const CEREBRAS = {
	write: "cerebras",
	reads: ["openai-compatible", "openaiCompatible", "cerebras"],
};

/** These decisions describe the upstream selected by getModel, not SDK flag support.
 * Source references are local routing/incident evidence; unverified upstreams default off.
 */
const OPENAI_ROUTE: StructuredOutputCapability = {
	mode: "strict",
	namespaces: [OPENAI],
	evidence:
		"OpenAI Structured Outputs enforces strict JSON Schema; getModel/getOpenAIProviderWithKey defaults to api.openai.com, with OPENAI_BASE_URL overrides (including default/legacy providers); endpoint/model/schema rejections fall back at runtime",
};
const GATEWAY: StructuredOutputCapability = {
	mode: "non-strict",
	namespaces: [OPENAI, GROQ, CEREBRAS],
	evidence:
		"getModel routes through Vercel Gateway; sent openai/ names select strict conversion; status 400/422 schema/format/strict rejections are detected across gateway error causes and retried with the original schema, with endpoint-scoped one-hour rejection memory; other upstream enforcement unverified — live probe needed",
};

/** Explicit enum coverage is enforced by satisfies Record<AIProvider, ...>. */
export const STRUCTURED_OUTPUT_CAPABILITIES = {
	VERCEL_GATEWAY: GATEWAY,
	CLOUDFLARE_AI: GATEWAY,
	OPENROUTER: GATEWAY,
	AZURE_AI_FOUNDRY: {
		mode: "strict",
		namespaces: [OPENAI],
		evidence:
			"Azure OpenAI processed strict mode and rejected optional fields with 400 Invalid schema for response_format (Bug #1681, git f42cf1e9f); non-OpenAI Foundry deployments and keyword/model rejections use runtime fallback",
	},
	AWS_BEDROCK: OPENAI_ROUTE,
	GOOGLE_VERTEX_AI: OPENAI_ROUTE,
	DATABRICKS: {
		mode: "non-strict",
		namespaces: [OPENAI],
		evidence:
			"Databricks structured-output documentation reports anyOf unsupported (conversion emits anyOf); strict enforcement unverified — live probe needed; createOpenAI is only the client, not evidence of upstream enforcement; Claude forced-tool refusals use prompt steering",
	},
	OPENAI_DIRECT: OPENAI_ROUTE,
	ANTHROPIC_DIRECT: {
		mode: "native",
		namespaces: [],
		evidence:
			"Anthropic native structured outputs use output_config.format, rather than OpenAI strict mode; installed @ai-sdk/anthropic routes native output or tool fallback; local schema-limit middleware prompt-steers oversized schemas",
	},
	GROQ: {
		mode: "non-strict",
		namespaces: [GROQ],
		evidence:
			"getModel selects Groq upstream; model-specific strict schema enforcement unverified — live probe needed; client strictJsonSchema support does not establish upstream enforcement",
	},
	TOGETHER_AI: OPENAI_ROUTE,
	DEEPSEEK: {
		mode: "non-strict",
		namespaces: [],
		evidence:
			"getModel selects DeepSeek upstream; installed @ai-sdk/deepseek emits json_object without schema or strict flag (dist/index.js:761-769,1185-1193); no verified strict JSON Schema route",
	},
	COHERE: OPENAI_ROUTE,
	MISTRAL_AI: OPENAI_ROUTE,
	FIREWORKS: OPENAI_ROUTE,
	PERPLEXITY: OPENAI_ROUTE,
	XAI: OPENAI_ROUTE,
	CEREBRAS: {
		mode: "non-strict",
		namespaces: [CEREBRAS],
		evidence:
			"getModel selects Cerebras upstream; strict schema enforcement unverified — live probe needed; installed cerebras/openai-compatible client flag support does not establish upstream enforcement",
	},
	REPLICATE: OPENAI_ROUTE,
	HUGGINGFACE: OPENAI_ROUTE,
	HYBRID: OPENAI_ROUTE,
	CUSTOM: OPENAI_ROUTE,
	AZURE_OPENAI: OPENAI_ROUTE,
	NETLIFY: OPENAI_ROUTE,
	OPENAI_CHATGPT_PLAN: {
		mode: "non-strict",
		namespaces: [OPENAI],
		evidence:
			"ChatGPT plan upstream strict enforcement unverified — live probe needed; shared packages/agent-types/src/chatgpt-plan-fetch.ts relaxes strict for plan transport; SDK alone is not enforcement evidence",
	},
} satisfies Record<AIProvider, StructuredOutputCapability>;

export function structuredOutputCapabilityFor(
	resolvedProvider: string | undefined,
	viaGateway: boolean,
	modelName: string,
): StructuredOutputCapability {
	if (viaGateway) {
		return /^openai\//.test(modelName)
			? { ...GATEWAY, mode: "strict" }
			: GATEWAY;
	}
	if (
		resolvedProvider &&
		Object.hasOwn(STRUCTURED_OUTPUT_CAPABILITIES, resolvedProvider)
	) {
		return STRUCTURED_OUTPUT_CAPABILITIES[resolvedProvider as AIProvider];
	}
	return OPENAI_ROUTE;
}
