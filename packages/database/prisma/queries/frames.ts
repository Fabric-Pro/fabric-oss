import { randomUUID } from "node:crypto";
import { throwIfDispatchStopped } from "@repo/utils/dispatch-guard";
import { FRAME_SURFACES, type FrameSurface } from "@repo/utils/frame-surfaces";
import { z } from "zod";
import { db, type Prisma } from "../client";
import type {
	AgentFileType,
	AgentWorkspaceFile,
	FrameShareScope,
} from "../generated/client";
import { saveFrameEdit } from "./frame-edit-history";
import { checkFrameAccess } from "./frame-sharing";
import {
	type ProjectPlacementRefusal,
	projectPlacementRefusal,
} from "./projects/project-placement";
import {
	getProjectAccessContext,
	isProjectSoftDeleted,
} from "./projects/projects";
import { isOrganizationMember } from "./verify-organization-membership";

export const FABRIC_FRAME_CONTENT_TYPE = "application/vnd.fabric.frame";
export const FABRIC_FRAME_SLIDESHOW_CONTENT_TYPE =
	"application/vnd.fabric.frame.slideshow";

export const FrameBlockSchema = z.object({
	id: z.string(),
	type: z.enum(["html", "json", "mermaid", "markdown"]),
	title: z.string().optional(),
	content: z.string(),
	language: z.string().optional(),
});

export const FrameDocumentSchema = z.object({
	version: z.literal(1),
	kind: z.enum(["frame", "slideshow"]),
	title: z.string(),
	description: z.string().optional(),
	blocks: z.array(FrameBlockSchema).min(1),
	theme: z
		.object({
			mode: z.enum(["light", "dark", "system"]).optional(),
			accentColor: z.string().optional(),
		})
		.optional(),
	metadata: z
		.object({
			format: z.enum(["html", "json", "mermaid", "markdown"]).optional(),
			generatedByTool: z.string().optional(),
			conversationId: z.string().optional(),
			authoritySessionId: z.string().optional(),
			providerKeys: z.array(z.string()).optional(),
			sourceRunType: z.string().optional(),
			sourceRunId: z.string().optional(),
			/**
			 * Fabric MCP tools the frame's own script may call through the host
			 * page runtime (`window.fabric.call`). Versioned with the content,
			 * because the content is what calls them.
			 */
			runtime: z
				.object({ tools: z.array(z.string().min(1)).max(50) })
				.optional(),
		})
		.optional(),
});

/**
 * Where a frame is shown: a project's Artifacts tab, or an organization
 * Workspace. Stored on the row's `metadata` so lists can filter on it; absent
 * for frames that predate surfaces.
 */
export { FRAME_SURFACES, type FrameSurface };

function readMetadataObject(metadata: unknown): Record<string, unknown> {
	return metadata && typeof metadata === "object" && !Array.isArray(metadata)
		? (metadata as Record<string, unknown>)
		: {};
}

function readFrameSurface(metadata: unknown): FrameSurface | undefined {
	const surface = readMetadataObject(metadata).surface;
	return FRAME_SURFACES.find((value) => value === surface);
}

export type FrameBlock = z.infer<typeof FrameBlockSchema>;
export type FrameDocument = z.infer<typeof FrameDocumentSchema>;

export interface CreateFrameInput {
	userId: string;
	organizationId?: string;
	conversationId?: string;
	title: string;
	description?: string;
	kind?: "frame" | "slideshow";
	blocks: FrameBlock[];
	theme?: FrameDocument["theme"];
	sourceRunType?: string;
	sourceRunId?: string;
	authoritySessionId?: string;
	providerKeys?: string[];
	isPublic?: boolean;
	/**
	 * Project-scoped frame (plan Slice 3, spike demos). When set the frame is
	 * readable by the project's members, not only its creator (tenant
	 * carve-out in `tenant-db.ts` + `frame_project_or_user` RLS); the API
	 * layer still checks project access. Defaults `shareScope` to PROJECT.
	 */
	projectId?: string;
	/** Story the frame is evidence for; requires `projectId`. */
	storyId?: string;
	shareScope?: FrameShareScope;
	surface?: FrameSurface;
	/** Fabric MCP tools the frame's script may call; see `runtime` above. */
	runtimeTools?: string[];
	/**
	 * The step inside the run that produced the frame, kept on the row so a
	 * retried step finds its own frame again (see `findFrameForSourceRun`).
	 */
	sourceNodeId?: string;
}

