/**
 * "Generate report" on a template card: make the report and start its run in
 * one click when nothing is missing. When something is, nothing is written and
 * the person is sent to the dialog. Once the report exists, a refused run sends
 * them to its page with the reason.
 */

import {
	canAccessReportInstance,
	getReportTemplate,
	getReportTemplateOverrides,
	hasProjectKnowledgeSource,
	mergeReportTemplateOverrides,
	promptDefaultsWrittenByOthers,
	reportEvidenceConfigSchema,
} from "@repo/database";
import {
	createReportFromTemplate,
	reportInstanceConnectionsSchema,
	startingReportParameters,
} from "./report-creation";
import {
	loadGeneratableReport,
	startReportGeneration,
} from "./report-generation";
import { reportGenerationBlockedReason } from "./report-generation-readiness";
import { suggestReportParameters } from "./report-parameter-suggestions";
import {
	missingReportSetup,
	resolveProjectReportBindings,
} from "./report-project-connection";
import { ReportGenerationError } from "./report-refusal";
import { isOrganizationOwnedTemplate } from "./template-prompts";

export type OneClickReportResult =
	| {
			outcome: "started";
			instanceId: string;
			executionId: string;
			startConfirmed: boolean;
	  }
	| { outcome: "needs-setup"; missing: string[] }
	| { outcome: "refused"; instanceId: string; reason: string };

/**
 * For a caller already authorized to add and generate reports in the project.
 * The run is started as `execute` starts it: a person clicked and waits for it.
 * A retry makes a new report, so nothing here deduplicates a click: the run rate
 * limit, taken before anything is written, is what bounds repeated ones.
 */
export async function generateReportFromTemplate({
	caller,
	organizationId,
	projectId,
	templateId,
	enforceRateLimit,
	enforceRunRateLimit,
}: {
	caller: { id: string; role?: string | null };
	organizationId: string;
	projectId: string;
	templateId: string;
	/** Taken only when AI has parameters to fill. */
	enforceRateLimit: () => Promise<void>;
	/** Taken once nothing stands in the way, before the report is created. */
	enforceRunRateLimit: () => Promise<void>;
}): Promise<OneClickReportResult> {
	const template = await getReportTemplate({
		id: templateId,
		userId: caller.id,
		organizationId,
	});
	if (!template) {
		throw new ReportGenerationError(
			"NOT_FOUND",
			"Report template not found or access denied",
		);
	}
	if (template.archivedAt) {
		throw new ReportGenerationError(
			"BAD_REQUEST",
			"This report template is archived",
		);
	}

	const reporting = hasProjectKnowledgeSource(template.definition)
		? reportEvidenceConfigSchema.parse({
				version: 1,
				period: "weekly",
				projectId,
			})
		: undefined;
	if (
		reporting &&
		!(await canAccessReportInstance(
			{
				userId: caller.id,
				organizationId,
				fabricConfig: { reporting },
			},
			{ userId: caller.id, organizationId },
			undefined,
			true,
		))
	) {
		throw new ReportGenerationError(
			"FORBIDDEN",
			"Project report access denied",
		);
	}

	const [bindings, storedOverrides] = await Promise.all([
		resolveProjectReportBindings({
			projectId,
			definition: template.definition,
			userId: caller.id,
			organizationId,
		}),
		getReportTemplateOverrides({
			templateId,
			organizationId,
			projectId,
		}),
	]);
	// A default prompt someone else wrote would run on the caller's connections
	// and credits, so they read it in the dialog before anything runs.
	if (
		promptDefaultsWrittenByOthers(storedOverrides, caller.id, {
			organizationPromptsApply: !isOrganizationOwnedTemplate(
				template,
				organizationId,
			),
		})
	) {
		return {
			outcome: "needs-setup",
			missing: [
				"Someone else set the default prompts for this template. Read them before you generate this report.",
			],
		};
	}
	const overrides = mergeReportTemplateOverrides(
		storedOverrides.organization,
		storedOverrides.project,
	);
	const connections = reportInstanceConnectionsSchema.parse(
		bindings?.connections ?? {},
	);
	const missingSetup = missingReportSetup(template.definition, bindings, {
		...overrides.context,
		...connections.context,
	});
	if (missingSetup.length > 0) {
		// Nothing is spent on AI for a report the person has to finish anyway.
		return { outcome: "needs-setup", missing: missingSetup };
	}

	const starting = await startingReportParameters({
		templateParameters: template.parameters,
		organizationId,
		projectId,
		overrideValues: overrides.parameterDefaults,
	});
	const suggested = await suggestReportParameters({
		template,
		filled: starting,
		projectId,
		caller,
		organizationId,
		enforceRateLimit,
	});
	const blockedReason = reportGenerationBlockedReason({
		isActive: true,
		connections,
		parameterDefaults: { ...starting, ...suggested },
		fabricConfig: reporting ? { reporting } : undefined,
		template,
	});
	if (blockedReason) {
		return { outcome: "needs-setup", missing: [blockedReason] };
	}

	await enforceRunRateLimit();

	let instanceId: string;
	try {
		const instance = await createReportFromTemplate({
			caller,
			organizationId,
			creation: {
				templateId,
				name: `My ${template.name}`,
				projectId,
				connections,
				reporting,
				parameterDefaults: suggested,
			},
		});
		instanceId = instance.id;
	} catch (error) {
		// Connections that fail validation are the person's to fix on the form.
		if (
			error instanceof ReportGenerationError &&
			error.code === "BAD_REQUEST"
		) {
			return { outcome: "needs-setup", missing: [error.message] };
		}
		throw error;
	}

	try {
		const instance = await loadGeneratableReport(
			instanceId,
			caller,
			organizationId,
		);
		const run = await startReportGeneration({
			instance,
			caller,
			organizationId,
			planEligible: true,
		});
		return {
			outcome: "started",
			instanceId,
			executionId: run.executionId,
			startConfirmed: run.startConfirmed,
		};
	} catch (error) {
		if (error instanceof ReportGenerationError) {
			return { outcome: "refused", instanceId, reason: error.message };
		}
		throw error;
	}
}
