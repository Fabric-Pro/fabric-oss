import { downloadArtifactProcedure } from "./procedures/artifacts/download";
import { getArtifactProcedure } from "./procedures/artifacts/get";
import { listArtifactsProcedure } from "./procedures/artifacts/list";
import { listArtifactDeliveriesProcedure } from "./procedures/artifacts/list-deliveries";
import { sendArtifactEmailProcedure } from "./procedures/artifacts/send-email";
import { archiveInstanceProcedure } from "./procedures/instances/archive";
import { cancelExecutionProcedure } from "./procedures/instances/cancel-execution";
import { createInstanceProcedure } from "./procedures/instances/create";
import { deleteInstanceProcedure } from "./procedures/instances/delete";
import { executeInstanceProcedure } from "./procedures/instances/execute";
import { getInstanceProcedure } from "./procedures/instances/get";
import { listInstancesProcedure } from "./procedures/instances/list";
import { restoreInstanceProcedure } from "./procedures/instances/restore";
import { testInstanceConnectionsProcedure } from "./procedures/instances/test-connections";
import { updateInstanceProcedure } from "./procedures/instances/update";
import { versionHistoryProcedure } from "./procedures/instances/versionHistory";
import { getIntegrationStatus } from "./procedures/integrations/status";
import { createTemplateProcedure } from "./procedures/templates/create";
import { deleteTemplateProcedure } from "./procedures/templates/delete";
import { getTemplateProcedure } from "./procedures/templates/get";
import { listTemplatesProcedure } from "./procedures/templates/list";
import { attachReportTemplateSkillProcedure } from "./procedures/templates/skills-attach";
import { detachReportTemplateSkillProcedure } from "./procedures/templates/skills-detach";
import { listReportTemplateSkillsProcedure } from "./procedures/templates/skills-list";
import { updateTemplateProcedure } from "./procedures/templates/update";

export const reportsRouter = {
	// Template CRUD (reusable definitions)
	templates: {
		list: listTemplatesProcedure,
		get: getTemplateProcedure,
		create: createTemplateProcedure,
		update: updateTemplateProcedure,
		delete: deleteTemplateProcedure,
		skills: {
			list: listReportTemplateSkillsProcedure,
			attach: attachReportTemplateSkillProcedure,
			detach: detachReportTemplateSkillProcedure,
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
