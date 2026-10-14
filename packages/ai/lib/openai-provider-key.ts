/**
 * Plaintext OpenAI API key resolution for call sites that hit OpenAI's REST
 * API directly, bypassing the AI SDK's provider routing entirely — currently
 * just the `fabric_text_to_speech` tool, which calls
 * `api.openai.com/v1/audio/speech` with a raw `fetch`.
 *
 * Two things distinguish this from a plain `resolveModelWithCredentials`
 * call:
 *
 *  - It looks up the tenant's OPENAI_DIRECT provider config specifically, via
 *    `getAiProviderApiKeyByProvider`. `resolveModelWithCredentials` resolves
 *    whatever provider the tenant's default model selection picked — which
 *    could be Databricks, Groq, or anything else — and that credential is
 *    never valid for an OpenAI-only endpoint even once decrypted.
 *  - It decrypts the stored key via `resolveProviderApiKey` before returning
 *    it. A provider config's `apiKey` field is the ENCRYPTED value; sending
 *    it straight to OpenAI as a bearer token fails authentication.
 */

import { getAiProviderApiKeyByProvider } from "@repo/database";
import {
	hasProviderCredentials,
	resolveProviderApiKey,
} from "./databricks-oauth";

/**
 * What a person is told when audio is refused because their organization has no
 * provider key that can serve it. Audio never runs on Fabric's own key, so each
 * surface names the keys that would make it work.
 */
export const AUDIO_PROVIDER_REQUIRED = {
	/** The `fabric_text_to_speech` tool, which calls OpenAI directly. */
	textToSpeech:
		"Voice needs an AI provider for your organization. Add an OpenAI API key in Settings → AI Providers. ChatGPT plans serve text only.",
	/** Parlume speaks through the organization's AI Gateway or OpenAI key. */
	parlumeVoice:
		"Parlume voice needs an AI provider for your organization. Add an OpenAI or Vercel AI Gateway API key in Settings → AI Providers. ChatGPT plans serve text only.",
	/** Transcription runs on the organization's OpenAI or Groq key. */
	transcription:
		"Transcription needs an AI provider for your organization. Add an OpenAI or Groq API key in Settings → AI Providers. ChatGPT plans serve text only.",
} as const;

/**
 * Resolve the plaintext OpenAI API key to use for a direct OpenAI REST call.
 *
 * Only the tenant's own OPENAI_DIRECT provider config counts: there is no
 * fallback to Fabric's platform `OPENAI_API_KEY`, because a tenant's audio
 * never runs on Fabric's own key. Returns `""` when the tenant has no usable
 * OpenAI credential; callers refuse with {@link AUDIO_PROVIDER_REQUIRED}.
 */
export async function resolveOpenAiApiKey({
	userId,
	organizationId,
}: {
	userId: string;
	organizationId?: string | null;
}): Promise<string> {
	const providerConfig = await getAiProviderApiKeyByProvider({
		userId,
		organizationId,
		provider: "OPENAI_DIRECT",
	});

	if (hasProviderCredentials(providerConfig)) {
		// `lenientDecrypt` because `getAiProviderApiKeyByProvider` still
		// returns legacy plaintext keys for rows without `encryptedApiKey`;
		// strict decryption would reject a key the old passthrough sent as-is.
		return await resolveProviderApiKey(providerConfig, {
			lenientDecrypt: true,
		});
	}

	return "";
}
