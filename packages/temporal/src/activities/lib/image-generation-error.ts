import { DatabricksOAuthError } from "@repo/ai/lib/databricks-oauth";
import { RetryError } from "ai";

export type ImageGenerationProvider =
	| "gateway"
	| "openai"
	| "fal"
	| "gemini"
	| "local";

const PROVIDER_NAMES: Record<ImageGenerationProvider, string> = {
	gateway: "Vercel AI Gateway",
	openai: "OpenAI",
	fal: "FAL",
	gemini: "Gemini",
	local: "Local image server",
};

/** Only structured status fields select public copy; exception text stays in server logs. */
export function imageGenerationErrorMessage(
	error: unknown,
	provider: ImageGenerationProvider,
): string {
	const name = PROVIDER_NAMES[provider];
	const seen = new Set<object>();
	let current = error;
	while (
		typeof current === "object" &&
		current !== null &&
		!seen.has(current)
	) {
		seen.add(current);
		// Both generateImage and generateText can exhaust SDK retries. The
		// wrapper's message embeds provider text; lastError retains the status.
		if (RetryError.isInstance(current)) {
			current = current.lastError;
			continue;
		}
		// APICallError and gateway errors use statusCode; Google GenAI uses
		// status. Do not inspect response bodies, messages, or request data.
		const status =
			"statusCode" in current
				? current.statusCode
				: "status" in current
					? current.status
					: undefined;
		switch (status) {
			case 401:
			case 403:
				return `${name} rejected the organization's credentials. Check Settings → AI Providers.`;
			case 429:
				return `${name} rate limit or quota reached. Try again later.`;
			case 400:
				return `${name} refused this request. Rephrase the prompt.`;
		}
		current = "cause" in current ? current.cause : undefined;
	}
	return `${name} image generation failed. Try again.`;
}

/** Credential lookup can fail at a different provider than the image call. */
export function imageCredentialErrorMessage(error: unknown): string {
	if (error instanceof DatabricksOAuthError) {
		return error.message;
	}
	return "Couldn't load the organization's AI provider credentials. Check Settings → AI Providers.";
}
