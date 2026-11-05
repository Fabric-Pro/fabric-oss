import { isDeepStrictEqual } from "node:util";
import { ORPCError } from "@orpc/server";
import {
	assertPublicReportParameters,
	clearReportTemplateOverride,
	getReportTemplate,
	getReportTemplateOverrides,
	isFeatureEnabled,
	mergeReportTemplateOverrides,
	readReportTemplatePromptDefaults,
	reportScheduleInputSchema,
	setReportTemplateOverride,
} from "@repo/database";
import { MAX_REPORT_PARAMETER_DEFAULT_LENGTH } from "@repo/database/prisma/queries/lib/report-template-defaults";
import { z } from "zod";
import {
	assertProjectPermission,
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	canEditProjectReport,
	canReachProjectReports,
	canSetOrganizationReportDefaults,
	hasOrganizationReportPermission,
	mayUseReportPermission,
} from "../../lib/report-access";
import {
	isOrganizationOwnedTemplate,
	reportTemplatePromptsSchema,
	unknownReportAiTaskKeys,
} from "../../lib/template-prompts";

const MAX_DEFAULT_ENTRIES = 50;

const overrideKey = z.string().trim().min(1).max(100);

const overrideDefaultsSchema = z.object({
	parameterDefaults: z
		.record(
			overrideKey,
			z.union([
				z.string().max(MAX_REPORT_PARAMETER_DEFAULT_LENGTH),
				z.number(),
				z.boolean(),
			]),
		)
		.refine(
			(values) => Object.keys(values).length <= MAX_DEFAULT_ENTRIES,
			"Too many parameter defaults",
		)
		.superRefine((values, issues) => {
			try {
				assertPublicReportParameters(values);
			} catch (error) {
				issues.addIssue({
					code: "custom",
					message:
						error instanceof Error
							? error.message
							: "Invalid report parameters",
				});
			}
		})
		.nullable(),
	context: z
		.record(overrideKey, z.string().max(2000))
		.refine(
			(values) => Object.keys(values).length <= MAX_DEFAULT_ENTRIES,
			"Too many context defaults",
		)
		.nullable(),
	schedule: reportScheduleInputSchema.nullable(),
	// The scope's default report instructions and AI task prompts; omitted keeps
	// the stored prompts, null clears them.
	prompts: reportTemplatePromptsSchema.nullable().optional(),
});

const overrideScopeInputSchema = z.object({
	// The report's organization when the page knows it, so an open page never
	// acts on whichever organization the session has moved to since.
	organizationId: z.string().min(1).max(128).optional(),
	templateId: z.string().min(1).max(128),
	// The project whose Reports tab asks; its own defaults are read with the organization's.
	projectId: z.string().min(1).max(128).optional(),
});

export const setTemplateOverrideInputSchema = overrideScopeInputSchema.extend({
	scope: z.enum(["ORGANIZATION", "PROJECT"]),
	// null clears this scope's defaults, so reports fall back to the next scope's.
	defaults: overrideDefaultsSchema.nullable(),
});

type OverrideCaller = {
	user: { id: string; role?: string | null };
	session: { activeOrganizationId?: string | null };
};

/**
 * The organization and template a request is about. A project is authorized
 * BEFORE the organization resolves, so the organization is the project's own.
 */