export interface UpdateFrameInput {
	id: string;
	userId: string;
	organizationId?: string;
	projectId?: string;
	title?: string;
	description?: string;
	blocks?: FrameBlock[];
	theme?: FrameDocument["theme"];
	isPublic?: boolean;
	runtimeTools?: string[];
	surface?: FrameSurface;
}

function getFrameFileType(kind: "frame" | "slideshow") {
	return kind === "slideshow" ? "SLIDESHOW" : "FRAME";
}

function getFrameContentType(kind: "frame" | "slideshow") {
	return kind === "slideshow"
		? FABRIC_FRAME_SLIDESHOW_CONTENT_TYPE
		: FABRIC_FRAME_CONTENT_TYPE;
}

function buildFramePath(title: string, kind: "frame" | "slideshow") {
	// Bounded span: js/polynomial-redos — `title` has no zod max() bound
	// upstream; cap comfortably above any real title before the slug
	// regexes run (the slug itself is already sliced to 60 chars below).
	const MAX_TITLE_CHARS = 200;
	const slug = title
		.slice(0, MAX_TITLE_CHARS)
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
	const safeSlug = slug || kind;
	return `/frames/${safeSlug}-${Date.now()}.frame.json`;
}

function parseFrameContent(
	file: Pick<AgentWorkspaceFile, "content">,
): FrameDocument {
	const parsed = JSON.parse(file.content) as unknown;
	return FrameDocumentSchema.parse(parsed);
}

export type FrameRecord = ReturnType<typeof mapFrameRecord>;

function mapFrameRecord(file: AgentWorkspaceFile) {
	const document = parseFrameContent(file);
	return {
		id: file.id,
		conversationId: file.conversationId,
		userId: file.userId,
		organizationId: file.organizationId ?? undefined,
		projectId: file.projectId ?? undefined,
		storyId: file.storyId ?? undefined,
		path: file.path,
		name: file.name,
		title: document.title,
		description: document.description,
		kind: document.kind,
		contentType: file.mimeType || getFrameContentType(document.kind),
		fileType: file.fileType,
		status: file.status,
		version: file.version,
		isPublic: file.isPublic,
		shareToken: file.shareToken,
		shareScope: file.shareScope,
		sourceRunType: file.sourceRunType,
		sourceRunId: file.sourceRunId,
		authoritySessionId: file.authoritySessionId,
		providerKeys: file.providerKeys,
		surface: readFrameSurface(file.metadata),
		runtimeTools: document.metadata?.runtime?.tools ?? [],
		document,
		createdAt: file.createdAt,
		updatedAt: file.updatedAt,
	};
}

export async function createFrame(input: CreateFrameInput) {
	const kind = input.kind ?? "frame";
	if (input.storyId && !input.projectId) {
		throw new Error("storyId requires projectId on a frame");
	}
	const document = FrameDocumentSchema.parse({
		version: 1,
		kind,
		title: input.title,
		description: input.description,
		blocks: input.blocks,
		theme: input.theme,
		metadata: {
			generatedByTool: "fabric_create_frame",
			conversationId: input.conversationId,
			authoritySessionId: input.authoritySessionId,
			providerKeys: input.providerKeys ?? [],
			sourceRunType: input.sourceRunType,
			sourceRunId: input.sourceRunId,
			runtime: input.runtimeTools
				? { tools: input.runtimeTools }
				: undefined,
		},
	});

	const content = JSON.stringify(document, null, 2);
	// Immediately before the write: inside an Advisor chat turn that has
	// stopped, nothing is created (the ambient dispatch guard; a no-op
	// outside a turn).
	throwIfDispatchStopped();
	const file = await db.agentWorkspaceFile.create({
		data: {
			conversationId: input.conversationId,
			userId: input.userId,
			organizationId: input.organizationId ?? null,
			path: buildFramePath(input.title, kind),
			name: `${input.title}.frame.json`,
			extension: "json",
			mimeType: getFrameContentType(kind),
			content,
			size: Buffer.byteLength(content, "utf8"),
			fileType: getFrameFileType(kind),
			status: "COMPLETE",
			shareToken: input.isPublic ? randomUUID() : null,
			isPublic: input.isPublic ?? false,
			projectId: input.projectId ?? null,
			storyId: input.storyId ?? null,
			shareScope:
				input.shareScope ?? (input.projectId ? "PROJECT" : undefined),
			sourceRunType: input.sourceRunType,
			sourceRunId: input.sourceRunId,
			authoritySessionId: input.authoritySessionId,
			providerKeys: input.providerKeys ?? [],
			description: input.description,
			metadata: {
				frameVersion: 1,
				...(input.surface ? { surface: input.surface } : {}),
				...(input.sourceNodeId
					? { sourceNodeId: input.sourceNodeId }
					: {}),
			} as Prisma.InputJsonValue,
		},
	});

	return mapFrameRecord(file);
}

