/**
 * Test Case EXECUTION PM Sync — result PUSH activity.
 *
 * The run/result push counterpart of `test-case-sync.ts`: turn a case's current
 * result into the PM tool's test-run/result concept (Azure DevOps Test Results).
 * Only Azure DevOps exposes a native executions API this phase; other providers
 * are gated off upstream. The outcome mapping lives in the pure
 * `test-execution-serializer.ts` so the workflow and this activity share one
 * contract.
 *
 * ─── LIVE GAP (deferred, intentional) ────────────────────────────────────────
 * The actual Azure DevOps **Test Results REST** POST is NOT wired here — ADO Test
 * Plans/Runs/Results are a separate REST surface from the generic work-item MCP
 * tools this engine drives, and exercising them needs a real ADO Test connection.
 * So `pushTestCaseExecutionToPM` builds the real Test Result payload and returns
 * it marked `deferred` WITHOUT POSTing it. It is invoked by `testCaseSyncWorkflow`
 * behind `patched("test-case-execution-sync-v1")`; the run-ingestion (pull) side
 * and its UI were removed as unused, leaving only this replay-referenced push.
 */

import { logger } from "@repo/logs";
import {
	type AdoTestResultPayload,
	buildAdoTestResultPayload,
	type TestResultValue,
} from "./test-execution-serializer";

export interface PushTestCaseExecutionInput {
	testCaseId: string;
	projectId: string;
	/** The linked PM work-item id (Fabric `externalId`). */
	externalId: string;
	/** The case's current Fabric result to push. */
	result: TestResultValue;
	mcpConfigId: string | null;
	mcpServerId?: string;
	containerId: string;
	containerName?: string;
	additionalContext?: Record<string, string>;
	userId: string;
	organizationId?: string;
	/** Resolved provider `detectedType` (only "azure-devops" is supported). */
	detectedType?: string | null;
	/** Optional short comment carried onto the result. */
	comment?: string | null;
}

export interface PushTestCaseExecutionResult {
	/** True once the live POST is wired; always false while deferred. */
	pushed: boolean;
	/** True while the live ADO Test Results REST call is deferred. */
	deferred: boolean;
	/** ADO outcome vocabulary the result mapped to. */
	outcome: string;
	/** The (real) payload that WOULD be POSTed. */
	payload: AdoTestResultPayload;
}

/**
 * Push a single case's current result to the PM tool's Test Results API. Builds
 * the real ADO payload via the serializer; the live POST is DEFERRED (see the
 * module header) so this returns `{ pushed: false, deferred: true, … }`.
 * Provider-gated: only Azure DevOps has a native executions API this phase.
 */
export async function pushTestCaseExecutionToPM(
	input: PushTestCaseExecutionInput,
): Promise<PushTestCaseExecutionResult> {
	const payload = buildAdoTestResultPayload({
		externalId: input.externalId,
		result: input.result,
		comment: input.comment,
	});

	const isADO = (input.detectedType ?? "").toLowerCase() === "azure-devops";

	// DEFERRED: the live Azure DevOps Test Results POST goes here once a real ADO
	// Test connection is available. The payload above is the real, unit-tested
	// mapping — only the transport is missing.
	logger.info("[Test Execution Sync] execution push (deferred REST)", {
		testCaseId: input.testCaseId,
		externalId: input.externalId,
		outcome: payload.outcome,
		provider: input.detectedType ?? "unknown",
		supported: isADO,
	});

	return {
		pushed: false,
		deferred: true,
		outcome: payload.outcome,
		payload,
	};
}
