/**
 * Activity: draft a pending proposal's body through the project's Bug/Feature
 * prompt, off the request path, and persist the result.
 *
 * Backs the server-persisted, team-shared in-review draft: the inbox claims the
 * `(proposalId, kind)` slot (race-safe) and starts ONE of these workflows; this
 * activity runs the ~minute-long `draftBodyByKind` LLM call and writes the
 * finished draft back via `completeProposalDraft`. The write is a compare-and-set
 * on RUNNING, so if the reviewer cancelled the draft mid-flight (proceeded with
 * creation), the result is dropped rather than overwriting the CANCELLED row.
 */

import {
	completeProposalDraft,
	failProposalDraft,
	type StoryKind,
} from "@repo/database";
import { logger } from "@repo/logs";
import { heartbeat } from "@temporalio/activity";
import { draftBodyByKind } from "../../lib/create-story-from-proposal";

export interface DraftProposalBodyInput {
	proposalId: string;
	kind: StoryKind;
	projectId: string;
	organizationId?: string;
	userId: string;
	title: string;
	description?: string;
	acceptanceCriteria?: string;
}

export async function draftProposalBodyActivity(
	input: DraftProposalBodyInput,
): Promise<{ status: "completed" | "failed" | "discarded" }> {
	// Keep the activity live across the LLM call (heartbeatTimeout is the
	// liveness gate, not startToCloseTimeout).
	heartbeat("draft-start");
	const hb = setInterval(() => {
		try {
			heartbeat("drafting");
		} catch {
			// heartbeat throws only outside an activity context; ignore.
		}
	}, 15_000);

	try {
		const result = await draftBodyByKind({
			projectId: input.projectId,
			organizationId: input.organizationId,
			userId: input.userId,
			kind: input.kind,
			title: input.title,
			description: input.description,
			acceptanceCriteria: input.acceptanceCriteria,
		});

		if (!result.aiDrafted) {
			// No bound prompt or the AI call fell back — there's no real draft to
			// persist. Mark FAILED so the UI offers "Draft again" and create falls
			// back to the apply-time draft.
			await failProposalDraft({
				proposalId: input.proposalId,
				kind: input.kind,
				error: "Draft prompt unavailable — no formatted draft was generated.",
			});
			return { status: "failed" };
		}

		const wrote = await completeProposalDraft({
			proposalId: input.proposalId,
			kind: input.kind,
			description: result.description,
			acceptanceCriteria: result.acceptanceCriteria ?? null,
			needsMoreInfo: result.needsMoreInfo ?? null,
		});
		// wrote === false ⇒ the row was no longer RUNNING (cancelled mid-flight).
		// Drop the result; the reviewer already moved on.
		return { status: wrote ? "completed" : "discarded" };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logger.warn("[draftProposalBodyActivity] draft failed", {
			proposalId: input.proposalId,
			kind: input.kind,
			error: message,
		});
		await failProposalDraft({
			proposalId: input.proposalId,
			kind: input.kind,
			error: message,
		});
		return { status: "failed" };
	} finally {
		clearInterval(hb);
	}
}