/** A copy was refused a project: `not_found` for one that is not the caller's to see, `not_editable` for one they can open and not change. */
export class FramePlacementRefusedError extends Error {
	readonly refusal: ProjectPlacementRefusal;
	constructor(refusal: ProjectPlacementRefusal) {
		super(`The project does not take the copy (${refusal})`);
		this.name = "FramePlacementRefusedError";
		this.refusal = refusal;
	}
}

/**
 * A copy of a page for `userId`, the one command behind "duplicate" in the app
 * and "fork" for the Fabric Agent. The copy has the original's content (every
 * block under a new id), kind and theme, and stays where the original is shown:
 * same surface, same project. It is private to its owner, with no public link,
 * and declares no tools unless `runtimeTools` is passed, so duplicating a page
 * never carries its capabilities along unasked. Page data is not copied.
 *
 * A copy in a project is a thing put into that project, so it is held to the
 * project's own rule for that (`projectPlacementRefusal`: the project is the
 * organization's, not in the trash, and one the user may edit) and refused with
 * `FramePlacementRefusedError` otherwise, for the app's duplicate and the
 * agent's fork alike. Who may open and copy the original, and whether the role
 * may create frames at all, is the caller's to decide before calling this; so
 * is where the copy says it came from (`conversationId`, `sourceRun*`,
 * `authoritySessionId`, `providerKeys`), which the original's values would
 * misstate for a different owner.
 */
export async function duplicateFrame(input: {
	original: FrameRecord;
	userId: string;
	organizationId?: string;
	title?: string;
	runtimeTools?: string[];
	conversationId?: string;
	sourceRunType?: string;
	sourceRunId?: string;
	authoritySessionId?: string;
	providerKeys?: string[];
}) {
	const { original } = input;
	if (original.projectId) {
		const refusal = input.organizationId
			? await projectPlacementRefusal({
					userId: input.userId,
					organizationId: input.organizationId,
					projectId: original.projectId,
				})
			: "not_found";
		if (refusal) {
			throw new FramePlacementRefusedError(refusal);
		}
	}
	return createFrame({
		userId: input.userId,
		organizationId: input.organizationId,
		conversationId: input.conversationId,
		title: input.title ?? `${original.title} (Copy)`,
		description: original.description,
		kind: original.kind,
		blocks: original.document.blocks.map((block) => ({
			...block,
			id: `block-${randomUUID()}`,
		})),
		theme: original.document.theme,
		sourceRunType: input.sourceRunType,
		sourceRunId: input.sourceRunId,
		authoritySessionId: input.authoritySessionId,
		providerKeys: input.providerKeys,
		isPublic: false,
		projectId: original.projectId,
		surface: original.surface,
		runtimeTools: input.runtimeTools,
	});
}

/**
 * The frame one step of one run already created, so a retried step reuses it
 * instead of writing a second. Scoped to the creator and tenant like
 * `getFrameById`; `projectId` null means a frame outside any project.
 */
