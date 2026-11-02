import { createProcedureClient } from "@orpc/server";
import { wireAuditObservability } from "../../../lib/audit";
import {
	extractCorrelationId,
	generateCorrelationId,
	runWithCorrelationId,
} from "../../../lib/correlation-id";
import { getAiConfigStatusProcedure } from "../../ai-config/procedures/resolution/get-status";
import { getRegisteredAgent } from "../procedures/registry/get-registered-agent";

/** Server-rendered chat reads retain their procedures without a self-HTTP hop. */
export function createAgentChatServerClient(requestHeaders: Headers) {
	wireAuditObservability();
	const headers = new Headers(requestHeaders);
	const correlationId =
		extractCorrelationId(headers) ?? generateCorrelationId();
	headers.set("x-correlation-id", correlationId);
	const context = { headers };
	return {
		getRegisteredAgent: createProcedureClient(getRegisteredAgent, {
			path: ["agents", "registry", "get"],
			context,
			interceptors: [
				({ next }) => runWithCorrelationId(correlationId, next),
			],
		}),
		getAiConfigStatus: createProcedureClient(getAiConfigStatusProcedure, {
			path: ["aiConfig", "resolution", "getStatus"],
			context,
			interceptors: [
				({ next }) => runWithCorrelationId(correlationId, next),
			],
		}),
	};
}
