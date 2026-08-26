/**
 * AI Provider Config Sync Tests
 *
 * This test ensures that the frontend AI provider configuration
 * (apps/web/modules/saas/settings/lib/ai-providers.ts) stays in sync
 * with the backend source of truth (packages/database/prisma/queries/ai-provider-config.ts).
 *
 * The frontend maintains a separate copy because it cannot import from @repo/database
 * (which pulls in Prisma/pg that don't run in browsers).
 *
 * Run with: pnpm --filter @repo/database test:provider-sync
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	EMBEDDING_CAPABLE_PROVIDERS as BACKEND_EMBEDDING_PROVIDERS,
	GATEWAY_EMBEDDING_PROVIDERS as BACKEND_GATEWAY_EMBEDDING_PROVIDERS,
	GATEWAY_SUB_PROVIDERS as BACKEND_GATEWAY_SUB_PROVIDERS,
	AI_PROVIDER_METADATA as BACKEND_METADATA,
} from "../prisma/queries/ai-provider-config";

// Path to frontend config (relative to this test file)
const FRONTEND_CONFIG_PATH = join(
	__dirname,
	"../../../apps/web/modules/saas/settings/lib/ai-providers.ts",
);

/**
 * Parse the frontend TypeScript file to extract provider metadata.
 * This is a simple parser that extracts the AI_PROVIDER_METADATA object.
 */
function parseFrontendConfig(): {
	providers: Set<string>;
	metadata: Record<
		string,
		{
			id: string;
			name: string;
			category: string;
			requiresBaseUrl: boolean;
			baseUrl: string;
		}
	>;
	embeddingProviders: string[];
	gatewayEmbeddingProviders: string[];
	gatewaySubProviders: string[];
} {
	const content = readFileSync(FRONTEND_CONFIG_PATH, "utf-8");

	// Extract provider IDs from the AIProvider type
	const providerTypeMatch = content.match(
		/(?:export )?type AIProvider\s*=\s*([\s\S]*?);/,
	);
	const providers = new Set<string>();
	if (providerTypeMatch) {
		const typeContent = providerTypeMatch[1];
		const providerMatches = typeContent.matchAll(/"([A-Z_]+)"/g);
		for (const match of providerMatches) {
			providers.add(match[1]);
		}
	}

	// Extract metadata entries - parse individual provider blocks
	const metadata: Record<
		string,
		{
			id: string;
			name: string;
			category: string;
			requiresBaseUrl: boolean;
			baseUrl: string;
		}
	> = {};

	// Match each provider entry in AI_PROVIDER_METADATA
	const metadataBlockMatch = content.match(
		/(?:export )?const AI_PROVIDER_METADATA[^{]*{([\s\S]*?)^};/m,
	);
	if (metadataBlockMatch) {
		const metadataContent = metadataBlockMatch[1];

		// Match each provider entry
		const providerEntryRegex = /(\w+):\s*{([^}]+(?:{[^}]*}[^}]*)*)}/g;
		let match: RegExpExecArray | null;
		while (
			// biome-ignore lint/suspicious/noAssignInExpressions: standard regex iteration idiom
			(match = providerEntryRegex.exec(metadataContent)) !== null
		) {
			const providerId = match[1];
			const entryContent = match[2];

			// Extract fields
			const idMatch = entryContent.match(/id:\s*"([^"]+)"/);
			const nameMatch = entryContent.match(/name:\s*"([^"]+)"/);
			const categoryMatch = entryContent.match(/category:\s*"([^"]+)"/);
			const requiresBaseUrlMatch = entryContent.match(
				/requiresBaseUrl:\s*(true|false)/,
			);
			const baseUrlMatch = entryContent.match(/baseUrl:\s*"([^"]*)"/);

			if (idMatch) {
				metadata[providerId] = {
					id: idMatch[1],
					name: nameMatch?.[1] ?? "",
					category: categoryMatch?.[1] ?? "",
					requiresBaseUrl: requiresBaseUrlMatch?.[1] === "true",
					baseUrl: baseUrlMatch?.[1] ?? "",
				};
			}
		}
	}

	// Extract EMBEDDING_CAPABLE_PROVIDERS
	// Matches: const EMBEDDING_CAPABLE_PROVIDERS: readonly AIProvider[] = [...] (export optional —
	// knip demotes frontend-only symbols to module-local, but this textual sync check still applies)
	const embeddingMatch = content.match(
		/(?:export )?const EMBEDDING_CAPABLE_PROVIDERS[^=]*=\s*\[([\s\S]*?)\]\s*as\s*const|(?:export )?const EMBEDDING_CAPABLE_PROVIDERS[^=]*=\s*\[([\s\S]*?)\];/,
	);
	const embeddingProviders: string[] = [];
	if (embeddingMatch) {
		const matchContent = embeddingMatch[1] || embeddingMatch[2];
		if (matchContent) {
			const matches = matchContent.matchAll(/"([A-Z_]+)"/g);
			for (const m of matches) {
				embeddingProviders.push(m[1]);
			}
		}
	}

	// Extract GATEWAY_EMBEDDING_PROVIDERS
	const gatewayEmbeddingMatch = content.match(
		/(?:export )?const GATEWAY_EMBEDDING_PROVIDERS[^=]*=\s*\[([\s\S]*?)\]\s*as\s*const|(?:export )?const GATEWAY_EMBEDDING_PROVIDERS[^=]*=\s*\[([\s\S]*?)\];/,
	);
	const gatewayEmbeddingProviders: string[] = [];
	if (gatewayEmbeddingMatch) {
		const matchContent =
			gatewayEmbeddingMatch[1] || gatewayEmbeddingMatch[2];
		if (matchContent) {
			const matches = matchContent.matchAll(/"([A-Z_]+)"/g);
			for (const m of matches) {
				gatewayEmbeddingProviders.push(m[1]);
			}
		}
	}

	// Extract GATEWAY_SUB_PROVIDERS
	const gatewaySubMatch = content.match(
		/(?:export )?const GATEWAY_SUB_PROVIDERS[^[]*\[([\s\S]*?)\]\s*as\s*const/,
	);
	const gatewaySubProviders: string[] = [];
	if (gatewaySubMatch) {
		const idMatches = gatewaySubMatch[1].matchAll(/id:\s*"([A-Z_]+)"/g);
		for (const m of idMatches) {
			gatewaySubProviders.push(m[1]);
		}
	}

	return {
		providers,
		metadata,
		embeddingProviders,
		gatewayEmbeddingProviders,
		gatewaySubProviders,
	};
}