export async function findFrameForSourceRun(input: {
	userId: string;
	organizationId: string;
	projectId: string | null;
	sourceRunType: string;
	sourceRunId: string;
	sourceNodeId: string;
}) {
	const file = await db.agentWorkspaceFile.findFirst({
		where: {
			userId: input.userId,
			organizationId: input.organizationId,
			projectId: input.projectId,
			sourceRunType: input.sourceRunType,
			sourceRunId: input.sourceRunId,
			fileType: "FRAME",
			metadata: { path: ["sourceNodeId"], equals: input.sourceNodeId },
		},
		orderBy: { createdAt: "asc" },
	});
	return file ? mapFrameRecord(file) : null;
}

export async function getFrameById(input: {
	id: string;
	userId: string;
	organizationId?: string;
}) {
	const file = await db.agentWorkspaceFile.findFirst({
		where: {
			id: input.id,
			userId: input.userId,
			organizationId: input.organizationId ?? null,
			fileType: { in: ["FRAME", "SLIDESHOW"] },
		},
	});
	return file ? mapFrameRecord(file) : null;
}

/**
 * Read a project-scoped frame by id regardless of creator. Only frames with
 * a `projectId` are returned; callers MUST verify the caller's access to
 * that project (`hasProjectAccess`) before returning the record. Pass
 * `projectId` to pin the lookup to a known project.
 */
export async function getProjectFrameById(input: {
	id: string;
	projectId?: string;
}) {
	const file = await db.agentWorkspaceFile.findFirst({
		where: {
			id: input.id,
			projectId: input.projectId ?? { not: null },
			fileType: { in: ["FRAME", "SLIDESHOW"] },
		},
	});
	return file ? mapFrameRecord(file) : null;
}

/**
 * Frames attached to a story (spike demos). Project-scoped, not
 * creator-scoped: the caller must hold STORY_READ on the project.
 */
export async function listFramesForStory(input: {
	projectId: string;
	storyId: string;
	limit?: number;
}) {
	const files = await db.agentWorkspaceFile.findMany({
		where: {
			projectId: input.projectId,
			storyId: input.storyId,
			fileType: { in: ["FRAME", "SLIDESHOW"] },
		},
		orderBy: { createdAt: "desc" },
		take: input.limit ?? 50,
	});
	return files.map(mapFrameRecord);
}

export async function listFrames(input: {
	userId: string;
	organizationId?: string;
	conversationId?: string;
	limit?: number;
	offset?: number;
}) {
	// "My frames": exact creator + tenant ownership. Project frames created
	// by others are deliberately excluded here (they surface through
	// `listFramesForStory`); the explicit `userId` predicate keeps the
	// tenant carve-out for project frames from widening this list.
	const files = await db.agentWorkspaceFile.findMany({
		where: {
			userId: input.userId,
			organizationId: input.organizationId ?? null,
			conversationId: input.conversationId,
			fileType: { in: ["FRAME", "SLIDESHOW"] },
		},
		orderBy: { updatedAt: "desc" },
		take: input.limit ?? 50,
		skip: input.offset ?? 0,
	});
	return files.map(mapFrameRecord);
}

/*
 * Surface reads (project Artifacts tab, organization Workspaces).
 *
 * These use the direct client, not the tenant-extended one, for the same reason
 * `checkFrameAccess` does: the RLS policy `frame_project_or_user` knows only the
 * creator and project members, and a Workspace shared with the organization
 * (`WORKSPACE_AND_EMAILS`) is neither. Every query below therefore carries its
 * own organization predicate and never returns a row of another organization;
 * access inside the organization is decided here, in the same three arms as the
 * policy and `checkFrameAccess`: the creator, the project's accepted members,
 * and organization members for a frame shared with the organization.
 */

const FRAME_FILE_TYPES: { in: AgentFileType[] } = {
	in: ["FRAME", "SLIDESHOW"],
};
const SURFACE_LIST_DEFAULT_LIMIT = 50;

/**
 * What a user may see in an organization, which both surface lists start from:
 * whether they are a member of it, and the projects they can open.
 */
async function readAccessScope(input: {
	userId: string;
	organizationId: string;
}): Promise<{ isMember: boolean; projectIds: string[] }> {
	const isMember = await isOrganizationMember(
		input.userId,
		input.organizationId,
	);
	const projectIds = await listAccessibleProjectIds({
		userId: input.userId,
		organizationId: input.organizationId,
		isOrganizationMember: isMember,
	});
	return { isMember, projectIds };
}

