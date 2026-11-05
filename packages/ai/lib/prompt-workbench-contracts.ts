import { z } from "zod";
import {
	promptResponseContract,
	promptResponseValidation,
} from "./prompt-response-contract";
export const PROMPT_WORKBENCH_MAX_BYTES = 512 * 1024;
export const promptWorkbenchFormat = z.enum([
	"PLAIN_TEXT",
	"MARKDOWN",
	"HANDLEBARS",
	"MUSTACHE",
	"LIQUID",
	"JINJA2",
]);
export const promptWorkbenchDraft = z.strictObject({
	name: z.string().max(255).default(""),
	description: z.string().max(4000).default(""),
	format: promptWorkbenchFormat.default("PLAIN_TEXT"),
	content: z.string().max(50000).default(""),
	responseContract: promptResponseContract.optional(),
});
export const promptAssistInput = z.strictObject({
	draft: promptWorkbenchDraft,
	message: z.string().trim().min(1).max(8000),
	history: z
		.array(
			z.strictObject({
				role: z.enum(["user", "assistant"]),
				content: z.string().max(8000),
			}),
		)
		.max(10)
		.default([]),
});
export const promptAssistOutput = z.strictObject({
	message: z.string().min(1).max(8000),
	proposal: promptWorkbenchDraft
		.omit({ responseContract: true })
		.extend({
			name: z.string().trim().min(1).max(255),
			content: z.string().trim().min(1).max(50000),
		})
		.nullable(),
});
export const promptTryInput = z.strictObject({
	draft: promptWorkbenchDraft.extend({
		content: z.string().trim().min(1).max(50000),
	}),
	variables: z
		.record(z.string().max(100), z.string().max(16000))
		.refine(
			(x) => Object.keys(x).length <= 30,
			"At most 30 input values are supported.",
		)
		.default({}),
});
export const promptTryOutput = z.strictObject({
	output: z.string().max(64000),
	responseFormat: z.enum(["AUTO", "TEXT", "MARKDOWN", "JSON", "XML"]),
	validation: promptResponseValidation,
	renderedPrompt: z.string().max(64000),
	draftHash: z.string().regex(/^[a-f0-9]{64}$/),
	mode: z.literal("live-model-preview"),
	sourceAccess: z.literal("provided-inputs-only"),
});
export type PromptWorkbenchDraft = z.infer<typeof promptWorkbenchDraft>;

export const promptResponseReadInput = z.strictObject({
	promptId: z.string().min(1).max(200),
});
export const promptResponseUpdateInput = promptResponseReadInput.extend({
	responseContract: promptResponseContract,
});
