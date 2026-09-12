/**
 * Where each provider's brand mark comes from.
 *
 * Settings tiles show a provider's own favicon (see `SiteFavicon`) instead of
 * a generic glyph. Docs and console URLs usually sit on a subdomain whose
 * favicon is the brand's, but several point at a host that is not the brand
 * (Azure docs on learn.microsoft.com, YouTube docs on developers.google.com),
 * so the site is named explicitly where it matters and derived from the docs
 * URL otherwise.
 */
const AI_PROVIDER_SITES: Record<string, string> = {
	VERCEL_GATEWAY: "https://vercel.com",
	OPENROUTER: "https://openrouter.ai",
	CLOUDFLARE_AI: "https://www.cloudflare.com",
	OPENAI_DIRECT: "https://openai.com",
	ANTHROPIC_DIRECT: "https://www.anthropic.com",
	GROQ: "https://groq.com",
	CEREBRAS: "https://www.cerebras.ai",
	TOGETHER_AI: "https://www.together.ai",
	DEEPSEEK: "https://www.deepseek.com",
	MISTRAL_AI: "https://mistral.ai",
	FIREWORKS: "https://fireworks.ai",
	PERPLEXITY: "https://www.perplexity.ai",
	COHERE: "https://cohere.com",
	XAI: "https://x.ai",
	REPLICATE: "https://replicate.com",
	HUGGINGFACE: "https://huggingface.co",
	AZURE_AI_FOUNDRY: "https://azure.microsoft.com",
	AZURE_OPENAI: "https://azure.microsoft.com",
	GOOGLE_VERTEX_AI: "https://cloud.google.com",
	AWS_BEDROCK: "https://aws.amazon.com",
	DATABRICKS: "https://www.databricks.com",
	NETLIFY: "https://www.netlify.com",
};

const RAG_PROVIDER_SITES: Record<string, string> = {
	unstructured: "https://unstructured.io",
	llamaparse: "https://www.llamaindex.ai",
	"azure-document-intelligence": "https://azure.microsoft.com",
};

function siteFromDocs(docsUrl?: string | null): string | null {
	if (!docsUrl) {
		return null;
	}
	try {
		const { protocol, hostname } = new URL(docsUrl);
		// console.groq.com → groq.com; keep two-label hosts as they are.
		const labels = hostname.split(".");
		const site = labels.length > 2 ? labels.slice(-2).join(".") : hostname;
		return `${protocol}//${site}`;
	} catch {
		return null;
	}
}

/** Site whose favicon stands for an AI provider; null when none is known. */
export function aiProviderSiteUrl(
	id: string,
	docsUrl?: string | null,
): string | null {
	return AI_PROVIDER_SITES[id] ?? siteFromDocs(docsUrl);
}

/** Site whose favicon stands for a RAG extraction provider; null for local ones. */
export function ragProviderSiteUrl(name: string): string | null {
	return RAG_PROVIDER_SITES[name] ?? null;
}
