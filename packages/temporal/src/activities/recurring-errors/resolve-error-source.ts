/**
 * Which log source a project's recurring-error scan reads, and how far it may
 * reach. The tenant boundary of the whole feature lives in this function.
 *
 * In order:
 *   1. The deployment's designated operator project
 *      (`FABRIC_RECURRING_ERRORS_OPERATOR_PROJECT_ID`) scans the deployment's
 *      shared telemetry workspace WITHOUT the organization predicate. Only
 *      that one project, named by the deployment, never by a project setting.
 *   2. A project bound to its own workspace scans that workspace. It is
 *      dedicated by construction, and the registry already refuses a binding
 *      that names the shared workspace. A binding that cannot be used throws,
 *      so the scan records it as its last error instead of going quiet.
 *   3. Otherwise the deployment default, which is shared, scanned only for the
 *      project's own organization and only when the deployment opted the
 *      shared workspace in for customer use.
 *   4. Otherwise nothing: the project has no source the scan can use, which
 *      is an ordinary outcome, not an error.
 *
 * MCP-discovered log tools are not consulted: they return rows, not groups,
 * and they run on a person's connection, which an unattended scan has none of.
 */
import type {
	ErrorGroupScope,
	LogSourceAdapter,
	RawErrorGroup,
} from "@repo/ai/lib/log-context";
import { getProjectLogSourceBinding } from "@repo/database";
import { createOperatorErrorScanAdapter } from "../backlog-context/azure-monitor-log-source";
import {
	resolveConfiguredLogSource,
	resolveProjectLogSource,
} from "../backlog-context/log-source-registry";

export type ErrorScanReach = "operator" | "dedicated" | "organization";

/** Shown as the scan's last error; names no workspace or provider detail. */
export const UNUSABLE_BINDING_REASON =
	"The project's log source could not be used: it names this deployment's shared telemetry workspace, or its settings are incomplete.";

export interface ResolvedErrorScanSource {
	label: string;
	reach: ErrorScanReach;
	summarize(
		scope: Omit<ErrorGroupScope, "organizationId">,
	): Promise<RawErrorGroup[]>;
}

function withSummarize(
	adapter: LogSourceAdapter | null,
	reach: ErrorScanReach,
	organizationId: string | undefined,
): ResolvedErrorScanSource | null {
	const summarize = adapter?.summarizeErrorGroups?.bind(adapter);
	if (!adapter || !summarize) {
		return null;
	}
	return {
		label: adapter.label,
		reach,
		// The organization bound is attached HERE, from the server-side project
		// row, so no caller of `summarize` can widen or swap it.
		summarize: (scope) => summarize({ ...scope, organizationId }),
	};
}

export async function resolveRecurringErrorSource(project: {
	projectId: string;
	organizationId: string | null;
}): Promise<ResolvedErrorScanSource | null> {
	const operator = createOperatorErrorScanAdapter(project.projectId);
	if (operator) {
		return withSummarize(operator, "operator", undefined);
	}

	const binding = await getProjectLogSourceBinding(project.projectId);
	if (binding) {
		const bound = resolveProjectLogSource(binding.provider, binding.config);
		// A project that names a source gets that source or none — never a
		// silent fallback to the shared workspace. Unlike having no source at
		// all, a binding nobody can use is a failure the admin must see.
		const source =
			bound && !bound.sharedStore
				? withSummarize(bound, "dedicated", undefined)
				: null;
		if (!source) {
			throw new Error(UNUSABLE_BINDING_REASON);
		}
		return source;
	}

	const configured = resolveConfiguredLogSource();
	if (!configured || !project.organizationId) {
		return null;
	}
	return withSummarize(
		configured,
		configured.sharedStore ? "organization" : "dedicated",
		project.organizationId,
	);
}
