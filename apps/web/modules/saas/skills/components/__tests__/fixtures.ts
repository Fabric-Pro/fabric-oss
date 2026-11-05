import type {
	SkillDetailDTO,
	SkillGovernanceResult,
} from "@repo/ai/skill-contracts";
export const skill: SkillDetailDTO = {
	id: "example-skill",
	slug: "delivery-update",
	name: "Delivery update",
	description:
		"Use for project delivery updates with evidence and next steps.",
	content:
		"# Delivery update\n\nSummarize progress, evidence, risks and next steps.",
	category: "delivery",
	tags: ["reporting"],
	scope: "ORGANIZATION",
	organizationId: "example-org",
	userId: "example-user",
	version: 2,
	isPublished: false,
	isDiscoverable: false,
	archivedAt: null,
	createdAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-02T00:00:00Z",
	useCount: 0,
	availability: "draft",
	files: [],
	fileManifestComplete: true,
	capabilities: {
		canEdit: true,
		canArchive: true,
		canRestore: false,
		canPublish: true,
		canDiscover: true,
		canUnpublish: true,
		canDelete: true,
	},
};
export const governance: SkillGovernanceResult = {
	policy: {
		create: "permitted_members",
		publish: "administrators",
		discover: "administrators",
	},
	revision: 3,
	canManage: true,
	capabilities: { canCreate: true, canPublish: true, canDiscover: true },
};
export const context = {
	organizationId: "example-org",
	basePath: "/app/example-org",
};
