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
 * Resolve the plaintext OpenAI API key to use for a direct OpenAI REST call.
 *
 * Falls back to `process.env.OPENAI_API_KEY` when the tenant has no
 * OPENAI_DIRECT provider config, or the config carries no usable credential.
 * Returns `""` when neither source has a key — callers already handle that
 * case by erroring clearly.
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

	return process.env.OPENAI_API_KEY || "";
}
