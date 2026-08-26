import { ORPCError } from "@orpc/server";
import {
	AzureDocumentIntelligenceExtractor,
	LlamaParseExtractor,
} from "@repo/rag/lib/extraction/extractors";
import { UnstructuredOcrProvider } from "@repo/rag/lib/ocr";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

/**
 * Test connection to a RAG provider
 * Validates API key and endpoint without processing a document
 */
export const testProviderConnection = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_RAG_SETTINGS_READ))
	.route({
		method: "POST",
		path: "/rag-providers/test-connection",
		tags: ["RAG Providers"],
		summary: "Test RAG provider connection",
		description:
			"Test connection to a RAG extraction provider to validate API key and endpoint",
	})
	.input(
		z.object({
			providerName: z.string(),
			apiKey: z.string(),
			endpoint: z.string().url().optional(),
		}),
	)
	.output(
		z.object({
			success: z.boolean(),
			message: z.string(),
			provider: z.string(),
		}),
	)
	.handler(async ({ input: { providerName, apiKey, endpoint } }) => {
		try {
			switch (providerName) {
				case "unstructured": {
					const provider = new UnstructuredOcrProvider({
						apiKey,
						endpoint,
					});
					const isAvailable = await provider.isAvailable();
					if (!isAvailable) {
						throw new Error("Provider is not available");
					}
					return {
						success: true,
						message: "Successfully connected to Unstructured.io",
						provider: providerName,
					};
				}

				case "llamaparse": {
					const extractor = new LlamaParseExtractor(apiKey, {
						endpoint,
					});
					const isAvailable = await extractor.isAvailable();
					if (!isAvailable) {
						throw new Error("Provider is not available");
					}
					return {
						success: true,
						message: "Successfully connected to LlamaParse",
						provider: providerName,
					};
				}

				case "azure-document-intelligence": {
					if (!endpoint) {
						throw new ORPCError("BAD_REQUEST", {
							message:
								"Endpoint is required for Azure Document Intelligence",
						});
					}
					const extractor = new AzureDocumentIntelligenceExtractor(
						apiKey,
						endpoint,
					);
					const isAvailable = await extractor.isAvailable();
					if (!isAvailable) {
						throw new Error("Provider is not available");
					}
					return {
						success: true,
						message:
							"Successfully connected to Azure Document Intelligence",
						provider: providerName,
					};
				}

				case "local-pdf":
				case "local-docx":
				case "local-text":
					return {
						success: true,
						message: "Local providers do not require API keys",
						provider: providerName,
					};

				default:
					throw new ORPCError("BAD_REQUEST", {
						message: `Unknown provider: ${providerName}`,
					});
			}
		} catch (error) {
			throw new ORPCError("BAD_REQUEST", {
				message: `Failed to connect to ${providerName}: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	});
