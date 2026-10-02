import {
	getAiProviderApiKeyByProvider,
	updateProviderLastUsed,
} from "@repo/database";
import { getTenantAiGatewayBillingState } from "@repo/payments";
import { getGatewaySpeechModel } from "../model-factory";
import { resolveProviderApiKey } from "./databricks-oauth";

/** OpenAI's speech model on Vercel AI Gateway; listed in the gateway's model ids. */
export const GATEWAY_SPEECH_MODEL_ID = "openai/tts-1";

export interface AISpeechModelResult {
	model: ReturnType<typeof getGatewaySpeechModel>;
	modelId: string;
	configId: string | null;
	trackUsage: () => void;
}

/**
 * Resolve the organization's Vercel AI Gateway speech model, or `null` when the
 * organization has no gateway provider. Speech then goes through the same
 * credential, routing and billing as the organization's language models,
 * instead of a separately stored OpenAI key that nothing else exercises.
 */
export async function getAISpeechModel(context: {
	userId: string;
	organizationId: string;
}): Promise<AISpeechModelResult | null> {
	const providerConfig = await getAiProviderApiKeyByProvider({
		userId: context.userId,
		organizationId: context.organizationId,
		provider: "VERCEL_GATEWAY",
	});
	if (
		providerConfig.provider !== "VERCEL_GATEWAY" ||
		providerConfig.source !== "organization" ||
		!providerConfig.apiKey
	) {
		return null;
	}
	const apiKey = await resolveProviderApiKey(providerConfig);
	const billingState = getTenantAiGatewayBillingState({
		provider: "VERCEL_GATEWAY",
		configSource: providerConfig.source,
	});
	return {
		model: getGatewaySpeechModel(GATEWAY_SPEECH_MODEL_ID, {
			apiKey,
			headers: billingState.headers ?? undefined,
		}),
		modelId: GATEWAY_SPEECH_MODEL_ID,
		configId: providerConfig.configId ?? null,
		trackUsage: () => {
			if (providerConfig.configId) {
				updateProviderLastUsed({
					configId: providerConfig.configId,
					source: "organization",
				}).catch(() => {
					// Best effort, like the language-model path.
				});
			}
		},
	};
}
