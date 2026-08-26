import { createFrame } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const frameBlockSchema = z.object({
	id: z.string(),
	type: z.enum(["html", "json", "mermaid", "markdown"]),
	title: z.string().optional(),
	content: z.string(),
	language: z.string().optional(),
});

const inputSchema = z.object({
	organizationId: z.string().nullable().optional(),
	conversationId: z.string().optional(),
	title: z.string().min(1),
	description: z.string().optional(),
	kind: z.enum(["frame", "slideshow"]).optional(),
	blocks: z.array(frameBlockSchema).min(1),
	theme: z
		.object({
			mode: z.enum(["light", "dark", "system"]).optional(),
			accentColor: z.string().optional(),
		})
		.optional(),
	sourceRunType: z.string().optional(),
	sourceRunId: z.string().optional(),
	authoritySessionId: z.string().optional(),
	providerKeys: z.array(z.string()).optional(),
	isPublic: z.boolean().optional(),
});

export const createFrameProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_CREATE))
	.route({
		method: "POST",
		path: "/frames",
		tags: ["Frames"],
		summary: "Create a frame",
		description: "Create a first-class Fabric Frame artifact",
	})
	.input(inputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const frame = await createFrame({
			...input,
			userId: context.user.id,
			organizationId,
		});

		return {
			id: frame.id,
			title: frame.title,
			description: frame.description,
			kind: frame.kind,
			contentType: frame.contentType,
			isPublic: frame.isPublic,
			shareToken: frame.shareToken,
			createdAt: frame.createdAt.toISOString(),
			updatedAt: frame.updatedAt.toISOString(),
		};
	});
