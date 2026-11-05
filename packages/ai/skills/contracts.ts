import { z } from "zod";

export const SKILL_MANAGEMENT_MAX_BYTES = 1024 * 1024;
const id = z.string().trim().min(1).max(200);
const name = z.string().trim().min(1).max(200);
const slug = z
	.string()
	.trim()
	.min(1)
	.max(100)
	.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const description = z.string().trim().min(1).max(4000);
const content = z
	.string()
	.min(1)
	.max(200_000)
	.refine((value) => value.trim().length > 0, {
		message: "Write instructions before saving this skill.",
	});
const tags = z.array(z.string().trim().min(1).max(64)).max(20);
export const skillAvailabilitySchema = z.enum([
	"draft",
	"members",
	"agents",
	"builtin",
]);
export const skillListSchema = z.strictObject({
	tab: z
		.enum(["organization", "builtin", "drafts", "archived", "all"])
		.default("all"),
	search: z.string().trim().max(200).optional(),
	isPublished: z.boolean().optional(),
	isDiscoverable: z.boolean().optional(),
	category: z.string().max(100).optional(),
	tags: z.array(z.string().max(64)).max(20).optional(),
	scope: z.enum(["SYSTEM", "ORGANIZATION"]).optional(),
	limit: z.number().int().min(1).max(100).default(20),
	offset: z.number().int().min(0).max(100_000).default(0),
	cursor: id.optional(),
	sortBy: z
		.enum(["name", "createdAt", "updatedAt", "useCount"])
		.default("updatedAt"),
	sortOrder: z.enum(["asc", "desc"]).default("desc"),
});
export const skillGetSchema = z.strictObject({ id });
export const skillCreateSchema = z
	.strictObject({
		name,
		slug,
		description,
		content,
		category: z.string().trim().min(1).max(100).optional(),
		tags: tags.default([]),
		isPublished: z.boolean().default(false),
		isDiscoverable: z.boolean().default(false),
	})
	.refine((x) => !x.isDiscoverable || x.isPublished, {
		message: "Publish a skill before making it available to agents.",
	});
export const skillUpdateSchema = z.strictObject({
	id,
	expectedVersion: z.number().int().positive().optional(),
	name: name.optional(),
	slug: slug.optional(),
	description: description.optional(),
	content: content.optional(),
	category: z.string().trim().min(1).max(100).nullable().optional(),
	tags: tags.optional(),
});
export const skillArchiveSchema = z.strictObject({
	id,
	expectedVersion: z.number().int().positive().optional(),
});
export const skillRestoreSchema = skillArchiveSchema;
export const skillDeleteSchema = skillArchiveSchema;
export const skillPublishSchema = z.strictObject({
	id,
	expectedVersion: z.number().int().positive(),
	availability: z.enum(["draft", "members", "agents"]),
});
export const skillGovernanceModeSchema = z.enum([
	"permitted_members",
	"administrators",
]);
export const skillGovernancePolicySchema = z.strictObject({
	create: skillGovernanceModeSchema,
	publish: skillGovernanceModeSchema,
	discover: skillGovernanceModeSchema,
});
export const skillGovernanceReadSchema = z.strictObject({});
export const skillGovernanceUpdateSchema = z.strictObject({
	expectedRevision: z.number().int().min(0),
	policy: skillGovernancePolicySchema,
});
export const skillCapabilitiesSchema = z.strictObject({
	canEdit: z.boolean(),
	canArchive: z.boolean(),
	canRestore: z.boolean(),
	canPublish: z.boolean(),
	canDiscover: z.boolean(),
	canUnpublish: z.boolean(),
	canDelete: z.boolean(),
});
export const skillFileManifestSchema = z.strictObject({
	path: z.string().min(1).max(1024),
	contentType: z.string().min(1).max(200),
	sizeBytes: z.number().int().nonnegative(),
	version: z.number().int().positive(),
});
export const skillDtoSchema = z.strictObject({
	id,
	slug: z.string(),
	name: z.string(),
	description: z.string(),
	content: z.string().optional(),
	category: z.string().nullable(),
	tags: z.array(z.string()),
	scope: z.enum(["SYSTEM", "ORGANIZATION"]),
	userId: z.string().nullable(),
	organizationId: z.string().nullable(),
	version: z.number().int().positive(),
	isPublished: z.boolean(),
	isDiscoverable: z.boolean(),
	archivedAt: z.string().nullable(),
	createdAt: z.string(),
	updatedAt: z.string(),
	useCount: z.number().int().nonnegative(),
	availability: skillAvailabilitySchema,
	files: z.array(skillFileManifestSchema),
	fileManifestComplete: z.boolean(),
	capabilities: skillCapabilitiesSchema,
});
export const skillDetailDtoSchema = skillDtoSchema.extend({
	content: z.string(),
});
export const skillListResultSchema = z.strictObject({
	skills: z.array(skillDtoSchema),
	total: z.number().int().nonnegative(),
	hasMore: z.boolean(),
	nextCursor: z.string().nullable(),
});
export const skillGetResultSchema = z.strictObject({
	skill: skillDetailDtoSchema,
});
export const skillGovernanceResultSchema = z.strictObject({
	policy: skillGovernancePolicySchema,
	revision: z.number().int().nonnegative(),
	canManage: z.boolean(),
	capabilities: z.strictObject({
		canCreate: z.boolean(),
		canPublish: z.boolean(),
		canDiscover: z.boolean(),
	}),
});
export interface SkillActor {
	userId: string;
	organizationId: string;
	external?: boolean;
}
export type SkillDTO = z.infer<typeof skillDtoSchema>;
export type SkillDetailDTO = z.infer<typeof skillDetailDtoSchema>;
export type SkillGovernancePolicy = z.infer<typeof skillGovernancePolicySchema>;
export type SkillGovernanceResult = z.infer<typeof skillGovernanceResultSchema>;
export class SkillError extends Error {
	constructor(
		readonly code:
			| "BAD_REQUEST"
			| "FORBIDDEN"
			| "NOT_FOUND"
			| "CONFLICT"
			| "SERVICE_UNAVAILABLE",
		message: string,
	) {
		super(message);
		this.name = "SkillError";
	}
}
