/**
 * Whose key an embedding request was sent with: a user's or an
 * organization's own AI provider settings, or the platform AI Gateway key
 * (`AI_GATEWAY_API_KEY`), which the resolver reports as a `null` source.
 */
export type EmbeddingCredentialSource = "user" | "organization" | "platform";

/**
 * A failed embedding call from `generateEmbedding` or `generateEmbeddings`.
 * The message is the one those functions always threw ("Embedding generation
 * failed: …") and `cause` is the provider's error. `credentialSource` and
 * `provider` say which key the provider was given, so a caller can name the
 * key a provider rejected without repeating the provider's help text. The AI
 * Gateway's text tells the reader to set `AI_GATEWAY_API_KEY` even when the
 * rejected key was an organization's own (Fizzy #3571).
 */
export class EmbeddingGenerationError extends Error {
	readonly credentialSource: EmbeddingCredentialSource;
	readonly provider: string | undefined;

	constructor(
		message: string,
		options: {
			cause: unknown;
			credentialSource: EmbeddingCredentialSource;
			provider?: string;
		},
	) {
		super(message, { cause: options.cause });
		this.credentialSource = options.credentialSource;
		this.provider = options.provider;
	}
}
