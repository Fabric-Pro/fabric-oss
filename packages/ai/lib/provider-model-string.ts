import type { AIProvider } from "@repo/database";
import { GATEWAY_PROVIDERS } from "@repo/database/prisma/queries/ai-provider-config";

/** The model string used for calls and provider-qualified embedding identities. */
export function buildProviderModelString(
	providerModelId: string,
	provider: AIProvider,
): string {
	if (GATEWAY_PROVIDERS.includes(provider)) {
		if (providerModelId.includes("/")) {
			return providerModelId;
		}
		console.error(
			`[ModelSelector] BUG: Gateway provider "${provider}" reached mapProviderToPrefix. Gateway model IDs should already include provider prefix. This indicates a missing or invalid provider mapping in the database.`,
		);
		return `openai/${providerModelId}`;
	}
	if (provider === "GROQ" || provider === "CEREBRAS") {
		return providerModelId;
	}
	return providerModelId.split("/").pop() ?? providerModelId;
}
