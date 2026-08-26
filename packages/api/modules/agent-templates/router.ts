/**
 * Agent Templates Router
 *
 * Agent template system API.
 */

import { createInstanceProcedure } from "./procedures/instances/create";
import { deleteInstanceProcedure } from "./procedures/instances/delete";
import {
	getInstanceProcedure,
	getVersionHistoryProcedure,
} from "./procedures/instances/get";
import { listInstancesProcedure } from "./procedures/instances/list";
import {
	archiveInstanceProcedure,
	restoreInstanceProcedure,
	updateInstanceProcedure,
} from "./procedures/instances/update";
import { getCategoriesProcedure } from "./procedures/templates/categories";
import { createTemplateProcedure } from "./procedures/templates/create";
import { deleteTemplateProcedure } from "./procedures/templates/delete";
import { getFeaturedProcedure } from "./procedures/templates/featured";
import { getTemplateProcedure } from "./procedures/templates/get";
import { listTemplatesProcedure } from "./procedures/templates/list";
import { searchForMentionProcedure } from "./procedures/templates/search-for-mention";
import { attachTemplateSkillProcedure } from "./procedures/templates/skills-attach";
import { detachTemplateSkillProcedure } from "./procedures/templates/skills-detach";
import { listTemplateSkillsProcedure } from "./procedures/templates/skills-list";
import { updateTemplateProcedure } from "./procedures/templates/update";

export const agentTemplatesRouter = {
	// Template CRUD (reusable definitions)
	templates: {
		list: listTemplatesProcedure,
		get: getTemplateProcedure,
		create: createTemplateProcedure,
		update: updateTemplateProcedure,
		delete: deleteTemplateProcedure,
		categories: getCategoriesProcedure,
		featured: getFeaturedProcedure,
		searchForMention: searchForMentionProcedure,
		// Template skill management
		skills: {
			list: listTemplateSkillsProcedure,
			attach: attachTemplateSkillProcedure,
			detach: detachTemplateSkillProcedure,
		},
	},

	// Template Instances (user's configured agents)
	instances: {
		list: listInstancesProcedure,
		get: getInstanceProcedure,
		create: createInstanceProcedure,
		update: updateInstanceProcedure,
		delete: deleteInstanceProcedure,
		// Versioning endpoints
		versionHistory: getVersionHistoryProcedure,
		archive: archiveInstanceProcedure,
		restore: restoreInstanceProcedure,
	},
};
