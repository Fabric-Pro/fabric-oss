/**
 * Coding Runs Router
 *
 * Routes for managing background agent coding execution sessions.
 */

import { cancelCodingRunProcedure } from "./procedures/cancel-coding-run";
import { getCodingRunProcedure } from "./procedures/get-coding-run";
import { listCodingRunsProcedure } from "./procedures/list-coding-runs";
import { pollLiveStatusProcedure } from "./procedures/poll-live-status";
import { sendFollowUpProcedure } from "./procedures/send-follow-up";
import { startCodingRunProcedure } from "./procedures/start-coding-run";

export const codingRunsRouter = {
	start: startCodingRunProcedure,
	get: getCodingRunProcedure,
	list: listCodingRunsProcedure,
	cancel: cancelCodingRunProcedure,
	pollLiveStatus: pollLiveStatusProcedure,
	sendFollowUp: sendFollowUpProcedure,
};
