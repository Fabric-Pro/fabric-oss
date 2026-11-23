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

/**
 * A readable name for a model the catalog does not name, or not yet:
 * `gpt-6.1-terra` reads "GPT-6.1 Terra" and `claude-opus-5-5` "Claude Opus
 * 5.5". Words are capitalized, GPT keeps its version, and short number runs
 * become one version.
 */
export function readableModelName(name: string): string {
	const words: string[] = [];
	for (const part of name.split("-").filter(Boolean)) {
		const previous = words.at(-1);
		if (previous === "GPT" && /^\d/.test(part)) {
			words[words.length - 1] = `GPT-${part}`;
			continue;
		}
		if (previous && /\d$/.test(previous) && /^\d{1,2}$/.test(part)) {
			words[words.length - 1] = `${previous}.${part}`;
			continue;
		}
		words.push(
			part.toLowerCase() === "gpt"
				? "GPT"
				: `${part.charAt(0).toUpperCase()}${part.slice(1)}`,
		);
	}
	return words.join(" ") || name;
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
