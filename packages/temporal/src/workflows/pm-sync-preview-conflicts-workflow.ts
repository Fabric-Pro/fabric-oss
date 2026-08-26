/**
 * PM Sync Preview Conflicts Workflow
 *
 * Fan-out wrapper around `previewPmSyncConflict` used by the
 * `checkPmSyncConflicts` API procedure. The workflow runs the read-only
 * activity for each item in parallel via `Promise.allSettled` and returns
 * an array of per-item results in the same order as the input.
 */

import { proxyActivities } from "@temporalio/workflow";

import type {
	PmSyncErrorKind,
	previewPmSyncConflict as PreviewPmSyncConflictFn,
	PreviewPmSyncItemType,
} from "../activities/pm-integration/preview-pm-sync-conflict";

export interface PmSyncPreviewItemRef {
	id: string;
	itemType: PreviewPmSyncItemType;
}

export interface PmSyncPreviewConflictsWorkflowInput {
	items: PmSyncPreviewItemRef[];
	projectId: string;
	/**
	 * `null` only on the GitLab REST fallback path (no MCPConfig pinned). The
	 * activity then routes through the REST source resolver instead of MCP.
	 */
	mcpConfigId: string | null;
	mcpServerId?: string;
	containerId: string;
	containerName?: string;
	additionalContext?: Record<string, string>;
	userId: string;
	organizationId?: string;
}

export interface PmSyncPreviewConflictsItem {
	id: string;
	itemType: PreviewPmSyncItemType;
	hasConflict: boolean;
	pmCurrent?: {
		title: string;
		description: string;
		lastChangedBy: string | null;
		lastChangedAt: string | null;
	};
	pmUrl?: string;
	pmError?: { kind: PmSyncErrorKind; code?: string };
}

export interface PmSyncPreviewConflictsWorkflowOutput {
	results: PmSyncPreviewConflictsItem[];
}

const { previewPmSyncConflict } = proxyActivities<{
	previewPmSyncConflict: typeof PreviewPmSyncConflictFn;
}>({
	startToCloseTimeout: "30 seconds",
	heartbeatTimeout: "15 seconds",
	retry: {
		initialInterval: "1s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
		nonRetryableErrorTypes: [
			"PmAuthError",
			"PmNotFoundError",
			"PmCapabilitiesError",
		],
	},
});

export async function pmSyncPreviewConflictsWorkflow(
	input: PmSyncPreviewConflictsWorkflowInput,
): Promise<PmSyncPreviewConflictsWorkflowOutput> {
	const {
		items,
		projectId,
		mcpConfigId,
		mcpServerId,
		containerId,
		containerName,
		additionalContext,
		userId,
		organizationId,
	} = input;

	const settled = await Promise.allSettled(
		items.map((item) =>
			previewPmSyncConflict({
				itemId: item.id,
				itemType: item.itemType,
				projectId,
				mcpConfigId,
				mcpServerId,
				containerId,
				containerName,
				additionalContext,
				userId,
				organizationId,
			}),
		),
	);

	const results: PmSyncPreviewConflictsItem[] = items.map((item, idx) => {
		const entry = settled[idx];
		if (entry?.status === "fulfilled") {
			return {
				id: item.id,
				itemType: item.itemType,
				hasConflict: entry.value.hasConflict,
				pmCurrent: entry.value.pmCurrent,
				pmUrl: entry.value.pmUrl,
				pmError: entry.value.pmError,
			};
		}
		// Rejected after retries (unexpected throw, e.g. a non-retryable
		// capability error or a DB failure). The activity converts known
		// credential/fetch failures into a `pmError` on the fulfilled path, so
		// a rejection here is genuinely unexpected — surface it as TRANSIENT so
		// the UI offers "retry" rather than rendering a blank PM side.
		return {
			id: item.id,
			itemType: item.itemType,
			hasConflict: false,
			pmError: { kind: "TRANSIENT" },
		};
	});

	return { results };
}
