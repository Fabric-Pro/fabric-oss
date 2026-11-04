/**
 * An organization's and a project's defaults for the reports it creates from
 * a template (`report_template_override`). Organization-only rows: every
 * query names the organization, and a project row is read only together with
 * the organization that hosts it. Callers authorize the change first
 * (`reports/lib/report-access`).
 */

import { db } from "../client";
import { Prisma } from "../generated/client";
import {
	mergeReportTemplateOverrides,
	type ResolvedReportTemplateDefaults,
} from "./lib/report-template-defaults";

export * from "./lib/report-template-defaults";

const OVERRIDE_SELECT = {
	id: true,
	templateId: true,
	organizationId: true,
	projectId: true,
	parameterDefaults: true,
	context: true,
	schedule: true,
	updatedById: true,
	updatedAt: true,
} as const;

type ReportTemplateOverrideScope = {
	templateId: string;
	organizationId: string;
	/** null for the organization's own defaults. */
	projectId: string | null;
};

function findOverride(scope: ReportTemplateOverrideScope) {
	return db.reportTemplateOverride.findFirst({
		where: {
			templateId: scope.templateId,
			organizationId: scope.organizationId,
			projectId: scope.projectId,
		},
		select: OVERRIDE_SELECT,
	});
}

/** The organization's defaults for a template and, when a project is named, that project's. */
export async function getReportTemplateOverrides({
	templateId,
	organizationId,
	projectId,
}: {
	templateId: string;
	organizationId: string;
	projectId?: string;
}) {
	const [organization, project] = await Promise.all([
		findOverride({ templateId, organizationId, projectId: null }),
		projectId
			? findOverride({ templateId, organizationId, projectId })
			: null,
	]);
	return { organization, project };
}

/** The defaults a report created now from this template takes. */
export async function resolveReportTemplateDefaults(params: {
	templateId: string;
	organizationId: string;
	projectId?: string;
}): Promise<ResolvedReportTemplateDefaults> {
	const { organization, project } = await getReportTemplateOverrides(params);
	return mergeReportTemplateOverrides(organization, project);
}

function jsonOrNull(
	value: Prisma.InputJsonValue | null,
): Prisma.InputJsonValue | typeof Prisma.DbNull {
	return value === null ? Prisma.DbNull : value;
}

/**
 * Sets one scope's defaults, creating the row on first save. A concurrent
 * first save loses the unique key race and is applied as an update.
 */
export async function setReportTemplateOverride(
	scope: ReportTemplateOverrideScope,
	values: {
		parameterDefaults: Prisma.InputJsonValue | null;
		context: Prisma.InputJsonValue | null;
		schedule: Prisma.InputJsonValue | null;
		updatedById: string;
	},
) {
	const data = {
		parameterDefaults: jsonOrNull(values.parameterDefaults),
		context: jsonOrNull(values.context),
		schedule: jsonOrNull(values.schedule),
		updatedById: values.updatedById,
	};
	const update = async () => {
		const existing = await findOverride(scope);
		return existing
			? db.reportTemplateOverride.update({
					where: { id: existing.id },
					data,
					select: OVERRIDE_SELECT,
				})
			: null;
	};
	const updated = await update();
	if (updated) {
		return updated;
	}
	try {
		return await db.reportTemplateOverride.create({
			data: { ...scope, ...data },
			select: OVERRIDE_SELECT,
		});
	} catch (error) {
		if (
			error instanceof Prisma.PrismaClientKnownRequestError &&
			error.code === "P2002"
		) {
			const raced = await update();
			if (raced) {
				return raced;
			}
		}
		throw error;
	}
}

/** Removes one scope's defaults, so reports fall back to the next scope's. */
export async function clearReportTemplateOverride(
	scope: ReportTemplateOverrideScope,
): Promise<void> {
	await db.reportTemplateOverride.deleteMany({
		where: {
			templateId: scope.templateId,
			organizationId: scope.organizationId,
			projectId: scope.projectId,
		},
	});
}
