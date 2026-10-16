/**
 * Submitting a Living Memory write (ADR-022): admit the request, store its
 * receipt and start the workflow that commits it or opens a pull request.
 *
 * One function for every surface that submits: the `memoryWrites.submit`
 * procedure (the app), the v1 REST route (the CLI) and the MCP gateway tool.
 * Each has already settled who the caller is and that they hold
 * CONTEXT_CREATE on the project; this owns what follows, so the surfaces differ
 * only in how they ask and how they answer. It returns a typed result and
 * throws nothing for a refusal; the caller turns it into its own error shape.
 */

import {
	type MemoryWriteStatus,
	type MemoryWriteVia,
	settleMemoryWrite,
} from "@repo/database";
import type { MemoryWriteProblem } from "@repo/temporal/memory-write/evaluate";
import { MEMORY_WRITE_MAX_PENDING } from "@repo/temporal/memory-write-types";
import {
	type AuditRequestContext,
	recordAuditFromRequest,
} from "../../../../lib/audit";
import { admitMemoryWrite, type SubmitEntryInput } from "./admit-memory-write";
import { startMemoryWriteWorkflow } from "./start-memory-write-workflow";

export type SubmitMemoryWriteRequestResult =
	| {
			kind: "accepted";
			writeId: string;
			status: MemoryWriteStatus;
			digest: string;
			deduplicated: boolean;
	  }
	| { kind: "refused"; problems: MemoryWriteProblem[] }
	| { kind: "too-many-pending"; limit: number }
	| { kind: "start-failed" };

/**
 * The receipt of a request whose workflow could not be started is closed out
 * on the spot: nothing is behind it, and a `PENDING` receipt nothing settles
 * would count against the member's cap. It is retryable: the same request sent
 * again is a new write.
 */
async function closeOutUnstartedWrite(input: {
	writeId: string;
	projectId: string;
	organizationId: string;
}): Promise<void> {
	try {
		await settleMemoryWrite({
			...input,
			status: "FAILED",
			outcome: {
				status: "FAILED",
				code: "WORKFLOW_START_FAILED",
				retryable: true,
			},
			metadata: { code: "WORKFLOW_START_FAILED", retryable: true },
		});
	} catch {
		// The caller is told the start failed. A receipt left pending ages out
		// of the member's cap (`MEMORY_WRITE_PENDING_WINDOW_MS`).
	}
}

export async function submitMemoryWriteRequest(input: {
	projectId: string;
	organizationId: string;
	userId: string;
	via: MemoryWriteVia;
	/** The OAuth client the request came through, when it came through one. */
	oauthClientId: string | null;
	targetId: string;
	message: string;
	entries: readonly SubmitEntryInput[];
	audit: AuditRequestContext;
}): Promise<SubmitMemoryWriteRequestResult> {
	const { projectId, organizationId } = input;
	const admitted = await admitMemoryWrite({
		projectId,
		organizationId,
		userId: input.userId,
		via: input.via,
		oauthClientId: input.oauthClientId,
		targetId: input.targetId,
		message: input.message,
		entries: input.entries,
	});
	if (admitted.kind === "refused") {
		return { kind: "refused", problems: admitted.problems };
	}
	if (admitted.kind === "too-many-pending") {
		return { kind: "too-many-pending", limit: MEMORY_WRITE_MAX_PENDING };
	}

	const { writeId } = admitted;
	if (!admitted.deduplicated) {
		recordAuditFromRequest(input.audit, {
			action: "project.context.memory_write_submitted",
			category: "project",
			organizationId,
			projectId,
			resource: {
				type: "project_memory_write",
				id: writeId,
				name: admitted.target.folder,
			},
			metadata: {
				folder: admitted.target.folder,
				mode: admitted.target.mode,
				via: input.via,
				fileCount: input.entries.length,
			},
		});
	}
	// A request that found its receipt still `PENDING` starts the workflow
	// again: an earlier request may have stored the receipt and failed to
	// start it, and a start for a run that is open is not a failure.
	if (admitted.status === "PENDING") {
		try {
			await startMemoryWriteWorkflow({
				writeId,
				projectId,
				organizationId,
			});
		} catch {
			if (!admitted.deduplicated) {
				await closeOutUnstartedWrite({
					writeId,
					projectId,
					organizationId,
				});
			}
			return { kind: "start-failed" };
		}
	}
	return {
		kind: "accepted",
		writeId,
		status: admitted.status,
		digest: admitted.digest,
		deduplicated: admitted.deduplicated,
	};
}
