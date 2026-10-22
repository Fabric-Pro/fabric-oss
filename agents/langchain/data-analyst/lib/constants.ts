export const AVAILABLE_MODELS = [
	{
		id: "anthropic/claude-opus-5.5",
		name: "Claude Opus 5.5",
		provider: "anthropic",
	},
	{
		id: "anthropic/claude-sonnet-5.5",
		name: "Claude Sonnet 5.5",
		provider: "anthropic",
	},
	{
		id: "anthropic/claude-haiku-5.5",
		name: "Claude Haiku 5.5",
		provider: "anthropic",
	},
	{ id: "openai/gpt-4.1", name: "GPT-4.1", provider: "openai" },
	{ id: "openai/gpt-5.2", name: "GPT-5.2", provider: "openai" },
	{ id: "openai/gpt-4o", name: "GPT-4o", provider: "openai" },
	{ id: "openai/gpt-4o-mini", name: "GPT-4o Mini", provider: "openai" },
	{
		id: "anthropic/claude-opus-4-5-20251101",
		name: "Claude Opus 4.5",
		provider: "anthropic",
	},
	{
		id: "anthropic/claude-sonnet-5",
		name: "Claude Sonnet 5",
		provider: "anthropic",
	},
	{
		id: "anthropic/claude-sonnet-4-5-20250929",
		name: "Claude Sonnet 4.5",
		provider: "anthropic",
	},
	{
		id: "anthropic/claude-haiku-4-5-20251001",
		name: "Claude Haiku 4.5",
		provider: "anthropic",
	},
] as const;

// Matches the platform's default Fabric AI model (`DEFAULT_FABRIC_AI_MODEL` in
// packages/database/prisma/ai-model-catalog.ts); this standalone app cannot
// import it, so keep the two in step.
export const DEFAULT_MODEL = "anthropic/claude-sonnet-5.5";

/** Direct Anthropic IDs differ from the gateway's 5.5 IDs. */
export const DEFAULT_ANTHROPIC_MODEL_NAME = "claude-sonnet-5-5";

const ANTHROPIC_DIRECT_MODEL_IDS: Record<string, string> = {
	"anthropic/claude-opus-5.5": "claude-opus-5-5",
	"anthropic/claude-sonnet-5.5": "claude-sonnet-5-5",
	"anthropic/claude-haiku-5.5": "claude-haiku-5-5",
};

export function getAnthropicModelName(model?: string): string {
	if (!model) {
		return DEFAULT_ANTHROPIC_MODEL_NAME;
	}
	return (
		ANTHROPIC_DIRECT_MODEL_IDS[model] ?? model.replace(/^anthropic\//, "")
	);
}

export const AVAILABLE_FRAMEWORKS = [
	{ id: "ai-sdk", name: "Vercel AI SDK", description: "streamText with MCP" },
	{ id: "langchain", name: "LangChain", description: "MultiServerMCPClient" },
	{ id: "openai-agents", name: "OpenAI Agents", description: "AgentSDK" },
	{
		id: "claude-agents",
		name: "Claude Agents",
		description: "Anthropic SDK",
	},
] as const;

export const DEFAULT_FRAMEWORK = "ai-sdk";

export const STORAGE_KEYS = {
	model: "data-analyst-agent:chat:model",
	framework: "data-analyst-agent:chat:framework",
} as const;
