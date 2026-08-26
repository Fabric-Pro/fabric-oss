/**
 * SSRF protection for tenant-supplied AI provider base URLs.
 *
 * A provider config's `baseUrl` is attacker-influenced input (any org admin can
 * set it) that the server later makes outbound requests to — model inference,
 * model listing, and, for a Databricks service principal, a POST carrying the
 * CLIENT SECRET to `<baseUrl origin>/oidc/v1/token`. That last one is why this
 * lives in a shared module rather than staying private to the connection
 * tester: the same rules must hold at the persistence boundary (`upsert`), or a
 * direct oRPC call could store `http://169.254.169.254/…` and turn ordinary
 * model resolution into a credential-bearing request to the metadata service.
 *
 * Extracted verbatim from `procedures/providers/test-connection.ts` so both
 * boundaries share one definition and cannot drift apart.
 */

/**
 * Allowed provider domains for SSRF protection.
 * Prevents requests to internal endpoints and unauthorized domains.
 */
const ALLOWED_PROVIDER_DOMAINS: Record<string, string[]> = {
	OPENAI_DIRECT: ["api.openai.com"],
	ANTHROPIC_DIRECT: ["api.anthropic.com"],
	GROQ: ["api.groq.com"],
	TOGETHER_AI: ["api.together.xyz"],
	DEEPSEEK: ["api.deepseek.com"],
	MISTRAL_AI: ["api.mistral.ai"],
	FIREWORKS: ["api.fireworks.ai"],
	PERPLEXITY: ["api.perplexity.ai"],
	COHERE: ["api.cohere.ai"],
	OPENROUTER: ["openrouter.ai"],
	CLOUDFLARE_AI: ["gateway.ai.cloudflare.com"],
	VERCEL_GATEWAY: ["ai-gateway.vercel.sh"],
	XAI: ["api.x.ai"],
	CEREBRAS: ["api.cerebras.ai"],
	AZURE_AI_FOUNDRY: [".openai.azure.com"], // Suffix match for Azure
	DATABRICKS: [
		".cloud.databricks.com",
		".azuredatabricks.net",
		".gcp.databricks.com",
	], // Suffix match for Databricks workspace hosts (AWS / Azure / GCP)
};

/**
 * Validate provider URL to prevent SSRF attacks.
 * Ensures the URL matches expected provider domains.
 */
export function validateProviderUrl(
	url: string,
	provider: string,
): { valid: boolean; error?: string } {
	try {
		const parsed = new URL(url);

		// Block non-HTTPS URLs (except for localhost in development)
		if (
			parsed.protocol !== "https:" &&
			!(
				process.env.NODE_ENV === "development" &&
				parsed.hostname === "localhost"
			)
		) {
			return { valid: false, error: "Invalid protocol. HTTPS required." };
		}

		// Block internal IP addresses and localhost in production
		const hostname = parsed.hostname.toLowerCase();
		if (process.env.NODE_ENV === "production") {
			// Block private IP ranges
			if (
				hostname === "localhost" ||
				hostname === "127.0.0.1" ||
				hostname.startsWith("192.168.") ||
				hostname.startsWith("10.") ||
				hostname.startsWith("172.16.") ||
				hostname.startsWith("169.254.") // Link-local
			) {
				return { valid: false, error: "Invalid URL" };
			}
		}

		// Check against allowed domains for the provider
		const allowedDomains = ALLOWED_PROVIDER_DOMAINS[provider];
		if (allowedDomains) {
			const isAllowed = allowedDomains.some(
				(domain) =>
					hostname === domain ||
					(domain.startsWith(".") && hostname.endsWith(domain)),
			);
			if (!isAllowed) {
				return { valid: false, error: "Invalid provider URL" };
			}
		}

		return { valid: true };
	} catch {
		return { valid: false, error: "Invalid URL format" };
	}
}
