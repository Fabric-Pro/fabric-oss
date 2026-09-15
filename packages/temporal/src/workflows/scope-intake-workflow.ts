/**
 * Scope Intake Workflow (plan §Slice 1)
 *
 * Runs on the `project-documents` task queue with a deterministic id
 * (`scope-intake-${contextId}`) so a double-click never starts two imports.
 *
 *   1. awaitContextExtracted — bounded poll on the context's extraction status
 *   2. extractScopeItems     — deterministic pre-pass + chunked LLM pass
 *   3. persistScopeProposal  — SCOPE_DOCUMENT PendingBacklogProposal
 *
 * Nothing is written to the backlog here; stories are created only when a
 * reviewer approves the proposal in the inbox (backlogApplyChangesWorkflow).
 */

import {
	ApplicationFailure,
	defineQuery,
	defineSignal,
	log,
	proxyActivities,
	setHandler,
} from "@temporalio/workflow";
import type {
	awaitContextExtracted as AwaitContextExtractedFn,
	extractScopeItems as ExtractScopeItemsFn,
	persistScopeProposal as PersistScopeProposalFn,
} from "../activities/scope-intake";

// =============================================================================
// Types
// =============================================================================

export interface ScopeIntakeInput {
	projectId: string;
	contextId: string;
	userId: string;
	organizationId?: string;
	/** Optional reviewer hints forwarded to the extraction model. */
	hints?: string;
}

export type ScopeIntakeStatus =
	| "awaiting_extraction"
	| "extracting"
	| "persisting"
	| "completed"
	| "cancelled"
	| "failed";

export interface ScopeIntakeProgress {
	status: ScopeIntakeStatus;
	message: string;
	contextId: string;
	originalFilename?: string | null;
	rowCount?: number;
	areaCount?: number;
	changeCount?: number;
	proposalId?: string;
	llmUsed?: boolean;
	error?: string;
}

export interface ScopeIntakeOutput {
	proposalId: string;
	changeCount: number;
	rowCount: number;
}

// =============================================================================
// Signals & Queries
// =============================================================================

export const cancelIntakeSignal = defineSignal("cancelIntake");
export const intakeProgressQuery =
	defineQuery<ScopeIntakeProgress>("intakeProgress");

// =============================================================================
// Activity proxies
// =============================================================================

const { awaitContextExtracted } = proxyActivities<{
	awaitContextExtracted: typeof AwaitContextExtractedFn;
}>({
	// The activity itself polls for up to 10 minutes and heartbeats each tick.
	startToCloseTimeout: "12 minutes",
	heartbeatTimeout: "1 minute",
	retry: {
		initialInterval: "5s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

const { extractScopeItems } = proxyActivities<{
	extractScopeItems: typeof ExtractScopeItemsFn;
}>({
	startToCloseTimeout: "15 minutes",
	heartbeatTimeout: "3 minutes",
	retry: {
		initialInterval: "5s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

const { persistScopeProposal } = proxyActivities<{
	persistScopeProposal: typeof PersistScopeProposalFn;
}>({
	startToCloseTimeout: "1 minute",
	retry: {
		initialInterval: "2s",
		backoffCoefficient: 2,
		maximumAttempts: 5,
	},
});

// =============================================================================
// Workflow
// =============================================================================

export async function scopeIntakeWorkflow(
	input: ScopeIntakeInput,
): Promise<ScopeIntakeOutput> {
	const { projectId, contextId, userId, organizationId, hints } = input;

	let cancelled = false;
	const progress: ScopeIntakeProgress = {
		status: "awaiting_extraction",
		message: "Waiting for text extraction to finish...",
		contextId,
	};

	setHandler(cancelIntakeSignal, () => {
		log.info("Scope intake cancel signal received", { contextId });
		cancelled = true;
	});
	setHandler(intakeProgressQuery, () => progress);

	const assertNotCancelled = () => {
		if (cancelled) {
			progress.status = "cancelled";
			progress.message = "Scope intake cancelled by user";
			throw ApplicationFailure.nonRetryable(
				"Scope intake cancelled by user",
				"SCOPE_INTAKE_CANCELLED",
			);
		}
	};

	try {
		log.info("Starting scope intake", { projectId, contextId });

		const extracted = await awaitContextExtracted({ contextId, projectId });
		progress.originalFilename = extracted.originalFilename;
		assertNotCancelled();

		progress.status = "extracting";
		progress.message = "Reading scope items from the document...";
		const extraction = await extractScopeItems({
			text: extracted.text,
			projectId,
			userId,
			organizationId,
			contextId,
			originalFilename: extracted.originalFilename,
			hints,
		});
		progress.rowCount = extraction.stats.rowCount;
		progress.areaCount = extraction.stats.areaCount;
		progress.changeCount = extraction.proposal.changes.length;
		progress.llmUsed = extraction.stats.llmUsed;
		assertNotCancelled();

		progress.status = "persisting";
		progress.message = "Saving proposal for review...";
		const persisted = await persistScopeProposal({
			projectId,
			userId,
			organizationId,
			contextId,
			originalFilename: extracted.originalFilename,
			proposal: extraction.proposal,
			rowCount: extraction.stats.rowCount,
		});

		progress.status = "completed";
		progress.proposalId = persisted.proposalId;
		progress.message = `${persisted.changeCount} proposed change(s) ready for review.`;

		log.info("Scope intake completed", {
			projectId,
			contextId,
			proposalId: persisted.proposalId,
			changeCount: persisted.changeCount,
		});

		return {
			proposalId: persisted.proposalId,
			changeCount: persisted.changeCount,
			rowCount: extraction.stats.rowCount,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (progress.status !== "cancelled") {
			progress.status = "failed";
			progress.message = message;
		}
		progress.error = message;
		log.error("Scope intake failed", {
			projectId,
			contextId,
			error: message,
		});
		if (error instanceof ApplicationFailure) {
			throw error;
		}
		throw ApplicationFailure.nonRetryable(message, "SCOPE_INTAKE_FAILED");
	}
}