/**
 * The organization's projects the user can open, by the rule
 * `getProjectAccessContext` applies to one: an organization member needs to own
 * the project or hold an accepted, unexpired membership; a guest, who is not an
 * organization member, needs the membership. Trashed projects are left out.
 */
async function listAccessibleProjectIds(input: {
	userId: string;
	organizationId: string;
	isOrganizationMember: boolean;
}): Promise<string[]> {
	const activeMembership = {
		some: {
			userId: input.userId,
			acceptedAt: { not: null },
			OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
		},
	};
	const projects = await db.project.findMany({
		where: {
			organizationId: input.organizationId,
			deletedAt: null,
			OR: [
				...(input.isOrganizationMember
					? [{ userId: input.userId }]
					: []),
				{ members: activeMembership },
			],
		},
		select: { id: true },
	});
	return projects.map((project) => project.id);
}

/**
 * The organization's Workspaces the user may see: their own, those shared with
 * the organization (`WORKSPACE_AND_EMAILS`) when the user is an organization
 * member, and those linked to a project the user can open. Email-only
 * invitations are not listed; they open from the invitation link.
 */
export async function listWorkspaceFrames(input: {
	userId: string;
	organizationId: string;
	projectId?: string;
	limit?: number;
	offset?: number;
}) {
	const { isMember, projectIds } = await readAccessScope(input);
	const files = await db.agentWorkspaceFile.findMany({
		where: {
			organizationId: input.organizationId,
			fileType: FRAME_FILE_TYPES,
			metadata: { path: ["surface"], equals: "workspace" },
			...(input.projectId ? { projectId: input.projectId } : {}),
			OR: [
				{ userId: input.userId },
				...(isMember
					? [{ shareScope: "WORKSPACE_AND_EMAILS" as const }]
					: []),
				...(projectIds.length > 0
					? [{ projectId: { in: projectIds } }]
					: []),
			],
		},
		orderBy: { updatedAt: "desc" },
		take: input.limit ?? SURFACE_LIST_DEFAULT_LIMIT,
		skip: input.offset ?? 0,
	});
	return files.map(mapFrameRecord);
}

/**
 * The condition that keeps a project's frames to one surface, asked in the
 * query so a long list of the other surface cannot push the newest frames of
 * this one out of the read.
 *
 * A Workspace is marked on its row, and a JSON path predicate can ask for that
 * mark. "Not marked" it cannot ask for: SQL compares a missing key to NULL, and
 * `NOT` of NULL drops the row. An artifact is therefore "not a Workspace", read
 * as the set of Workspaces among these frames and left out by id, which also
 * keeps the frames from before surfaces existed: a project's own frames with no
 * surface are its artifacts (spike demos are the first of them).
 */
async function surfaceCondition(
	scope: Prisma.AgentWorkspaceFileWhereInput,
	surface: FrameSurface | undefined,
): Promise<Prisma.AgentWorkspaceFileWhereInput> {
	if (surface === undefined) {
		return {};
	}
	const isWorkspace: Prisma.AgentWorkspaceFileWhereInput = {
		metadata: { path: ["surface"], equals: "workspace" },
	};
	if (surface === "workspace") {
		return isWorkspace;
	}
	const workspaces = await db.agentWorkspaceFile.findMany({
		where: { ...scope, ...isWorkspace },
		select: { id: true },
	});
	return workspaces.length > 0
		? { id: { notIn: workspaces.map((file) => file.id) } }
		: {};
}

/**
 * Frames of the projects the user can open, newest first: one project when
 * `projectId` is given (and the user can open it), otherwise all of them.
 * `surface: "artifact"` includes project frames that predate surfaces.
 */
export async function listProjectFrames(input: {
	userId: string;
	organizationId: string;
	projectId?: string;
	surface?: FrameSurface;
	limit?: number;
}) {
	const { projectIds: accessible } = await readAccessScope(input);
	const projectIds = input.projectId
		? accessible.filter((id) => id === input.projectId)
		: accessible;
	if (projectIds.length === 0) {
		return [];
	}
	const scope: Prisma.AgentWorkspaceFileWhereInput = {
		organizationId: input.organizationId,
		projectId: { in: projectIds },
		fileType: FRAME_FILE_TYPES,
	};
	const files = await db.agentWorkspaceFile.findMany({
		where: { ...scope, ...(await surfaceCondition(scope, input.surface)) },
		orderBy: { updatedAt: "desc" },
		take: input.limit ?? SURFACE_LIST_DEFAULT_LIMIT,
	});
	return files.map(mapFrameRecord);
}

