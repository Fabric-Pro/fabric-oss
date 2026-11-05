import { ORPCError } from "@orpc/server";
import {
	skillAssistResultSchema,
	skillAssistSchema,
	skillFileContentSchema,
	skillFileReadSchema,
	skillImportCreateSchema,
	skillImportFileSchema,
	skillImportPreviewSchema,
} from "@repo/ai/skill-authoring-contracts";
import {
	SkillError,
	skillArchiveSchema,
	skillCreateSchema,
	skillDeleteSchema,
	skillGetResultSchema,
	skillGetSchema,
	skillGovernanceReadSchema,
	skillGovernanceResultSchema,
	skillGovernanceUpdateSchema,
	skillListResultSchema,
	skillListSchema,
	skillPublishSchema,
	skillRestoreSchema,
	skillUpdateSchema,
} from "@repo/ai/skill-contracts";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../lib/audit";
import {
	Permissions,
	requireInputOrgPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { resolvedOrganizationId } from "../../agents/procedures/conversations/resolved-organization";
import {
	assistSkillCommand,
	createSkillImportCommand,
	previewSkillImportCommand,
	readSkillFileCommand,
	readSkillImportFileCommand,
} from "../lib/skill-authoring";
import {
	archiveSkillCommand,
	createSkillCommand,
	deleteSkillCommand,
	getSkillCommand,
	getSkillGovernanceCommand,
	listSkillsCommand,
	publishSkillCommand,
	restoreSkillCommand,
	updateSkillCommand,
	updateSkillGovernanceCommand,
} from "../lib/skill-commands";

const org = {
	organizationId: z.string().min(1).max(200).nullable().optional(),
};
async function translate<T>(command: () => Promise<T>) {
	try {
		return await command();
	} catch (error) {
		if (error instanceof SkillError) {
			throw new ORPCError(error.code, { message: error.message });
		}
		throw error;
	}
}
export const skillCatalogProcedures = {
	list: tenantProtectedProcedure
		.use(
			requireInputOrgPermission(Permissions.SKILL_READ, {
				requireOrganization: true,
			}),
		)
		.input(skillListSchema.safeExtend(org))
		.output(skillListResultSchema)
		.handler(async ({ input, context }) => {
			const { organizationId: _, ...request } = input;
			return translate(() =>
				listSkillsCommand(
					{
						userId: context.user.id,
						organizationId: resolvedOrganizationId(
							input,
							context.session,
						),
					},
					request,
				),
			);
		}),
	get: tenantProtectedProcedure
		.use(
			requireInputOrgPermission(Permissions.SKILL_READ, {
				requireOrganization: true,
			}),
		)
		.input(skillGetSchema.safeExtend(org))
		.output(skillGetResultSchema)
		.handler(async ({ input, context }) => {
			const { organizationId: _, ...request } = input;
			return translate(() =>
				getSkillCommand(
					{
						userId: context.user.id,
						organizationId: resolvedOrganizationId(
							input,
							context.session,
						),
					},
					request,
				),
			);
		}),
	create: tenantProtectedProcedure
		.use(
			requireInputOrgPermission(Permissions.SKILL_CREATE, {
				requireOrganization: true,
			}),
		)
		.input(skillCreateSchema.safeExtend(org))
		.output(skillGetResultSchema)
		.handler(async ({ input, context }) => {
			const { organizationId: _, ...request } = input;
			return translate(() =>
				createSkillCommand(
					{
						userId: context.user.id,
						organizationId: resolvedOrganizationId(
							input,
							context.session,
						),
					},
					request,
					(event) => recordAuditFromRequest(context, event),
				),
			);
		}),
	update: tenantProtectedProcedure
		.use(
			requireInputOrgPermission(Permissions.SKILL_UPDATE, {
				requireOrganization: true,
			}),
		)
		.input(skillUpdateSchema.safeExtend(org))
		.output(skillGetResultSchema)
		.handler(async ({ input, context }) => {
			const { organizationId: _, ...request } = input;
			return translate(() =>
				updateSkillCommand(
					{
						userId: context.user.id,
						organizationId: resolvedOrganizationId(
							input,
							context.session,
						),
					},
					request,
					(event) => recordAuditFromRequest(context, event),
				),
			);
		}),
	archive: tenantProtectedProcedure
		.use(
			requireInputOrgPermission(Permissions.SKILL_UPDATE, {
				requireOrganization: true,
			}),
		)
		.input(skillArchiveSchema.safeExtend(org))
		.output(skillGetResultSchema)
		.handler(async ({ input, context }) => {
			const { organizationId: _, ...request } = input;
			return translate(() =>
				archiveSkillCommand(
					{
						userId: context.user.id,
						organizationId: resolvedOrganizationId(
							input,
							context.session,
						),
					},
					request,
					(event) => recordAuditFromRequest(context, event),
				),
			);
		}),
	restore: tenantProtectedProcedure
		.use(
			requireInputOrgPermission(Permissions.SKILL_UPDATE, {
				requireOrganization: true,
			}),
		)
		.input(skillRestoreSchema.safeExtend(org))
		.output(skillGetResultSchema)
		.handler(async ({ input, context }) => {
			const { organizationId: _, ...request } = input;
			return translate(() =>
				restoreSkillCommand(
					{
						userId: context.user.id,
						organizationId: resolvedOrganizationId(
							input,
							context.session,
						),
					},
					request,
					(event) => recordAuditFromRequest(context, event),
				),
			);
		}),
	publish: tenantProtectedProcedure
		.use(
			requireInputOrgPermission(Permissions.SKILL_UPDATE, {
				requireOrganization: true,
			}),
		)
		.input(skillPublishSchema.safeExtend(org))
		.output(skillGetResultSchema)
		.handler(async ({ input, context }) => {
			const { organizationId: _, ...request } = input;
			return translate(() =>
				publishSkillCommand(
					{
						userId: context.user.id,
						organizationId: resolvedOrganizationId(
							input,
							context.session,
						),
					},
					request,
					(event) => recordAuditFromRequest(context, event),
				),
			);
		}),
	delete: tenantProtectedProcedure
		.use(
			requireInputOrgPermission(Permissions.SKILL_DELETE, {
				requireOrganization: true,
			}),
		)
		.input(skillDeleteSchema.safeExtend(org))
		.handler(async ({ input, context }) => {
			const { organizationId: _, ...request } = input;
			return translate(() =>
				deleteSkillCommand(
					{
						userId: context.user.id,
						organizationId: resolvedOrganizationId(
							input,
							context.session,
						),
					},
					request,
					(event) => recordAuditFromRequest(context, event),
				),
			);
		}),
	governanceGet: tenantProtectedProcedure
		.use(
			requireInputOrgPermission(Permissions.SKILL_READ, {
				requireOrganization: true,
			}),
		)
		.input(skillGovernanceReadSchema.safeExtend(org))
		.output(skillGovernanceResultSchema)
		.handler(async ({ input, context }) => {
			const { organizationId: _, ...request } = input;
			return translate(() =>
				getSkillGovernanceCommand(
					{
						userId: context.user.id,
						organizationId: resolvedOrganizationId(
							input,
							context.session,
						),
					},
					request,
				),
			);
		}),
	governanceUpdate: tenantProtectedProcedure
		.use(
			requireInputOrgPermission(Permissions.ORG_UPDATE, {
				requireOrganization: true,
			}),
		)
		.input(skillGovernanceUpdateSchema.safeExtend(org))
		.output(skillGovernanceResultSchema)
		.handler(async ({ input, context }) => {
			const { organizationId: _, ...request } = input;
			return translate(() =>
				updateSkillGovernanceCommand(
					{
						userId: context.user.id,
						organizationId: resolvedOrganizationId(
							input,
							context.session,
						),
					},
					request,
					(event) => recordAuditFromRequest(context, event),
				),
			);
		}),
	assist: tenantProtectedProcedure
		.use(
			requireInputOrgPermission(Permissions.SKILL_CREATE, {
				requireOrganization: true,
			}),
		)
		.input(skillAssistSchema.safeExtend(org))
		.output(skillAssistResultSchema)
		.handler(async ({ input, context }) => {
			const { organizationId: _, ...request } = input;
			return translate(() =>
				assistSkillCommand(
					{
						userId: context.user.id,
						organizationId: resolvedOrganizationId(
							input,
							context.session,
						),
					},
					request,
					(event) => recordAuditFromRequest(context, event),
				),
			);
		}),
	importPreview: tenantProtectedProcedure
		.use(
			requireInputOrgPermission(Permissions.SKILL_CREATE, {
				requireOrganization: true,
			}),
		)
		.input(skillImportPreviewSchema.safeExtend(org))
		.handler(async ({ input, context }) => {
			const { organizationId: _, ...request } = input;
			return translate(() =>
				previewSkillImportCommand(
					{
						userId: context.user.id,
						organizationId: resolvedOrganizationId(
							input,
							context.session,
						),
					},
					request,
					(event) => recordAuditFromRequest(context, event),
				),
			);
		}),
	importCreate: tenantProtectedProcedure
		.use(
			requireInputOrgPermission(Permissions.SKILL_CREATE, {
				requireOrganization: true,
			}),
		)
		.input(skillImportCreateSchema.safeExtend(org))
		.output(skillGetResultSchema)
		.handler(async ({ input, context }) => {
			const { organizationId: _, ...request } = input;
			return translate(() =>
				createSkillImportCommand(
					{
						userId: context.user.id,
						organizationId: resolvedOrganizationId(
							input,
							context.session,
						),
					},
					request,
					(event) => recordAuditFromRequest(context, event),
				),
			);
		}),
	readFile: tenantProtectedProcedure
		.use(
			requireInputOrgPermission(Permissions.SKILL_READ, {
				requireOrganization: true,
			}),
		)
		.input(skillFileReadSchema.safeExtend(org))
		.output(skillFileContentSchema)
		.handler(async ({ input, context }) => {
			const { organizationId: _, ...request } = input;
			return translate(() =>
				readSkillFileCommand(
					{
						userId: context.user.id,
						organizationId: resolvedOrganizationId(
							input,
							context.session,
						),
					},
					request,
				),
			);
		}),
	importReadFile: tenantProtectedProcedure
		.use(
			requireInputOrgPermission(Permissions.SKILL_CREATE, {
				requireOrganization: true,
			}),
		)
		.input(skillImportFileSchema.safeExtend(org))
		.output(skillFileContentSchema)
		.handler(async ({ input, context }) => {
			const { organizationId: _, ...request } = input;
			return translate(() =>
				readSkillImportFileCommand(
					{
						userId: context.user.id,
						organizationId: resolvedOrganizationId(
							input,
							context.session,
						),
					},
					request,
					(event) => recordAuditFromRequest(context, event),
				),
			);
		}),
};
