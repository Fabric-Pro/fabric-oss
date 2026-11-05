import { ORPCError } from "@orpc/server";
import {
	getReportTemplate,
	isFeatureEnabled,
	publishReportTemplate,
	systemReportTemplateNameTaken,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	assertCanPublishReportTemplate,
	assertReportPermission,
	isOrganizationReportAdmin,
} from "../../lib/report-access";

const publishTemplateInputSchema = z.object({
	templateId: z.string().min(1).max(128),
	target: z.enum(["ORGANIZATION", "SYSTEM"]),
});

/**
 * Publish a template to a wider audience, as the Prompt Library does:
 * the author of a personal template made in this organization, when an admin
 * or owner of it, publishes it to the organization; a platform admin
 * publishes an organization or personal template to every tenant. There is
 * no unpublish: other members' reports may already use the template, so it
 * is removed by archiving it, which keeps those reports running.
 */
export const publishTemplateProcedure = tenantProtectedProcedure
	// The middleware only admits members: a platform admin publishes from any
	// project's Reports tab, whatever their organization role there.
	.use(requirePermission(Permissions.REPORT_READ))
	.input(publishTemplateInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			undefined,
			context.session,
		);
		await assertReportPermission(
			organizationId,
			context.user,
			Permissions.REPORT_UPDATE,
		);
		if (!(await isFeatureEnabled("REPORT_SUITE_V2", organizationId))) {
			throw new ORPCError("FORBIDDEN", {
				message:
					"Publishing templates is not available in this organization",
			});
		}
		const template = await getReportTemplate({
			id: input.templateId,
			userId: context.user.id,
			organizationId,
		});
		if (!template) {
			throw new ORPCError("NOT_FOUND", {
				message: "Report template not found",
			});
		}
		if (template.archivedAt) {
			throw new ORPCError("BAD_REQUEST", {
				message: "Restore this template before publishing it",
			});
		}

		switch (input.target) {
			case "ORGANIZATION": {
				if (template.scope !== "USER") {
					throw new ORPCError("BAD_REQUEST", {
						message:
							"Only a personal template can be published to the organization",
					});
				}
				if (template.userId !== context.user.id) {
					throw new ORPCError("FORBIDDEN", {
						message: "Only the template's author can publish it",
					});
				}
				if (
					!organizationId ||
					template.organizationId !== organizationId
				) {
					throw new ORPCError("FORBIDDEN", {
						message:
							"Publish a template from the organization it was made in",
					});
				}
				if (
					!(await isOrganizationReportAdmin(
						organizationId,
						context.user.id,
					))
				) {
					throw new ORPCError("FORBIDDEN", {
						message:
							"Only organization admins and owners can publish templates to the organization",
					});
				}
				const published = await publishReportTemplate({
					id: template.id,
					target: "ORGANIZATION",
					organizationId,
				});
				return { id: published.id, scope: published.scope };
			}
			case "SYSTEM": {
				await assertCanPublishReportTemplate(
					{ scope: "SYSTEM" },
					context.user,
				);
				if (template.scope === "SYSTEM") {
					throw new ORPCError("BAD_REQUEST", {
						message: "This template is already a system template",
					});
				}
				if (
					await systemReportTemplateNameTaken(
						template.name,
						template.id,
					)
				) {
					throw new ORPCError("BAD_REQUEST", {
						message:
							"A system template with this name already exists. Rename this template before publishing it.",
					});
				}
				const published = await publishReportTemplate({
					id: template.id,
					target: "SYSTEM",
				});
				return { id: published.id, scope: published.scope };
			}
			default: {
				const unreachable: never = input.target;
				throw new ORPCError("BAD_REQUEST", {
					message: `Unknown publish target: ${String(unreachable)}`,
				});
			}
		}
	});