/**
 * One frame the user may open in `organizationId`, or null. The organization
 * must be the frame's own: a frame of another organization is not found
 * whatever its share scope. Beyond the creator, a project frame opens for the
 * project's accepted members, and a shared frame by its scope and grants.
 */
export async function getAccessibleFrameById(input: {
	id: string;
	userId: string;
	userEmail?: string;
	organizationId: string;
}) {
	const file = await db.agentWorkspaceFile.findFirst({
		where: {
			id: input.id,
			organizationId: input.organizationId,
			fileType: FRAME_FILE_TYPES,
		},
	});
	if (!file) {
		return null;
	}
	if (file.userId === input.userId) {
		return mapFrameRecord(file);
	}
	if (file.projectId) {
		// A trashed project is gone for the people who only had it through the
		// project; `getProjectAccessContext` does not say so, it is asked here.
		const [access, trashed] = await Promise.all([
			getProjectAccessContext(file.projectId, input.userId),
			isProjectSoftDeleted(file.projectId),
		]);
		if (access?.organizationId === input.organizationId && !trashed) {
			return mapFrameRecord(file);
		}
	}
	const shared = await checkFrameAccess({
		frameId: file.id,
		userId: input.userId,
		userEmail: input.userEmail,
		organizationId: input.organizationId,
		isOrgMember: await isOrganizationMember(
			input.userId,
			input.organizationId,
		),
	});
	return shared.hasAccess ? mapFrameRecord(file) : null;
}

export async function updateFrame(input: UpdateFrameInput) {
	const existing = await db.agentWorkspaceFile.findFirst({
		where: {
			id: input.id,
			userId: input.userId,
			organizationId: input.organizationId ?? null,
			projectId: input.projectId,
			fileType: { in: ["FRAME", "SLIDESHOW"] },
		},
	});

	if (!existing) {
		return null;
	}

	const current = parseFrameContent(existing);
	const nextDocument = FrameDocumentSchema.parse({
		...current,
		title: input.title ?? current.title,
		description: input.description ?? current.description,
		blocks: input.blocks ?? current.blocks,
		theme: input.theme ?? current.theme,
		metadata: {
			...current.metadata,
			...(input.runtimeTools
				? { runtime: { tools: input.runtimeTools } }
				: {}),
		},
	});
	const content = JSON.stringify(nextDocument, null, 2);

	// Immediately before the write, after the read above: inside an Advisor
	// chat turn that has stopped, nothing is written (the ambient dispatch
	// guard; a no-op outside a turn).
	throwIfDispatchStopped();
	// The history row and the update stand or fall together: a row for an edit
	// that never landed would be a version of the page nobody ever saw, and it
	// would shift the number of every version after it.
	const updated = await db.$transaction(async (tx) => {
		if (content !== existing.content) {
			await saveFrameEdit(
				{
					frameId: existing.id,
					editType: "full_update",
					contentSnapshot: existing.content,
					editedBy: input.userId,
				},
				tx,
			);
		}
		return tx.agentWorkspaceFile.update({
			where: { id: existing.id, projectId: input.projectId },
			data: {
				name: `${nextDocument.title}.frame.json`,
				content,
				size: Buffer.byteLength(content, "utf8"),
				description: nextDocument.description,
				isPublic: input.isPublic ?? existing.isPublic,
				...(input.surface
					? {
							metadata: {
								...readMetadataObject(existing.metadata),
								surface: input.surface,
							} as Prisma.InputJsonValue,
						}
					: {}),
			},
		});
	});

	return mapFrameRecord(updated);
}