async function resolveOverrideScope(
	input: { organizationId?: string; templateId: string; projectId?: string },
	context: OverrideCaller,
) {
	if (input.projectId) {
		await assertProjectPermission(
			input.projectId,
			context.user.id,
			Permissions.REPORT_READ,
		);
		if (!(await canReachProjectReports(input.projectId, context.user))) {
			throw new ORPCError("FORBIDDEN", {
				message: "You do not have access to this project's reports",
			});
		}
	}
	const organizationId = resolveOrganizationId(
		input.organizationId,
		context.session,
	);
	if (!organizationId) {
		throw new ORPCError("BAD_REQUEST", {
			message: "Report defaults belong to an organization",
		});
	}
	// Defaults are the organization's: reading a project does not make a
	// project guest a reader of them.
	if (
		!(await hasOrganizationReportPermission(
			organizationId,
			context.user.id,
			Permissions.REPORT_READ,
		))
	) {
		throw new ORPCError("FORBIDDEN", {
			message: "You do not have permission to read report defaults",
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
	return {
		organizationId,
		templateId: template.id,
		templateParameters: template.parameters,
		templateDefinition: template.definition,
		ownedByOrganization: isOrganizationOwnedTemplate(
			template,
			organizationId,
		),
	};
}

function overrideValues(
	row: {
		parameterDefaults: unknown;
		context: unknown;
		schedule: unknown;
		prompts: unknown;
		updatedAt: Date;
	} | null,
) {
	if (!row) {
		return null;
	}
	const values = mergeReportTemplateOverrides(row, null);
	const schedule = reportScheduleInputSchema.safeParse(values.schedule);
	return {
		parameterDefaults: values.parameterDefaults,
		context: values.context,
		schedule: schedule.success ? schedule.data : null,
		prompts: values.prompts ?? null,
		updatedAt: row.updatedAt.toISOString(),
	};
}

/**
 * Reports created in a project inherit its default schedule, and a schedule
 * spends the owner's connections and credits. So setting, changing or clearing
 * it also takes the organization's `REPORT_UPDATE`, as a report's own schedule
 * does; resending the stored one changes nothing and passes.
 */
async function assertMayChangeProjectSchedule(
	scope: { templateId: string; organizationId: string; projectId: string },
	nextSchedule: z.infer<typeof overrideDefaultsSchema>["schedule"],
	user: OverrideCaller["user"],
) {
	const stored = await getReportTemplateOverrides(scope);
	if (
		!isDeepStrictEqual(
			overrideValues(stored.project)?.schedule ?? null,
			nextSchedule,
		) &&
		!(await mayUseReportPermission(
			scope.organizationId,
			user,
			Permissions.REPORT_UPDATE,
		))
	) {
		throw new ORPCError("FORBIDDEN", {
			message:
				"You can set this project's other defaults, but not its schedule, because scheduled runs spend the owner's connections and credits",
		});
	}
}

/**
 * A template's defaults for new reports: the organization's and, for a
 * project, the project's, with which of the two the caller may change.
 */
export const getTemplateOverridesProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.REPORT_READ))
	.input(overrideScopeInputSchema)
	.handler(async ({ input, context }) => {
		const {
			organizationId,
			templateId,
			templateParameters,
			ownedByOrganization,
		} = await resolveOverrideScope(input, context);
		const [
			overrides,
			canSetOrganization,
			canSetProject,
			organizationWrites,
		] = await Promise.all([
			getReportTemplateOverrides({
				templateId,
				organizationId,
				projectId: input.projectId,
			}),
			canSetOrganizationReportDefaults(organizationId, context.user),
			input.projectId
				? canEditProjectReport(input.projectId, context.user)
				: null,
			mayUseReportPermission(
				organizationId,
				context.user,
				Permissions.REPORT_UPDATE,
			),
		]);
		return {
			templateParameters,
			organization: overrideValues(overrides.organization),
			project: overrideValues(overrides.project),
			canSetOrganization,
			canSetOrganizationPrompts:
				canSetOrganization && !ownedByOrganization,
			// The organization's own template takes no prompts from its row:
			// those are stale copies from before it was published to it.
			organizationPromptsApply: !ownedByOrganization,
			canSetProject,
			canSetProjectSchedule: canSetProject === true && organizationWrites,
		};
	});

function isEmptyDefaults(
	defaults: z.infer<typeof overrideDefaultsSchema>,
): boolean {
	return (
		Object.keys(defaults.parameterDefaults ?? {}).length === 0 &&
		Object.keys(defaults.context ?? {}).length === 0 &&
		defaults.schedule === null
	);
}

/**
 * Sets or clears the organization's defaults (its admins and owners) or a
 * project's defaults (whoever may edit the project's reports) for the
 * reports created from a template from now on. Existing reports keep theirs.
 * Either scope may hold default prompts, project over organization, except that
 * an organization's own template is edited directly rather than through its
 * organization's row.
 * The middleware only admits members: the handler decides who may set each
 * scope, since a project Editor who is an organization Viewer may set theirs,
 * all but the schedule.
 */
export const setTemplateOverrideProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.REPORT_READ))
	.input(setTemplateOverrideInputSchema)
	.handler(async ({ input, context }) => {
		if (input.scope === "PROJECT" && !input.projectId) {
			throw new ORPCError("BAD_REQUEST", {
				message: "Name the project whose defaults to set",
			});
		}
		const {
			organizationId,
			templateId,
			templateDefinition,
			ownedByOrganization,
		} = await resolveOverrideScope(input, context);
		if (!(await isFeatureEnabled("REPORT_SUITE_V2", organizationId))) {
			throw new ORPCError("FORBIDDEN", {
				message:
					"Report defaults are not available in this organization",
			});
		}
		const projectId =
			input.scope === "PROJECT" ? (input.projectId ?? null) : null;
		const allowed = projectId
			? await canEditProjectReport(projectId, context.user)
			: await canSetOrganizationReportDefaults(
					organizationId,
					context.user,
				);
		if (!allowed) {
			throw new ORPCError("FORBIDDEN", {
				message: projectId
					? "You need at least the Editor role on this project to set its report defaults"
					: "Only organization admins and owners can set the organization's report defaults",
			});
		}
		if (projectId) {
			await assertMayChangeProjectSchedule(
				{ templateId, organizationId, projectId },
				input.defaults?.schedule ?? null,
				context.user,
			);
		}
		const scope = { templateId, organizationId, projectId };
		if (input.defaults === null) {
			await clearReportTemplateOverride(scope);
			return { scope: input.scope, cleared: true };
		}

		// undefined keeps the stored prompts; null (or only blank prompts) clears them.
		const submittedPrompts = input.defaults.prompts;
		const prompts =
			submittedPrompts === undefined
				? undefined
				: (readReportTemplatePromptDefaults(submittedPrompts) ?? null);
		if (prompts) {
			if (ownedByOrganization && projectId === null) {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"This is the organization's own template: change its prompts on the template",
				});
			}
			const unknownKeys = unknownReportAiTaskKeys(
				templateDefinition,
				prompts.aiTasks,
			);
			if (unknownKeys.length > 0) {
				throw new ORPCError("BAD_REQUEST", {
					message: `The template has no AI task named ${unknownKeys.join(", ")}`,
				});
			}
		}

		// A row whose values are all empty is removed, unless it still holds
		// prompts this save leaves in place.
		const keepsStoredPrompts = async () => {
			if (prompts !== undefined) {
				return false;
			}
			const stored = await getReportTemplateOverrides({
				templateId,
				organizationId,
				projectId: projectId ?? undefined,
			});
			return (
				readReportTemplatePromptDefaults(
					(projectId ? stored.project : stored.organization)?.prompts,
				) !== undefined
			);
		};
		if (
			isEmptyDefaults(input.defaults) &&
			!prompts &&
			!(await keepsStoredPrompts())
		) {
			await clearReportTemplateOverride(scope);
			return { scope: input.scope, cleared: true };
		}
		await setReportTemplateOverride(scope, {
			parameterDefaults: input.defaults.parameterDefaults,
			context: input.defaults.context,
			schedule: input.defaults.schedule,
			prompts,
			updatedById: context.user.id,
		});
		return { scope: input.scope, cleared: false };
	});
