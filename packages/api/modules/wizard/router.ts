import { createTempUploadUrlProcedure } from "./procedures/create-temp-upload-url";
import { deleteTempContextProcedure } from "./procedures/delete-temp-context";
import { getRecommendationsProcedure } from "./procedures/get-recommendations";
import { listTempContextsProcedure } from "./procedures/list-temp-contexts";
import { moveToProjectProcedure } from "./procedures/move-to-project";
import { processTempFileProcedure } from "./procedures/process-temp-file";
import { refineDescriptionProcedure } from "./procedures/refine-description";
import { updateTempContextTagProcedure } from "./procedures/update-temp-context-tag";

export const wizardRouter = {
	// Temp context operations for file uploads during wizard
	tempContexts: {
		createUploadUrl: createTempUploadUrlProcedure,
		process: processTempFileProcedure,
		list: listTempContextsProcedure,
		delete: deleteTempContextProcedure,
		moveToProject: moveToProjectProcedure,
		updateTag: updateTempContextTagProcedure,
	},

	// AI-powered description refinement
	refineDescription: refineDescriptionProcedure,

	// Auto-selection recommendations
	getRecommendations: getRecommendationsProcedure,
};
