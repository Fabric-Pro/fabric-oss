import { z } from "zod";

export const frameRevisionSchema = z.string().datetime({ offset: true });
export const frameContentEditSchema = z.strictObject({
	expectedUpdatedAt: frameRevisionSchema,
	title: z.string().trim().min(1).max(300).optional(),
	description: z.string().max(20000).optional(),
	blocks: z
		.array(
			z.object({
				id: z.string().min(1),
				type: z.enum(["html", "json", "mermaid", "markdown"]),
				title: z.string().optional(),
				content: z.string().max(2000000),
				language: z.string().optional(),
			}),
		)
		.min(1)
		.max(100)
		.optional(),
	theme: z
		.object({
			mode: z.enum(["light", "dark", "system"]).optional(),
			accentColor: z.string().optional(),
		})
		.optional(),
});
export const frameRestoreSchema = z
	.strictObject({
		expectedUpdatedAt: frameRevisionSchema,
		historyEntryId: z.string().min(1).optional(),
		toVersion: z.number().int().min(1).optional(),
	})
	.refine(
		(value) => Boolean(value.historyEntryId) !== Boolean(value.toVersion),
		{ message: "Choose one saved version to restore." },
	);
