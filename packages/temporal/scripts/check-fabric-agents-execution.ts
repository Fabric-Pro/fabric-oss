import { parseArgs } from "node:util";
import { getAuthHeaders } from "../src/lib/coding-execution/auth";
import { FabricBackgroundAdapter } from "../src/lib/coding-execution/background-agents-provider";
import {
	getBackgroundAgentsSecret,
	getBackgroundAgentsUrl,
} from "../src/lib/coding-execution/env";

/** Read-only cutover preflight. Never creates sessions, invokes models, or toggles rollout. */
const { values } = parseArgs({
	options: {
		repo: { type: "string" },
		organization: { type: "string" },
		connection: { type: "string" },
		model: { type: "string" },
	},
});
const parts = values.repo?.split("/");
if (
	!parts ||
	parts.length !== 2 ||
	!parts.every((part) => /^[a-zA-Z0-9_.-]+$/.test(part)) ||
	!values.organization
) {
	throw new Error(
		"Usage: --repo example-org/example-repo --organization example-org [--connection example-provider --model example-model]",
	);
}
const [repoOwner, repoName] = parts;
if (!repoOwner || !repoName) {
	throw new Error("A repository owner and name are required");
}
const readiness = await new FabricBackgroundAdapter().executionReadiness({
	repoOwner,
	repoName,
	organizationId: values.organization,
	llmConnection: values.connection,
	model: values.model,
});
const response = await fetch(
	`${getBackgroundAgentsUrl().replace(/\/+$/, "")}/sessions/drain`,
	{
		headers: getAuthHeaders(getBackgroundAgentsSecret()),
		signal: AbortSignal.timeout(20_000),
		redirect: "error",
	},
);
if (!response.ok) {
	throw new Error(`Native drain could not be verified (${response.status})`);
}
const drain = (await response.json()) as {
	drained?: boolean;
	activeSessionIds?: string[];
	unboundReservations?: number;
};
console.log(
	JSON.stringify(
		{
			ready: readiness.ready,
			drained: drain.drained === true,
			checks: readiness.checks,
			protocolVersion: readiness.protocolVersion,
			permissionMode: readiness.permissionMode,
			activeSessionCount: drain.activeSessionIds?.length,
			unboundReservations: drain.unboundReservations,
			liveAcceptanceRequired: true,
		},
		null,
		2,
	),
);
if (drain.drained !== true) {
	process.exitCode = 1;
}
