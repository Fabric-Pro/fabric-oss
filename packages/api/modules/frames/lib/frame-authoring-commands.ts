import type { FrameReviewActor } from "@repo/database";
import {
	canCreateOrganizationFrames,
	canReadOrganizationFrames,
	createFrame,
	createFrameTemplate,
	db,
	FrameReviewError,
	getFrameById,
	getFrameTemplateById,
	getFrameTemplateCategories,
	listFrameTemplates,
	recordAuditTx,
} from "@repo/database";
import { frameMetadata } from "@repo/database/prisma/queries/frame-approved-revisions";
import { projectPlacementRefusal } from "@repo/database/prisma/queries/projects/project-placement";
import { contentIdentity } from "@repo/utils/content-identity";
import {
	type FrameAuthoringDocument,
	frameAuthoringDocumentSchema,
	frameCreateSchema,
	frameFromTemplateSchema,
	frameTemplateCreateSchema,
	frameTemplateVariableSchema,
	renderFrameTemplate,
	stableFrameInput,
	validateFrameAuthoringDocument,
} from "@repo/utils/frame-authoring";
import { z } from "zod";

async function permission(actor: FrameReviewActor, write = false) {
	if (
		!actor.organizationId ||
		!actor.userId ||
		!(await (write
			? canCreateOrganizationFrames
			: canReadOrganizationFrames)(actor.userId, actor.organizationId))
	) {
		throw new FrameReviewError(
			"FORBIDDEN",
			"Your current role cannot perform this page operation.",
		);
	}
}
const identifier = z.string().min(1).max(200);
export async function createAuthoredFrame(
	actor: FrameReviewActor,
	raw: unknown,
) {
	const input = frameCreateSchema.parse(raw);
	await permission(actor, true);
	const projectId = input.projectId;
	if (input.conversationId) {
		const conversation = await db.agentConversation.findFirst({
			where: {
				id: input.conversationId,
				userId: actor.userId,
				organizationId: actor.organizationId,
			},
			select: { id: true },
		});
		if (!conversation) {
			throw new FrameReviewError("NOT_FOUND", "Conversation not found.");
		}
	}
	if (actor.boundProjectId && projectId !== actor.boundProjectId) {
		throw new FrameReviewError("NOT_FOUND", "Project not found.");
	}
	if (projectId) {
		const refused = await projectPlacementRefusal({ ...actor, projectId });
		if (refused) {
			throw new FrameReviewError(
				refused === "not_found" ? "NOT_FOUND" : "FORBIDDEN",
				"This project is not available for creating a page.",
			);
		}
	}
	const {
		requestId,
		conversationId,
		projectId: _project,
		...document
	} = input;
	const validation = validateFrameAuthoringDocument(document);
	if (!validation.canSave) {
		throw new FrameReviewError(
			"BAD_REQUEST",
			"Review the page structure and JSON syntax before saving.",
		);
	}
	const requestHash = contentIdentity(
		stableFrameInput({ ...input, projectId }),
	);
	const id = `frame-${contentIdentity(JSON.stringify([actor.organizationId, actor.userId, requestId]))}`;
	const existing = await db.agentWorkspaceFile.findFirst({
		where: {
			id,
			userId: actor.userId,
			organizationId: actor.organizationId,
		},
	});
	if (existing) {
		if (
			frameMetadata(existing.metadata).creationRequestHash !== requestHash
		) {
			throw new FrameReviewError(
				"CONFLICT",
				"This request ID already identifies a different page.",
			);
		}
		const frame = await getFrameById({
			id,
			userId: actor.userId,
			organizationId: actor.organizationId,
		});
		if (!frame) {
			throw new FrameReviewError("NOT_FOUND", "Page not found.");
		}
		return { ...frame, shareToken: null, replayed: true };
	}
	try {
		return await db.$transaction(async (tx) => {
			const frame = await createFrame(
				{
					...document,
					id,
					creationRequestHash: requestHash,
					userId: actor.userId,
					organizationId: actor.organizationId,
					projectId,
					conversationId,
					shareScope: "PRIVATE",
					surface: projectId ? "artifact" : undefined,
					sourceRunType: "FRAME_AUTHORING",
				},
				tx,
			);
			await recordAuditTx(tx, {
				action: "frame.created",
				organizationId: actor.organizationId,
				actor: {
					type: actor.auditActorType ?? "user",
					userId: actor.userId,
				},
				resource: { type: "frame", id: frame.id },
				projectId: projectId ?? null,
				metadata: {
					privateDraft: true,
					transport: actor.transport ?? "portal",
				},
			});
			return { ...frame, shareToken: null, replayed: false };
		});
	} catch (e) {
		if (e && typeof e === "object" && "code" in e && e.code === "P2002") {
			const frame = await getFrameById({
				id,
				userId: actor.userId,
				organizationId: actor.organizationId,
			});
			const receipt = await db.agentWorkspaceFile.findFirst({
				where: {
					id,
					userId: actor.userId,
					organizationId: actor.organizationId,
				},
				select: { metadata: true },
			});
			if (
				frame &&
				frameMetadata(receipt?.metadata).creationRequestHash ===
					requestHash
			) {
				return { ...frame, shareToken: null, replayed: true };
			}
		}
		throw e;
	}
}
export async function validateAuthoredFrame(
	actor: FrameReviewActor,
	raw: unknown,
) {
	await permission(actor);
	return validateFrameAuthoringDocument(raw);
}
export async function listAuthoredFrameTemplates(
	actor: FrameReviewActor,
	raw: unknown = {},
) {
	await permission(actor);
	const input = z
		.strictObject({
			category: z.string().max(100).optional(),
			includeSystem: z.boolean().default(true),
		})
		.parse(raw);
	const [templates, categories] = await Promise.all([
		listFrameTemplates({ organizationId: actor.organizationId, ...input }),
		getFrameTemplateCategories(actor.organizationId),
	]);
	return {
		templates: templates.map((t) => ({
			id: t.id,
			name: t.name,
			description: t.description ?? null,
			category: t.category,
			variables: t.variables ?? null,
			isSystem: t.isSystem,
			createdAt: t.createdAt.toISOString(),
		})),
		categories,
	};
}
export async function getAuthoredFrameTemplate(
	actor: FrameReviewActor,
	id: string,
) {
	await permission(actor);
	identifier.parse(id);
	const t = await getFrameTemplateById(id);
	if (!t || (!t.isSystem && t.organizationId !== actor.organizationId)) {
		throw new FrameReviewError("NOT_FOUND", "Template not found.");
	}
	const content = frameAuthoringDocumentSchema.parse({
		title: t.content.title,
		description: t.content.description,
		kind: t.content.kind,
		presentation: t.content.presentation,
		blocks: t.content.blocks,
		theme: t.content.theme
			? {
					mode: t.content.theme.mode,
					accentColor: t.content.theme.accentColor,
				}
			: undefined,
	});
	return {
		...t,
		content,
		variables: t.variables ?? {},
		createdAt: t.createdAt.toISOString(),
		updatedAt: t.updatedAt.toISOString(),
	};
}
export async function createAuthoredFrameFromTemplate(
	actor: FrameReviewActor,
	raw: unknown,
) {
	const input = frameFromTemplateSchema.parse(raw);
	await permission(actor, true);
	const template = await getAuthoredFrameTemplate(actor, input.templateId);
	let content: FrameAuthoringDocument;
	try {
		const variables = z
			.record(z.string(), frameTemplateVariableSchema)
			.parse(template.variables);
		content = renderFrameTemplate(
			template.content,
			variables,
			input.variables,
		);
	} catch {
		throw new FrameReviewError(
			"BAD_REQUEST",
			"Template inputs are missing or invalid. Check required fields, choices and JSON content.",
		);
	}
	return createAuthoredFrame(actor, {
		...content,
		requestId: input.requestId,
		projectId: input.projectId,
		conversationId: input.conversationId,
		title: input.title ?? content.title,
		description: input.description ?? content.description,
	});
}
export async function createAuthoredFrameTemplate(
	actor: FrameReviewActor,
	raw: unknown,
) {
	const input = frameTemplateCreateSchema.parse(raw);
	await permission(actor, true);
	if (actor.boundProjectId) {
		throw new FrameReviewError(
			"FORBIDDEN",
			"Organization templates require an organization connection.",
		);
	}
	const samples = Object.fromEntries(
		Object.entries(input.variables).map(([key, v]) => [
			key,
			v.default ??
				(v.type === "boolean"
					? false
					: v.type === "number"
						? 0
						: v.type === "select"
							? (v.options?.[0] ?? "")
							: "Example"),
		]),
	);
	try {
		renderFrameTemplate(input.content, input.variables, samples);
	} catch {
		throw new FrameReviewError(
			"BAD_REQUEST",
			"Template variables must match the declared text or JSON inputs.",
		);
	}
	const id = `frame-template-${contentIdentity(JSON.stringify([actor.organizationId, actor.userId, input.requestId]))}`;
	const existing = await getFrameTemplateById(id);
	const same = (t: NonNullable<typeof existing>) =>
		t.organizationId === actor.organizationId &&
		t.name === input.name &&
		(t.description ?? "") === (input.description ?? "") &&
		t.category === input.category &&
		stableFrameInput(t.content) ===
			stableFrameInput({ version: 1, ...input.content }) &&
		stableFrameInput(t.variables ?? {}) ===
			stableFrameInput(input.variables);
	if (existing) {
		if (!same(existing)) {
			throw new FrameReviewError(
				"CONFLICT",
				"This request ID already identifies a different template.",
			);
		}
		return {
			...existing,
			createdAt: existing.createdAt.toISOString(),
			updatedAt: existing.updatedAt.toISOString(),
			replayed: true,
		};
	}
	try {
		return await db.$transaction(async (tx) => {
			const template = await createFrameTemplate(
				{
					id,
					organizationId: actor.organizationId,
					name: input.name,
					description: input.description,
					category: input.category,
					content: { version: 1, ...input.content },
					variables: input.variables,
					isSystem: false,
				},
				tx,
			);
			// The template is explicitly organization-wide. No saved page, brand snapshot or authority is copied.
			await recordAuditTx(tx, {
				action: "frame.template_created",
				organizationId: actor.organizationId,
				actor: {
					type: actor.auditActorType ?? "user",
					userId: actor.userId,
				},
				resource: { type: "frame", id: template.id },
				metadata: {
					organizationWide: true,
					transport: actor.transport ?? "portal",
				},
			});
			return {
				...template,
				createdAt: template.createdAt.toISOString(),
				updatedAt: template.updatedAt.toISOString(),
				replayed: false,
			};
		});
	} catch (error) {
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "P2002"
		) {
			const replay = await getFrameTemplateById(id);
			if (replay && same(replay)) {
				return {
					...replay,
					createdAt: replay.createdAt.toISOString(),
					updatedAt: replay.updatedAt.toISOString(),
					replayed: true,
				};
			}
			throw new FrameReviewError(
				"CONFLICT",
				"This request ID already identifies a different template.",
			);
		}
		throw error;
	}
}
