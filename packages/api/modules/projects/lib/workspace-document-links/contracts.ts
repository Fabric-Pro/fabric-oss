import { z } from "zod";

const id = z.string().trim().min(1).max(200);
export const workspaceLinkActorSchema = z.strictObject({
	userId: id,
	organizationId: id,
	projectId: id,
});
export type WorkspaceLinkActor = z.infer<typeof workspaceLinkActorSchema>;
export const workspaceLinkPageSchema = z.strictObject({
	limit: z.number().int().min(1).max(50).default(20),
	offset: z.number().int().min(0).max(2147483646).default(0),
});
export const addWorkspaceLinkSchema = z.strictObject({
	workspaceId: id,
	documentId: id,
	expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
});
export const workspaceLinkIdSchema = z.strictObject({ linkId: id });
export const readWorkspaceLinkSchema = workspaceLinkIdSchema.extend({
	offset: z.number().int().min(0).max(2147483646).default(0),
	limit: z.number().int().min(1).max(20000).default(12000),
	expectedRevision: z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.optional(),
});
export type WorkspaceLinkAvailability =
	| "CURRENT"
	| "UPDATED"
	| "PROCESSING"
	| "NEEDS_ATTENTION";
export interface WorkspaceLinkRecord {
	id: string;
	organizationId: string;
	projectId: string;
	documentId: string;
	addedByUserId: string;
	sourceRevisionAtLink: string;
	createdAt: Date;
	updatedAt: Date;
}
export interface WorkspaceLinkView {
	id: string;
	availability: WorkspaceLinkAvailability | "UNAVAILABLE";
	documentId?: string;
	workspaceId?: string;
	filename?: string;
	workspaceName?: string;
	sourceRevision?: string;
	sourceRevisionAtLink?: string;
	sourceUpdatedAt?: string;
	addedAt?: string;
	sourceKind: "workspace_document";
	contentRole: "reference_data";
	sharingGranted: false;
	indexedForProject: false;
}
export class WorkspaceLinkError extends Error {
	readonly status: 400 | 403 | 404 | 409 | 503;
	constructor(
		readonly code:
			| "INVALID_INPUT"
			| "FORBIDDEN"
			| "NOT_FOUND"
			| "STALE_REVISION"
			| "NOT_READY"
			| "UNAVAILABLE",
	) {
		const definitions = {
			INVALID_INPUT: [
				400,
				"Select a valid Workspace document and its inspected revision.",
			],
			FORBIDDEN: [
				403,
				"Current project and Workspace permissions are required for this action.",
			],
			NOT_FOUND: [404, "Document link not found or access denied."],
			STALE_REVISION: [
				409,
				"This document changed. Inspect its current revision and try again.",
			],
			NOT_READY: [
				409,
				"This document is still processing or needs attention in its Workspace.",
			],
			UNAVAILABLE: [
				503,
				"Workspace context could not be confirmed. Refresh before retrying.",
			],
		} as const;
		super(definitions[code][1]);
		this.name = "WorkspaceLinkError";
		this.status = definitions[code][0];
	}
}
