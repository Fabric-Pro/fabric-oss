import { downloadArtifactProcedure } from "./procedures/artifacts/download";
import { getArtifactProcedure } from "./procedures/artifacts/get";
import { listArtifactsProcedure } from "./procedures/artifacts/list";
import { listArtifactDeliveriesProcedure } from "./procedures/artifacts/list-deliveries";
import { sendArtifactEmailProcedure } from "./procedures/artifacts/send-email";
import { reportCapabilitiesProcedure } from "./procedures/capabilities";
import { archiveInstanceProcedure } from "./procedures/instances/archive";
import { cancelExecutionProcedure } from "./procedures/instances/cancel-execution";
import { createInstanceProcedure } from "./procedures/instances/create";
import { deleteInstanceProcedure } from "./procedures/instances/delete";
import { executeInstanceProcedure } from "./procedures/instances/execute";
import { generateFromTemplateProcedure } from "./procedures/instances/generate-from-template";
import { getInstanceProcedure } from "./procedures/instances/get";
import { listInstancesProcedure } from "./procedures/instances/list";
import { probeConnectionsProcedure } from "./procedures/instances/probe-connections";
import { restoreInstanceProcedure } from "./procedures/instances/restore";
import { testInstanceConnectionsProcedure } from "./procedures/instances/test-connections";
import { updateInstanceProcedure } from "./procedures/instances/update";
import { versionHistoryProcedure } from "./procedures/instances/versionHistory";
import { getIntegrationStatus } from "./procedures/integrations/status";
import {
	reportOrganizationProjectsProcedure,
	reportProjectProcedure,
} from "./procedures/report-projects";
import {
	archiveTemplateProcedure,
	unarchiveTemplateProcedure,
} from "./procedures/templates/archive";
import { createTemplateProcedure } from "./procedures/templates/create";
import { deleteTemplateProcedure } from "./procedures/templates/delete";
import { getTemplateProcedure } from "./procedures/templates/get";
import { listTemplatesProcedure } from "./procedures/templates/list";
import {
	getTemplateOverridesProcedure,
	setTemplateOverrideProcedure,
} from "./procedures/templates/overrides";
import { templateParameterDefaultsProcedure } from "./procedures/templates/parameter-defaults";
import { previewTemplateProcedure } from "./procedures/templates/preview";
import { publishTemplateProcedure } from "./procedures/templates/publish";
import { sampleTemplateProcedure } from "./procedures/templates/sample";
import { saveTemplatePromptProcedure } from "./procedures/templates/save-prompt";
import { attachReportTemplateSkillProcedure } from "./procedures/templates/skills-attach";
import { detachReportTemplateSkillProcedure } from "./procedures/templates/skills-detach";
import { listReportTemplateSkillsProcedure } from "./procedures/templates/skills-list";
import { updateTemplateProcedure } from "./procedures/templates/update";

export const reportsRouter = {
	capabilities: reportCapabilitiesProcedure,
	project: reportProjectProcedure,
	organizationProjects: reportOrganizationProjectsProcedure,

	// Template CRUD (reusable definitions)
	templates: {
		list: listTemplatesProcedure,
		get: getTemplateProcedure,
		create: createTemplateProcedure,
		update: updateTemplateProcedure,
		delete: deleteTemplateProcedure,
		archive: archiveTemplateProcedure,
		unarchive: unarchiveTemplateProcedure,
		// A personal template to the organization, or one to every tenant
		publish: publishTemplateProcedure,
		// A report's edited prompts written into its template
		savePrompt: saveTemplatePromptProcedure,
		preview: previewTemplateProcedure,
		sample: sampleTemplateProcedure,
		// What the create dialog fills on arrival, AI's suggestions included
		parameterDefaults: templateParameterDefaultsProcedure,
		skills: {
			list: listReportTemplateSkillsProcedure,
			attach: attachReportTemplateSkillProcedure,
			detach: detachReportTemplateSkillProcedure,
		},
		// An organization's and a project's defaults for new reports
		overrides: {
			get: getTemplateOverridesProcedure,
			set: setTemplateOverrideProcedure,
		},
	},

	// Template Instances (user's configured artifacts)
	instances: {
		create: createInstanceProcedure,
		list: listInstancesProcedure,
		get: getInstanceProcedure,
		update: updateInstanceProcedure,
		delete: deleteInstanceProcedure,
		execute: executeInstanceProcedure,
		// "Generate report" on a template card: make the report and start its run
		generateFromTemplate: generateFromTemplateProcedure,
		// The create dialog's readiness, before a report exists
		probeConnections: probeConnectionsProcedure,
		cancelExecution: cancelExecutionProcedure,
		testConnections: testInstanceConnectionsProcedure,
		versionHistory: versionHistoryProcedure,
		archive: archiveInstanceProcedure,
		restore: restoreInstanceProcedure,
	},

	// Artifact access
	artifacts: {
		list: listArtifactsProcedure,
		get: getArtifactProcedure,
		download: downloadArtifactProcedure,
		sendEmail: sendArtifactEmailProcedure,
		listDeliveries: listArtifactDeliveriesProcedure,
	},

	// Integration status
	integrations: {
		status: getIntegrationStatus,
	},
};