describe("AI Provider Config Sync", () => {
	const frontendConfig = parseFrontendConfig();
	const backendProviders = Object.keys(BACKEND_METADATA);

	describe("Provider List Sync", () => {
		it("should have all backend providers in frontend", () => {
			const missingInFrontend = backendProviders.filter(
				(p) => !frontendConfig.providers.has(p),
			);

			if (missingInFrontend.length > 0) {
				console.error(
					"\n❌ Providers missing in frontend ai-providers.ts:",
				);
				for (const p of missingInFrontend) {
					console.error(`  - ${p}`);
				}
				console.error(
					"\nAdd these to apps/web/modules/saas/settings/lib/ai-providers.ts",
				);
			}

			expect(missingInFrontend).toEqual([]);
		});

		it("should not have extra providers in frontend that are not in backend", () => {
			const extraInFrontend = Array.from(frontendConfig.providers).filter(
				(p) => !backendProviders.includes(p),
			);

			if (extraInFrontend.length > 0) {
				console.error(
					"\n❌ Extra providers in frontend not in backend:",
				);
				for (const p of extraInFrontend) {
					console.error(`  - ${p}`);
				}
				console.error(
					"\nRemove these from frontend or add to backend ai-provider-config.ts",
				);
			}

			expect(extraInFrontend).toEqual([]);
		});
	});

	describe("Provider Metadata Sync", () => {
		it("should have matching categories for all providers", () => {
			const mismatches: string[] = [];

			for (const [providerId, backendMeta] of Object.entries(
				BACKEND_METADATA,
			)) {
				const frontendMeta = frontendConfig.metadata[providerId];
				if (
					frontendMeta &&
					frontendMeta.category !== backendMeta.category
				) {
					mismatches.push(
						`${providerId}: backend="${backendMeta.category}" vs frontend="${frontendMeta.category}"`,
					);
				}
			}

			if (mismatches.length > 0) {
				console.error("\n❌ Category mismatches:");
				for (const m of mismatches) {
					console.error(`  - ${m}`);
				}
			}

			expect(mismatches).toEqual([]);
		});

		it("should have matching requiresBaseUrl for all providers", () => {
			const mismatches: string[] = [];

			for (const [providerId, backendMeta] of Object.entries(
				BACKEND_METADATA,
			)) {
				const frontendMeta = frontendConfig.metadata[providerId];
				if (
					frontendMeta &&
					frontendMeta.requiresBaseUrl !== backendMeta.requiresBaseUrl
				) {
					mismatches.push(
						`${providerId}: backend=${backendMeta.requiresBaseUrl} vs frontend=${frontendMeta.requiresBaseUrl}`,
					);
				}
			}

			if (mismatches.length > 0) {
				console.error("\n❌ requiresBaseUrl mismatches:");
				for (const m of mismatches) {
					console.error(`  - ${m}`);
				}
			}

			expect(mismatches).toEqual([]);
		});

		it("should have matching base URLs for providers with static URLs", () => {
			const mismatches: string[] = [];

			for (const [providerId, backendMeta] of Object.entries(
				BACKEND_METADATA,
			)) {
				const frontendMeta = frontendConfig.metadata[providerId];
				// Only check providers with non-empty base URLs (skip cloud providers that need custom URLs)
				if (
					frontendMeta &&
					backendMeta.baseUrl &&
					frontendMeta.baseUrl !== backendMeta.baseUrl
				) {
					mismatches.push(
						`${providerId}: backend="${backendMeta.baseUrl}" vs frontend="${frontendMeta.baseUrl}"`,
					);
				}
			}

			if (mismatches.length > 0) {
				console.error("\n❌ baseUrl mismatches:");
				for (const m of mismatches) {
					console.error(`  - ${m}`);
				}
			}

			expect(mismatches).toEqual([]);
		});
	});

	describe("Embedding Provider Sync", () => {
		it("should have matching EMBEDDING_CAPABLE_PROVIDERS", () => {
			const backendSet = new Set(
				BACKEND_EMBEDDING_PROVIDERS as readonly string[],
			);
			const frontendSet = new Set(frontendConfig.embeddingProviders);

			const missingInFrontend = [...backendSet].filter(
				(p) => !frontendSet.has(p),
			);
			const extraInFrontend = [...frontendSet].filter(
				(p) => !backendSet.has(p),
			);

			if (missingInFrontend.length > 0 || extraInFrontend.length > 0) {
				console.error("\n❌ EMBEDDING_CAPABLE_PROVIDERS mismatch:");
				if (missingInFrontend.length > 0) {
					console.error(
						`  Missing in frontend: ${missingInFrontend.join(", ")}`,
					);
				}
				if (extraInFrontend.length > 0) {
					console.error(
						`  Extra in frontend: ${extraInFrontend.join(", ")}`,
					);
				}
			}

			expect(missingInFrontend).toEqual([]);
			expect(extraInFrontend).toEqual([]);
		});

		it("should have matching GATEWAY_EMBEDDING_PROVIDERS", () => {
			const backendSet = new Set(
				BACKEND_GATEWAY_EMBEDDING_PROVIDERS as readonly string[],
			);
			const frontendSet = new Set(
				frontendConfig.gatewayEmbeddingProviders,
			);

			const missingInFrontend = [...backendSet].filter(
				(p) => !frontendSet.has(p),
			);
			const extraInFrontend = [...frontendSet].filter(
				(p) => !backendSet.has(p),
			);

			if (missingInFrontend.length > 0 || extraInFrontend.length > 0) {
				console.error("\n❌ GATEWAY_EMBEDDING_PROVIDERS mismatch:");
				if (missingInFrontend.length > 0) {
					console.error(
						`  Missing in frontend: ${missingInFrontend.join(", ")}`,
					);
				}
				if (extraInFrontend.length > 0) {
					console.error(
						`  Extra in frontend: ${extraInFrontend.join(", ")}`,
					);
				}
			}

			expect(missingInFrontend).toEqual([]);
			expect(extraInFrontend).toEqual([]);
		});
	});

	describe("Gateway Sub-Provider Sync", () => {
		it("should have matching GATEWAY_SUB_PROVIDERS", () => {
			const backendIds = BACKEND_GATEWAY_SUB_PROVIDERS.map(
				(p) => p.id as string,
			);
			const backendSet = new Set(backendIds);
			const frontendSet = new Set(frontendConfig.gatewaySubProviders);

			const missingInFrontend = [...backendSet].filter(
				(p) => !frontendSet.has(p),
			);
			const extraInFrontend = [...frontendSet].filter(
				(p) => !backendSet.has(p),
			);

			if (missingInFrontend.length > 0 || extraInFrontend.length > 0) {
				console.error("\n❌ GATEWAY_SUB_PROVIDERS mismatch:");
				if (missingInFrontend.length > 0) {
					console.error(
						`  Missing in frontend: ${missingInFrontend.join(", ")}`,
					);
				}
				if (extraInFrontend.length > 0) {
					console.error(
						`  Extra in frontend: ${extraInFrontend.join(", ")}`,
					);
				}
			}

			expect(missingInFrontend).toEqual([]);
			expect(extraInFrontend).toEqual([]);
		});
	});
});

describe("Provider Config Sync Summary", () => {
	it("should generate a sync report", () => {
		const frontendConfig = parseFrontendConfig();
		const backendProviders = Object.keys(BACKEND_METADATA);

		console.log(`\n${"=".repeat(70)}`);
		console.log("AI PROVIDER CONFIG SYNC REPORT");
		console.log("=".repeat(70));
		console.log(`\nBackend providers: ${backendProviders.length}`);
		console.log(`Frontend providers: ${frontendConfig.providers.size}`);
		console.log(
			`Frontend metadata entries: ${Object.keys(frontendConfig.metadata).length}`,
		);
		console.log(
			`\nEmbedding providers (backend): ${(BACKEND_EMBEDDING_PROVIDERS as readonly string[]).length}`,
		);
		console.log(
			`Embedding providers (frontend): ${frontendConfig.embeddingProviders.length}`,
		);
		console.log(
			`\nGateway sub-providers (backend): ${BACKEND_GATEWAY_SUB_PROVIDERS.length}`,
		);
		console.log(
			`Gateway sub-providers (frontend): ${frontendConfig.gatewaySubProviders.length}`,
		);
		console.log(`${"=".repeat(70)}\n`);

		expect(true).toBe(true);
	});
});