export async function publishFrame(input: {
	id: string;
	userId: string;
	organizationId?: string;
	projectId?: string;
}) {
	const existing = await db.agentWorkspaceFile.findFirst({
		where: {
			id: input.id,
			userId: input.userId,
			organizationId: input.organizationId ?? null,
			projectId: input.projectId,
			fileType: { in: ["FRAME", "SLIDESHOW"] },
		},
	});
	if (!existing) {
		return null;
	}
	// Immediately before the write (see updateFrame).
	throwIfDispatchStopped();
	const updated = await db.agentWorkspaceFile.update({
		where: { id: existing.id, projectId: input.projectId },
		data: {
			isPublic: true,
			shareToken: existing.shareToken || randomUUID(),
		},
	});
	return mapFrameRecord(updated);
}

export async function revokeFrameShare(input: {
	id: string;
	userId: string;
	organizationId?: string;
}) {
	const existing = await db.agentWorkspaceFile.findFirst({
		where: {
			id: input.id,
			userId: input.userId,
			organizationId: input.organizationId ?? null,
			fileType: { in: ["FRAME", "SLIDESHOW"] },
		},
	});
	if (!existing) {
		return null;
	}
	const updated = await db.agentWorkspaceFile.update({
		where: { id: existing.id },
		data: {
			isPublic: false,
			shareToken: null,
		},
	});
	return mapFrameRecord(updated);
}

export async function getFrameByShareToken(token: string) {
	const file = await db.agentWorkspaceFile.findFirst({
		where: {
			shareToken: token,
			isPublic: true,
			fileType: { in: ["FRAME", "SLIDESHOW"] },
		},
	});
	return file ? mapFrameRecord(file) : null;
}

export async function deleteFrame(input: {
	id: string;
	userId: string;
	organizationId?: string;
}) {
	const existing = await db.agentWorkspaceFile.findFirst({
		where: {
			id: input.id,
			userId: input.userId,
			organizationId: input.organizationId ?? null,
			fileType: { in: ["FRAME", "SLIDESHOW"] },
		},
	});

	if (!existing) {
		return { success: false, error: "Frame not found" };
	}

	await db.agentWorkspaceFile.delete({
		where: { id: existing.id },
	});

	return { success: true };
}

/**
 * The pages still linked to a project that was deleted for good, split by what
 * becomes of them. A Workspace belongs to the organization and outlives the
 * project it was linked to; every other page (an artifact, or a page from
 * before surfaces existed) was the project's own.
 *
 * The page row has no foreign key to the project, so the project's delete does
 * not reach it. Reads only what the purge needs, never the content.
 */
export async function listFramesOfDeletedProject(projectId: string) {
	const files = await db.agentWorkspaceFile.findMany({
		where: { projectId, fileType: FRAME_FILE_TYPES },
		select: {
			id: true,
			userId: true,
			organizationId: true,
			metadata: true,
		},
		orderBy: { id: "asc" },
	});
	const workspaceFrameIds: string[] = [];
	const artifactFrames: {
		id: string;
		userId: string;
		organizationId: string | null;
	}[] = [];
	for (const { metadata, ...file } of files) {
		if (readFrameSurface(metadata) === "workspace") {
			workspaceFrameIds.push(file.id);
		} else {
			artifactFrames.push(file);
		}
	}
	return { workspaceFrameIds, artifactFrames };
}

/**
 * Unlinks the given pages from a project that no longer exists. Returns how
 * many rows changed, so a retry that finds them already unlinked reports zero.
 */
export async function detachFramesFromProject(input: {
	projectId: string;
	frameIds: string[];
}) {
	const result = await db.agentWorkspaceFile.updateMany({
		where: {
			id: { in: input.frameIds },
			projectId: input.projectId,
			fileType: FRAME_FILE_TYPES,
		},
		data: { projectId: null },
	});
	return result.count;
}

/**
 * Deletes one page of a deleted project, with its records and comments, which
 * cascade from the row. Bound to the project so a page that was moved out of
 * it in the meantime is left alone; a page already gone deletes zero rows.
 */
export async function deleteFrameOfDeletedProject(input: {
	projectId: string;
	frameId: string;
}) {
	const result = await db.agentWorkspaceFile.deleteMany({
		where: {
			id: input.frameId,
			projectId: input.projectId,
			fileType: FRAME_FILE_TYPES,
		},
	});
	return result.count;
}
