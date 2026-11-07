import { ORPCError } from "@orpc/server";
import { FrameReviewError } from "@repo/database";
import {
	frameAuthoringDocumentSchema,
	frameCreateSchema,
	frameFromTemplateSchema,
	frameTemplateCreateSchema,
} from "@repo/utils/frame-authoring";
import { z } from "zod";
import {
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import {
	createAuthoredFrame,
	createAuthoredFrameFromTemplate,
	createAuthoredFrameTemplate,
	getAuthoredFrameTemplate,
	listAuthoredFrameTemplates,
	validateAuthoredFrame,
} from "../lib/frame-authoring-commands";

const organization = { organizationId: z.string().nullable().optional() };
export const frameAuthoringProcedure = tenantProtectedProcedure.use(
	async ({ next }) => {
		try {
			return await next();
		} catch (e) {
			if (e instanceof FrameReviewError) {
				throw new ORPCError(e.code, { message: e.message });
			}
			throw e;
		}
	},
);
function actor(
	context: {
		user: { id: string };
		session: Parameters<typeof resolveOrganizationId>[1];
	},
	org?: string | null,
) {
	return {
		userId: context.user.id,
		organizationId: resolveOrganizationId(org, context.session)!,
	};
}
export const createAuthoredFrameProcedure = frameAuthoringProcedure
	.route({
		method: "POST",
		path: "/frames",
		tags: ["Frames"],
		summary: "Create a private page",
	})
	.input(frameCreateSchema.extend(organization))
	.handler(({ input, context }) => {
		const { organizationId, ...body } = input;
		return createAuthoredFrame(actor(context, organizationId), body);
	});
export const createFromTemplateProcedure = frameAuthoringProcedure
	.route({
		method: "POST",
		path: "/frames/from-template",
		tags: ["Frames"],
		summary: "Create a private page from template",
	})
	.input(frameFromTemplateSchema.extend(organization))
	.handler(async ({ input, context }) => {
		const { organizationId, ...body } = input;
		const frame = await createAuthoredFrameFromTemplate(
			actor(context, organizationId),
			body,
		);
		return {
			success: true,
			frame: { id: frame.id, title: frame.title, path: frame.path },
		};
	});
export const listTemplatesProcedure = frameAuthoringProcedure
	.route({
		method: "GET",
		path: "/frame-templates",
		tags: ["Frames"],
		summary: "List reusable page templates",
	})
	.input(
		z.strictObject({
			...organization,
			category: z.string().max(100).optional(),
			includeSystem: z.boolean().default(true),
		}),
	)
	.handler(({ input, context }) => {
		const { organizationId, ...body } = input;
		return listAuthoredFrameTemplates(actor(context, organizationId), body);
	});
export const getFrameTemplateProcedure = frameAuthoringProcedure
	.route({
		method: "GET",
		path: "/frame-templates/{templateId}",
		tags: ["Frames"],
		summary: "Read a page template",
	})
	.input(
		z.strictObject({
			...organization,
			templateId: z.string().min(1).max(200),
		}),
	)
	.handler(({ input, context }) =>
		getAuthoredFrameTemplate(
			actor(context, input.organizationId),
			input.templateId,
		),
	);
export const createFrameTemplateProcedure = frameAuthoringProcedure
	.route({
		method: "POST",
		path: "/frame-templates",
		tags: ["Frames"],
		summary: "Create an organization page template",
	})
	.input(frameTemplateCreateSchema.extend(organization))
	.handler(({ input, context }) => {
		const { organizationId, ...body } = input;
		return createAuthoredFrameTemplate(
			actor(context, organizationId),
			body,
		);
	});
export const validateFrameDocumentProcedure = frameAuthoringProcedure
	.route({
		method: "POST",
		path: "/frames/validate-document",
		tags: ["Frames"],
		summary: "Check page structure and JSON syntax",
	})
	.input(
		z.strictObject({
			...organization,
			document: frameAuthoringDocumentSchema,
		}),
	)
	.handler(({ input, context }) =>
		validateAuthoredFrame(
			actor(context, input.organizationId),
			input.document,
		),
	);
