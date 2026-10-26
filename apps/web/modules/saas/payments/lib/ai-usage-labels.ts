import { getProviderDisplayName } from "@saas/settings/lib/ai-providers";

export const CHATGPT_PLAN_PROVIDER = "OPENAI_CHATGPT_PLAN";

/**
 * Usage billed outside a provider's model catalog: Parlume's meeting bot is
 * recorded under the `CUSTOM` provider, and its speech models run on Workers
 * AI, which the `CLOUDFLARE_AI` provider's generic name does not say.
 */
const MODEL_LABELS: Record<string, { provider: string; model: string }> = {
	"attendee/teams-bot": { provider: "Attendee", model: "Teams meeting bot" },
	"@cf/deepgram/flux": {
		provider: "Workers AI",
		model: "Deepgram Flux transcription",
	},
	"@cf/deepgram/aura-2-en": {
		provider: "Workers AI",
		model: "Deepgram Aura speech",
	},
};

export function formatModel(raw: string | null | undefined): string {
	if (!raw) {
		return "—";
	}
	const slash = raw.lastIndexOf("/");
	return slash >= 0 ? raw.slice(slash + 1) : raw;
}

export function formatUsageProvider(row: {
	provider: string;
	providerModelId: string;
}): string {
	if (row.provider === CHATGPT_PLAN_PROVIDER) {
		return "ChatGPT plan";
	}
	return (
		MODEL_LABELS[row.providerModelId]?.provider ??
		getProviderDisplayName(row.provider)
	);
}

export function formatUsageModel(row: {
	modelCanonicalName: string | null;
	providerModelId: string;
}): string {
	return (
		MODEL_LABELS[row.providerModelId]?.model ??
		formatModel(row.modelCanonicalName ?? row.providerModelId)
	);
}
