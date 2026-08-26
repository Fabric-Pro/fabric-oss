import { updateFrame } from "@repo/database";
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
	id: z.string(),
	organizationId: z.string().nullable().optional(),
	title: z.string().min(1).optional(),
	description: z.string().optional(),
	blocks: z.array(frameBlockSchema).min(1).optional(),
	theme: z
		.object({
			mode: z.enum(["light", "dark", "system"]).optional(),
			accentColor: z.string().optional(),
		})
		.optional(),
	isPublic: z.boolean().optional(),
});

export const updateFrameProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_UPDATE))
	.route({
		method: "POST",
		path: "/frames/{id}",
		tags: ["Frames"],
		summary: "Update a frame",
		description: "Update a first-class Fabric Frame",
	})
	.input(inputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const frame = await updateFrame({
			...input,
			userId: context.user.id,
			organizationId,
		});
		if (!frame) {
			throw new Error("Frame not found");
		}
		return {
			...frame,
			createdAt: frame.createdAt.toISOString(),
			updatedAt: frame.updatedAt.toISOString(),
		};
	});
