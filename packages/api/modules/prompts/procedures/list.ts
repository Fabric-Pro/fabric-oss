import { ORPCError } from "@orpc/client";
import {
	getBindingStatusForPrompts,
	getPromptCategories,
	getPromptTags,
	listPrompts,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

const PromptFormatSchema = z.enum([
	"PLAIN_TEXT",
	"MARKDOWN",
	"HANDLEBARS",
	"MUSTACHE",
	"LIQUID",
	"JINJA2",
]);

const PromptScopeSchema = z.enum(["SYSTEM", "ORG", "USER"]);

export const listProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.PROMPT_READ))
	.route({
		method: "GET",
		path: "/prompts/list",
		tags: ["Prompts"],
		summary: "List prompts with filtering",
		description:
			"List prompts with advanced filtering by scope, category, tags, format, and search. When documentType is provided, results are enriched with binding status.",
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
			scope: PromptScopeSchema.optional(),
			category: z.string().optional(),
			tags: z.array(z.string()).optional(),
			search: z.string().optional(),
			format: PromptFormatSchema.optional(),
			documentType: z.string().optional(),
			limit: z.number().min(1).max(100).default(50),
			offset: z.number().min(0).default(0),
			sortBy: z
				.enum([
					"name",
					"createdAt",
					"updatedAt",
					"usageCount",
					"lastUsedAt",
				])
				.default("updatedAt"),
			sortOrder: z.enum(["asc", "desc"]).default("desc"),
			unused: z.boolean().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		if (organizationId) {
			const membership = await verifyOrganizationMembership(
				organizationId,
				user.id,
			);

			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message: "You are not a member of this organization",
				});
			}
		}

		const result = await listPrompts({
			userId: user.id,
			organizationId,
			scope: input.scope as any,
			category: input.category,
			tags: input.tags,
			search: input.search,
			format: input.format as any,
			boundToDocumentType: input.documentType,
			unused: input.unused,
			limit: input.limit,
			offset: input.offset,
			sortBy: input.sortBy,
			sortOrder: input.sortOrder,
		});

		// Enrich with binding status whenever there is anything to enrich. The
		// library page no longer carries a document-type dimension (the scope
		// tabs replaced it), and FR4's "which prompt is in force" has to answer
		// on the page users actually scan — so the status is resolved across
		// every action when no type filter narrows it. A prompt that wins any
		// action badges Default at its best tier; one merely bound shows
		// Available.
		if (result.prompts.length > 0) {
			const promptIds = result.prompts.map((p) => p.id);
			const bindingStatus = await getBindingStatusForPrompts({
				promptIds,
				documentType: input.documentType,
				userId: user.id,
				organizationId,
			});

			const enrichedPrompts = result.prompts.map((prompt) => {
				const status = bindingStatus.get(prompt.id);
				return {
					...prompt,
					isDefault: status?.isDefault ?? false,
					isBound: status?.isBound ?? false,
					// Which tier the default came from, so the library can say
					// what is in force rather than only that something is.
					defaultScope: status?.defaultScope ?? null,
				};
			});

			return { prompts: enrichedPrompts, total: result.total };
		}

		return result;
	});

export const categoriesProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.PROMPT_READ))
	.route({
		method: "GET",
		path: "/prompts/categories",
		tags: ["Prompts"],
		summary: "Get all prompt categories",
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		if (organizationId) {
			const membership = await verifyOrganizationMembership(
				organizationId,
				user.id,
			);

			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message: "You are not a member of this organization",
				});
			}
		}

		const categories = await getPromptCategories({
			userId: user.id,
			organizationId,
		});

		return { categories };
	});

export const tagsProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.PROMPT_READ))
	.route({
		method: "GET",
		path: "/prompts/tags",
		tags: ["Prompts"],
		summary: "Get all prompt tags",
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		if (organizationId) {
			const membership = await verifyOrganizationMembership(
				organizationId,
				user.id,
			);

			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message: "You are not a member of this organization",
				});
			}
		}

		const tags = await getPromptTags({
			userId: user.id,
			organizationId,
		});

		return { tags };
	});
