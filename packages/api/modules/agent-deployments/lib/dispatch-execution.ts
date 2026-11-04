import { getTemporalClient } from "@repo/temporal";
import { dispatchAdmittedAgentExecution as dispatch } from "@repo/temporal/agent-execution-dispatch";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";

/** Preserve request correlation while sharing receipt identity and authorization with recovery. */
export function dispatchAdmittedAgentExecution(
	execution: Parameters<typeof dispatch>[0],
	options: Parameters<typeof dispatch>[1] = {},
) {
	return dispatch(execution, options, {
		getClient: getTemporalClient,
		decorate: withCorrelationMemo,
	});
}
