import { z } from "zod";
import {
	Permissions,
	publicProcedure,
	requirePermission,
} from "../../../orpc/procedures";

/**
 * List all available RAG extraction providers
 * Public endpoint - no authentication required
 */
export const listAvailableProviders = publicProcedure
	.use(requirePermission(Permissions.ORG_RAG_SETTINGS_READ))
	.route({
		method: "GET",
		path: "/rag-providers/available",
		tags: ["RAG Providers"],
		summary: "List available RAG extraction providers",
		description:
			"Get a list of all available RAG extraction providers with their capabilities and pricing",
	})
	.output(
		z.array(
			z.object({
				name: z.string(),
				displayName: z.string(),
				description: z.string(),
				supportedFileTypes: z.array(z.string()),
				requiresApiKey: z.boolean(),
				costPerPage: z.number(),
				features: z.array(z.string()),
			}),
		),
	)
	.handler(async () => {
		return [
			{
				name: "local-pdf",
				displayName: "Local PDF (pdf-parse)",
				description: "Free, fast text extraction for text-based PDFs",
				supportedFileTypes: ["application/pdf"],
				requiresApiKey: false,
				costPerPage: 0,
				features: ["Fast", "Free", "Text-based PDFs only"],
			},
			{
				name: "local-docx",
				displayName: "Local DOCX (mammoth)",
				description: "Free text extraction for Word documents",
				supportedFileTypes: [
					"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
				],
				requiresApiKey: false,
				costPerPage: 0,
				features: ["Fast", "Free", "Word documents"],
			},
			{
				name: "local-text",
				displayName: "Local Text",
				description: "Free text extraction for plain text files",
				supportedFileTypes: [
					"text/plain",
					"text/markdown",
					"text/csv",
					"application/json",
				],
				requiresApiKey: false,
				costPerPage: 0,
				features: ["Fast", "Free", "Plain text files"],
			},
			{
				name: "unstructured",
				displayName: "Unstructured.io",
				description: "OCR for images and scanned PDFs",
				supportedFileTypes: [
					"application/pdf",
					"image/jpeg",
					"image/png",
					"image/gif",
				],
				requiresApiKey: true,
				costPerPage: 0.01,
				features: ["OCR", "Images", "Scanned PDFs", "High accuracy"],
			},
			{
				name: "llamaparse",
				displayName: "LlamaParse (LlamaIndex)",
				description:
					"Advanced PDF parsing with table and form extraction",
				supportedFileTypes: [
					"application/pdf",
					"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
					"image/jpeg",
					"image/png",
				],
				requiresApiKey: true,
				costPerPage: 0.003,
				features: [
					"Tables",
					"Forms",
					"Multi-column layouts",
					"Complex PDFs",
					"1,000 free pages/day",
				],
			},
			{
				name: "azure-document-intelligence",
				displayName: "Azure Document Intelligence",
				description: "Microsoft's enterprise document analysis service",
				supportedFileTypes: [
					"application/pdf",
					"image/jpeg",
					"image/png",
					"image/tiff",
					"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
				],
				requiresApiKey: true,
				costPerPage: 0.01,
				features: [
					"Enterprise-grade",
					"Tables",
					"Forms",
					"OCR",
					"High volume",
				],
			},
		];
	});
