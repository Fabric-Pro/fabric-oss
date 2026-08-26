/**
 * AI Gateway Integration Plugin
 * Generate text and images using AI models via Vercel AI Gateway
 *
 * Aligned with Vercel workflow-builder-template patterns
 */

import { registerIntegration } from "../registry";
import type { IntegrationPlugin } from "../types";
import { OpenAIIcon } from "./icon";

const aiGatewayPlugin: IntegrationPlugin = {
	type: "AI_GATEWAY",
	category: "tool",
	label: "AI Gateway",
	description:
		"Generate text and images using AI models via Vercel AI Gateway",
	icon: OpenAIIcon,
	color: "text-purple-500",

	formFields: [
		{
			id: "apiKey",
			label: "AI Gateway API Key",
			type: "password",
			placeholder: "Your Vercel AI Gateway API key (vck_...)",
			configKey: "apiKey",
			envVar: "AI_GATEWAY_API_KEY",
			helpText: "Get your API key from Vercel AI Gateway",
			helpLink: {
				text: "vercel.com/ai-gateway",
				url: "https://vercel.com/docs/ai-gateway/getting-started",
			},
			required: true,
		},
	],

	testConfig: {
		getTestFunction: async () => {
			const { testAiGatewayConnection } = await import("./test");
			return testAiGatewayConnection;
		},
	},

	actions: [
		{
			slug: "generate-text",
			// Pinned: predates the <type>-<slug> convention. Renaming it
			// would orphan every saved workflow using this node.
			nodeType: "ai-generate-text",
			label: "Generate Text",
			description: "Generate text using AI models",
			category: "AI",
			stepFunction: "executeAiGenerateTextStep",
			stepImportPath: "ai-generate-text",
			outputFields: [
				{ field: "text", description: "Generated text content" },
			],
			outputConfig: { type: "json", field: "text" },
			configFields: [
				{
					key: "aiFormat",
					label: "Output Format",
					type: "select",
					defaultValue: "text",
					options: [
						{ value: "text", label: "Text" },
						{ value: "object", label: "Structured Object (JSON)" },
					],
				},
				{
					key: "aiPrompt",
					label: "Prompt",
					type: "template-textarea",
					placeholder:
						"Enter your prompt. Use {{NodeName.field}} to reference previous outputs.",
					rows: 4,
					example:
						"Summarize the following text: {{Scrape.markdown}}",
					required: true,
				},
				{
					key: "aiSchema",
					label: "Output Schema",
					type: "schema-builder",
					showWhen: { field: "aiFormat", equals: "object" },
				},
				// Fabric AI enrichment. The step reads these via
				// extractFabricConfig(), so they must stay offered.
				{
					key: "fabricAutoDetect",
					label: "Auto-detect Fabric AI Enhancement",
					type: "boolean",
					defaultValue: "true",
				},
				{
					key: "fabricStrategy",
					label: "Fabric Strategy (optional)",
					type: "select",
					options: [
						{ value: "auto", label: "Auto-detect" },
						{ value: "cot", label: "Chain of Thought" },
						{ value: "tot", label: "Tree of Thoughts" },
						{ value: "reflexion", label: "Reflexion" },
					],
				},
				{
					key: "fabricContext",
					label: "Fabric Context (optional)",
					type: "select",
					options: [
						{ value: "auto", label: "Auto-detect" },
						{ value: "senior_dev", label: "Senior Developer" },
						{
							value: "security_expert",
							label: "Security Expert",
						},
						{
							value: "product_manager",
							label: "Product Manager",
						},
						{
							value: "technical_writer",
							label: "Technical Writer",
						},
					],
				},
				{
					key: "fabricPattern",
					label: "Fabric Pattern (optional)",
					type: "select",
					options: [
						{ value: "auto", label: "Auto-detect" },
						{ value: "summarize", label: "Summarize" },
						{ value: "analyze_claims", label: "Analyze Claims" },
						{ value: "review_code", label: "Review Code" },
						{ value: "extract_wisdom", label: "Extract Wisdom" },
						{
							value: "create_design_document",
							label: "Create Design Doc",
						},
					],
				},
			],
		},
		{
			slug: "generate-image",
			// Pinned: predates the <type>-<slug> convention. Renaming it
			// would orphan every saved workflow using this node.
			nodeType: "ai-generate-image",
			label: "Generate Image",
			description: "Generate images using AI models",
			category: "AI",
			stepFunction: "executeAiGenerateImageStep",
			stepImportPath: "ai-generate-image",
			outputFields: [
				{ field: "base64", description: "Base64-encoded image data" },
				{ field: "url", description: "Image URL (if available)" },
				{ field: "revisedPrompt", description: "AI-revised prompt" },
			],
			outputConfig: { type: "image", field: "base64" },
			configFields: [
				{
					key: "imageModel",
					label: "Model",
					type: "select",
					// Model IDs use the format shown in https://vercel.com/ai-gateway/models
					// e.g., "google/imagen-4.0-generate-001" - the gateway routes to the correct provider
					defaultValue: "google/imagen-4.0-generate-001",
					options: [
						// Google Imagen models (via Vertex AI)
						{
							value: "google/imagen-4.0-generate-001",
							label: "Imagen 4",
						},
						{
							value: "google/imagen-4.0-fast-generate-001",
							label: "Imagen 4 Fast",
						},
						{
							value: "google/imagen-4.0-ultra-generate-001",
							label: "Imagen 4 Ultra",
						},
						// Black Forest Labs FLUX models
						{
							value: "bfl/flux-kontext-pro",
							label: "FLUX.1 Kontext Pro",
						},
						{
							value: "bfl/flux-kontext-max",
							label: "FLUX.1 Kontext Max",
						},
						{
							value: "bfl/flux-pro-1.1",
							label: "FLUX1.1 [pro]",
						},
						{
							value: "bfl/flux-pro-1.1-ultra",
							label: "FLUX1.1 [pro] Ultra",
						},
					],
				},
				{
					key: "imagePrompt",
					label: "Prompt",
					type: "template-textarea",
					placeholder:
						"Describe the image you want to generate. Use {{NodeName.field}} to reference previous outputs.",
					rows: 4,
					example: "A serene mountain landscape at sunset",
					required: true,
				},
				{
					key: "imageSize",
					label: "Size",
					type: "select",
					defaultValue: "1024x1024",
					options: [
						{ value: "256x256", label: "256x256" },
						{ value: "512x512", label: "512x512" },
						{ value: "1024x1024", label: "1024x1024" },
						{ value: "1024x1792", label: "1024x1792 (Portrait)" },
						{ value: "1792x1024", label: "1792x1024 (Landscape)" },
					],
				},
				{
					// Read by the step; offered by the old hand-written
					// palette but never declared here.
					key: "enhancePrompt",
					label: "Enhance Prompt with Fabric AI",
					type: "boolean",
					defaultValue: "false",
				},
			],
		},
	],
};

// Auto-register the plugin
registerIntegration(aiGatewayPlugin);
