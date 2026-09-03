import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db, type Prisma } from "../client";
import type { AgentWorkspaceFile } from "../generated/client";

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
		})
		.optional(),
});

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
}

export interface UpdateFrameInput {
	id: string;
	userId: string;
	organizationId?: string;
	title?: string;
	description?: string;
	blocks?: FrameBlock[];
	theme?: FrameDocument["theme"];
	isPublic?: boolean;
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

function mapFrameRecord(file: AgentWorkspaceFile) {
	const document = parseFrameContent(file);
	return {
		id: file.id,
		conversationId: file.conversationId,
		userId: file.userId,
		organizationId: file.organizationId ?? undefined,
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
		document,
		createdAt: file.createdAt,
		updatedAt: file.updatedAt,
	};
}

export async function createFrame(input: CreateFrameInput) {
	const kind = input.kind ?? "frame";
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
		},
	});

	const content = JSON.stringify(document, null, 2);
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
			sourceRunType: input.sourceRunType,
			sourceRunId: input.sourceRunId,
			authoritySessionId: input.authoritySessionId,
			providerKeys: input.providerKeys ?? [],
			description: input.description,
			metadata: {
				frameVersion: 1,
			} as Prisma.InputJsonValue,
		},
	});

	return mapFrameRecord(file);
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

export async function listFrames(input: {
	userId: string;
	organizationId?: string;
	conversationId?: string;
	limit?: number;
	offset?: number;
}) {
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

export async function updateFrame(input: UpdateFrameInput) {
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

	const current = parseFrameContent(existing);
	const nextDocument = FrameDocumentSchema.parse({
		...current,
		title: input.title ?? current.title,
		description: input.description ?? current.description,
		blocks: input.blocks ?? current.blocks,
		theme: input.theme ?? current.theme,
		metadata: {
			...current.metadata,
		},
	});
	const content = JSON.stringify(nextDocument, null, 2);

	const updated = await db.agentWorkspaceFile.update({
		where: { id: existing.id },
		data: {
			name: `${nextDocument.title}.frame.json`,
			content,
			size: Buffer.byteLength(content, "utf8"),
			description: nextDocument.description,
			isPublic: input.isPublic ?? existing.isPublic,
		},
	});

	return mapFrameRecord(updated);
}

export async function publishFrame(input: {
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
