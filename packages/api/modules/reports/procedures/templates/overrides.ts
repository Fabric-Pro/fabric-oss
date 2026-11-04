import { ORPCError } from "@orpc/server";
import {
	clearReportTemplateOverride,
	getReportTemplate,
	getReportTemplateOverrides,
	isFeatureEnabled,
	mergeReportTemplateOverrides,
	reportScheduleInputSchema,
	setReportTemplateOverride,
} from "@repo/database";
import { z } from "zod";
import {
	assertProjectPermission,
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	canEditProjectReport,
	canSetOrganizationReportDefaults,
	hasOrganizationReportPermission,
} from "../../lib/report-access";

const MAX_DEFAULT_ENTRIES = 50;

const overrideKey = z.string().trim().min(1).max(100);

const overrideDefaultsSchema = z.object({
	parameterDefaults: z
		.record(
			overrideKey,
			z.union([z.string().max(2000), z.number(), z.boolean()]),
		)
		.refine(
			(values) => Object.keys(values).length <= MAX_DEFAULT_ENTRIES,
			"Too many parameter defaults",
		)
		.nullable(),
	context: z
		.record(overrideKey, z.string().max(2000))
		.refine(
			(values) => Object.keys(values).length <= MAX_DEFAULT_ENTRIES,
			"Too many context defaults",
		)
		.nullable(),
	schedule: reportScheduleInputSchema.nullable(),
});

const overrideScopeInputSchema = z.object({
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
	input: { templateId: string; projectId?: string },
	context: OverrideCaller,
) {
	if (input.projectId) {
		await assertProjectPermission(
			input.projectId,
			context.user.id,
			Permissions.REPORT_READ,
		);
	}
	const organizationId = resolveOrganizationId(undefined, context.session);
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
	};
}

function overrideValues(
	row: {
		parameterDefaults: unknown;
		context: unknown;
		schedule: unknown;
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
		updatedAt: row.updatedAt.toISOString(),
	};
}

/**
 * A template's defaults for new reports: the organization's and, for a
 * project, the project's, with which of the two the caller may change.
 */
export const getTemplateOverridesProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.REPORT_READ))
	.input(overrideScopeInputSchema)
	.handler(async ({ input, context }) => {
		const { organizationId, templateId, templateParameters } =
			await resolveOverrideScope(input, context);
		const [overrides, canSetOrganization, canSetProject] =
			await Promise.all([
				getReportTemplateOverrides({
					templateId,
					organizationId,
					projectId: input.projectId,
				}),
				canSetOrganizationReportDefaults(organizationId, context.user),
				input.projectId
					? canEditProjectReport(input.projectId, context.user)
					: null,
			]);
		return {
			templateParameters,
			organization: overrideValues(overrides.organization),
			project: overrideValues(overrides.project),
			canSetOrganization,
			canSetProject,
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
 */
export const setTemplateOverrideProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.REPORT_UPDATE))
	.input(setTemplateOverrideInputSchema)
	.handler(async ({ input, context }) => {
		if (input.scope === "PROJECT" && !input.projectId) {
			throw new ORPCError("BAD_REQUEST", {
				message: "Name the project whose defaults to set",
			});
		}
		const { organizationId, templateId } = await resolveOverrideScope(
			input,
			context,
		);
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
		const scope = { templateId, organizationId, projectId };
		if (input.defaults === null || isEmptyDefaults(input.defaults)) {
			await clearReportTemplateOverride(scope);
			return { scope: input.scope, cleared: true };
		}
		await setReportTemplateOverride(scope, {
			parameterDefaults: input.defaults.parameterDefaults,
			context: input.defaults.context,
			schedule: input.defaults.schedule,
			updatedById: context.user.id,
		});
		return { scope: input.scope, cleared: false };
	});
