import { z } from "zod";
export const SKILL_IMPORT_MAX_BYTES = 8 * 1024 * 1024;
export const SKILL_IMPORT_MAX_REQUEST_BYTES = 12 * 1024 * 1024;
export const SKILL_AUTHORING_MAX_BYTES = 128 * 1024;
const draft = z.strictObject({
	name: z.string().max(200).default(""),
	slug: z.string().max(100).default(""),
	description: z.string().max(4000).default(""),
	content: z.string().max(60000).default(""),
	category: z.string().max(100).optional(),
	tags: z.array(z.string().max(64)).max(20).default([]),
});
export const skillAssistSchema = z.strictObject({
	draft,
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
export const skillAssistResultSchema = z.strictObject({
	message: z.string().min(1).max(8000),
	proposal: draft
		.extend({
			name: z.string().trim().min(1).max(200),
			slug: z
				.string()
				.min(1)
				.max(100)
				.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
			description: z.string().trim().min(1).max(4000),
			content: z.string().trim().min(1).max(60000),
		})
		.nullable(),
});
export type SkillAssistResult = z.infer<typeof skillAssistResultSchema>;
export const skillImportSourceSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("file"),
		fileName: z.string().min(1).max(200),
		base64: z
			.string()
			.min(1)
			.max(Math.ceil(SKILL_IMPORT_MAX_BYTES / 3) * 4 + 4),
	}),
	z.strictObject({
		kind: z.literal("github"),
		url: z.string().url().max(1000),
		ref: z.string().min(1).max(150).optional(),
	}),
]);
export const skillImportPreviewSchema = z.strictObject({
	source: skillImportSourceSchema,
});
export const skillImportCreateSchema = z.strictObject({
	source: skillImportSourceSchema,
	candidateKey: z.string().min(1).max(512),
	expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
	overrides: z
		.strictObject({
			name: z.string().trim().min(1).max(200).optional(),
			slug: z
				.string()
				.trim()
				.min(1)
				.max(100)
				.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
				.optional(),
			description: z.string().trim().min(1).max(4000).optional(),
		})
		.optional(),
});
export interface SkillImportFile {
	path: string;
	contentType: string;
	sizeBytes: number;
	sha256: string;
}
export interface SkillImportCandidate {
	key: string;
	draft: z.infer<typeof draft>;
	files: SkillImportFile[];
	warnings: string[];
}
export interface SkillImportPreview {
	source: {
		kind: "file" | "github";
		sha256: string;
		fileName?: string;
		repository?: string;
		commit?: string;
	};
	candidates: SkillImportCandidate[];
	warnings: string[];
}
export const skillImportFileSchema = z.strictObject({
	source: skillImportSourceSchema,
	candidateKey: z.string().min(1).max(512),
	expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
	path: z.string().min(1).max(512),
});
export const skillFileReadSchema = z.strictObject({
	id: z.string().min(1).max(200),
	path: z.string().min(1).max(512),
	expectedVersion: z.number().int().positive().optional(),
});
export const skillFileContentSchema = z.strictObject({
	path: z.string().min(1).max(512),
	contentType: z.string().min(1).max(200),
	sizeBytes: z
		.number()
		.int()
		.min(0)
		.max(2 * 1024 * 1024),
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
	encoding: z.enum(["utf-8", "base64"]),
	data: z.string().max(3 * 1024 * 1024),
});
export type SkillFileContent = z.infer<typeof skillFileContentSchema>;
