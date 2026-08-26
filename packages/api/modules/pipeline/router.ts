/**
 * Pipeline API Router
 *
 * Provides endpoints for the PRD → Tasks pipeline:
 * - Start pipeline execution (via Temporal)
 * - Get pipeline status with stage details
 * - List user's pipeline executions
 */

import { getPipelineStatusProcedure } from "./procedures/get-status";
import { listPipelinesProcedure } from "./procedures/list-pipelines";
import { startPipelineProcedure } from "./procedures/start-pipeline";

export const pipelineRouter = {
	start: startPipelineProcedure,
	status: getPipelineStatusProcedure,
	list: listPipelinesProcedure,
};
