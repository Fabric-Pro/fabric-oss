import {
	ARTIFACT_BRAND_SOURCES,
	ARTIFACT_COVER_STYLES,
	ARTIFACT_FONT_FAMILIES,
} from "@repo/utils/artifact-brand-theme";
import { z } from "zod";
export interface BrandActor {
	userId: string;
	organizationId: string;
}
const id = z.string().trim().min(1).max(200);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const artifactBrandReadSchema = z
	.object({ projectId: id.optional() })
	.strict();
export const companyBrandSaveSchema = z
	.object({
		expectedVersion: z.number().int().min(0),
		primaryColor: color.nullable().optional(),
		accentColors: z.array(color).max(3).optional(),
		guidance: z.string().max(2000).nullable().optional(),
		website: z.string().max(2048).nullable().optional(),
	})
	.strict()
	.refine(
		(input) => Object.keys(input).length > 1,
		"Provide a brand field to save.",
	);
export const clientBrandSaveSchema = z
	.object({
		projectId: id,
		expectedVersion: z.number().int().min(0),
		name: z.string().max(200).nullable(),
		website: z.string().max(2048).nullable(),
		colors: z.array(color).max(3),
		displayFontFamily: z.enum(ARTIFACT_FONT_FAMILIES).nullable().optional(),
		bodyFontFamily: z.enum(ARTIFACT_FONT_FAMILIES).nullable().optional(),
		coverStyle: z.enum(ARTIFACT_COVER_STYLES).optional(),
	})
	.strict();

export const proposalStyleReadSchema = z
	.object({ projectId: id, documentId: id })
	.strict();
const proposalStyleSaveObjectSchema = proposalStyleReadSchema
	.extend({
		expectedUpdatedAt: z.iso.datetime({ offset: true }).nullable(),
		brandSource: z.enum(ARTIFACT_BRAND_SOURCES).optional(),
		coverStyle: z.enum(ARTIFACT_COVER_STYLES).nullable().optional(),
		styleDirection: z.string().trim().max(500).nullable().optional(),
		primaryColor: color.nullable().optional(),
		accentColors: z.array(color).max(3).optional(),
		autoVisuals: z.boolean().optional(),
	})
	.strict();
export const proposalStyleSaveBodySchema = proposalStyleSaveObjectSchema
	.omit({ projectId: true, documentId: true })
	.strict();
export const proposalStyleSaveSchema = proposalStyleSaveObjectSchema.refine(
	(input) => Object.keys(input).length > 3,
	"Provide a style field to save.",
);
