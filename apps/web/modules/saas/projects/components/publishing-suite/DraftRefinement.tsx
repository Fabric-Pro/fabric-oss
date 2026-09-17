"use client";

/**
 * The refinement proposal, shared by all seven content-type panels: the three
 * mutations that drive it, the five states the server can report, and the
 * surface that renders each one.
 *
 * ## Why this is one module and not seven copies
 *
 * A refinement does not vary by content type — it revises a Markdown body to an
 * instruction, and every working draft body is Markdown — which is why the
 * server ships ONE set of procedures for all seven where generation needs
 * seven. The client half had drifted the other way: seven panels each holding
 * their own `refineInFlight` flag, their own falling-edge effect, and their own
 * copy of the accept path. The accept path is the one that writes, and seven
 * copies of it is seven chances to get the concurrency token wrong.
 *
 * ## The five states, none of which is optional to handle
 *
 * A refinement is a long async run, so it has the same failure modes a
 * generation has and the panel has to say so:
 *
 *   - GENERATING, live — the action row shows its own pending line.
 *   - GENERATING, `isExpired` — STRANDED. The deadline passed with nothing
 *     committed. Deliberately fail-open on the server (a proposal with no
 *     deadline recorded reads as expired), because the alternative is a
 *     spinner no user action can clear.
 *   - READY — the proposal, reviewed as a diff.
 *   - READY, `isStale` — the saved body moved after the proposal was computed.
 *     Accept is NOT offered: `acceptRefinement` refuses this with
 *     `baseline_changed`, so the button would be an action guaranteed to fail.
 *   - FAILED — the run reported an error.
 *
 * Every one of the last four offers Discard, and `rejectRefinement` accepts a
 * proposal in any state including one still running. That is the recovery
 * route: a stranded or failed proposal that could not be dismissed would sit on
 * the panel forever.
 */

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { XIcon } from "lucide-react";
import { toast } from "sonner";
import type {
	TopicRefinementState,
	TopicWorkingDraftState,
} from "./GenerationTabs";
import { RefinedDraftReview } from "./RefinedDraftReview";
import type { PostType } from "./topic-shared";

/**
 * What a panel needs to drive one content type's refinement.
 *
 * An options object rather than a parameter list: five of these travel together
 * everywhere they go, and a positional list of five would be five chances to
 * transpose two strings the compiler cannot tell apart.
 */
export interface DraftRefinementInput {
	projectId: string;
	topicId: string;
	organizationId: string | null;
	postType: PostType;
	/** The working draft this proposal revises, as the read returned it. */
	working: TopicWorkingDraftState | null;
	/** The content type in prose — "blog post", "LinkedIn post". For copy. */
	label: string;
	/**
	 * Asked before an accept is sent; returning false cancels it.
	 *
	 * Accepting REPLACES the saved body, so a panel holding unsaved editor text
	 * has something to lose that no refresh brings back. The question belongs
	 * to the panel because only the panel knows whether its editor is dirty.
	 */
	confirmAccept?: () => boolean;
	/**
	 * Fired once an accept has been written.
	 *
	 * The panel's local editor override has to go with it — otherwise the
	 * reader accepts a refinement and goes on looking at the text it replaced,
	 * and the next Save writes that text back over what they just accepted.
	 */
	onAccepted?: () => void;
}

export interface DraftRefinementController {
	/** The proposal as the read returned it, or null when there is none. */
	state: TopicRefinementState | null;
	/**
	 * A refinement is in flight.
	 *
	 * The start mutation's own pending state is part of it, and load-bearing:
	 * `refineDraft` writes no draft row, so there is no `GENERATING` attempt to
	 * watch, and between the claim landing and the read reporting it the panel
	 * would otherwise look exactly as it did before the press.
	 */
	isRunning: boolean;
	/** Whether a fresh run may be started. False only while one is live. */
	canStart: boolean;
	/** Start a run. An empty instruction is refused — see the call site. */
	start: (instruction: string) => void;
	/**
	 * Save the reviewed proposal as the working draft.
	 *
	 * `merged` is the document after every per-change accept and reject, which
	 * the server writes in place of the proposal it stored. `null` means the
	 * review could not be serialized and NOTHING is sent — writing it as a body
	 * would destroy the draft.
	 */
	accept: (merged: string | null) => void;
	/** Discard the proposal in whatever state it is in. */
	reject: () => void;
	isAccepting: boolean;
	isRejecting: boolean;
}

export function useDraftRefinement(
	input: DraftRefinementInput,
): DraftRefinementController {
	const { projectId, topicId, organizationId, postType, working, label } =
		input;
	const queryClient = useQueryClient();
	const state = working?.refinement ?? null;

	// Awaited by each `onSuccess` below rather than fired and forgotten. React
	// Query holds the mutation pending until a promise returned from
	// `onSuccess` settles, which is what keeps `isRunning` continuous across
	// the gap between the write landing and the read reporting it. Worst case
	// if that ever stops holding is a flicker in the pending line, never a
	// state the user cannot leave.
	const invalidateDrafts = () =>
		queryClient.invalidateQueries({
			queryKey: orpc.projects.publishingSuite.listTopicDrafts.queryKey({
				input: { projectId, topicId, organizationId },
			}),
		});

	const start = useMutation(
		orpc.projects.publishingSuite.refineDraft.mutationOptions({
			onSuccess: async (result) => {
				// `started: false` is an ANSWER, not a failure — Temporal is
				// down, or a run this tab has not seen yet already holds the
				// slot. Reporting either as an error would send the reader
				// looking for a fault that is not theirs.
				if (!result.started) {
					toast.info(
						result.reason === "unavailable"
							? "Refining is unavailable right now. Try again in a few minutes."
							: `A refinement of this ${label} is already running.`,
					);
				}
				await invalidateDrafts();
			},
			onError: () => {
				toast.error("Could not start the refinement.");
			},
		}),
	);

	const accept = useMutation(
		orpc.projects.publishingSuite.acceptRefinement.mutationOptions({
			onSuccess: async () => {
				input.onAccepted?.();
				toast.success(`Saved as the working ${label}.`);
				await invalidateDrafts();
			},
			onError: async (error: unknown) => {
				const code = (error as { code?: string } | null)?.code;
				// The server sends two DIFFERENT conflicts here and they call
				// for opposite actions: `stale` means refresh and accept
				// again, `baseline_changed` means the proposal revises text
				// nobody has any more and has to be run again. Its own message
				// is the only thing that tells them apart, so it is preferred
				// over anything written here.
				if (code === "CONFLICT" || code === "NOT_FOUND") {
					const message = (error as { message?: unknown } | null)
						?.message;
					toast.error(
						typeof message === "string" && message.trim()
							? message
							: "The refinement is no longer available. Refreshed — take another look.",
					);
					await invalidateDrafts();
					return;
				}
				toast.error(`Could not save the refined ${label}.`);
			},
		}),
	);

	const reject = useMutation(
		orpc.projects.publishingSuite.rejectRefinement.mutationOptions({
			onSuccess: async () => {
				await invalidateDrafts();
			},
			onError: () => {
				toast.error("Could not discard the refinement.");
			},
		}),
	);

	const isRunning =
		start.isPending || (state?.status === "GENERATING" && !state.isExpired);

	return {
		state,
		isRunning,
		// A stranded run does NOT block the next one: the only code that
		// reclaims an abandoned proposal runs inside the next refine, so
		// disabling on `status === "GENERATING"` alone would lock the panel
		// with no user action able to free it.
		canStart: !isRunning,
		start: (instruction: string) => {
			start.mutate({
				projectId,
				topicId,
				organizationId,
				postType,
				instruction: instruction.trim() || null,
			});
		},
		accept: (merged: string | null) => {
			if (!working) {
				return;
			}
			if (merged === null) {
				// The null-not-empty contract `getEditorMarkdownForSave`
				// documents: a failed serialization must never be sent as a
				// body, because the server would write it and the draft is
				// gone. Fizzy #1987.
				toast.error(
					`Couldn't save the refined ${label} — the review could not be read. Nothing was changed.`,
				);
				return;
			}
			if (input.confirmAccept && !input.confirmAccept()) {
				return;
			}
			accept.mutate({
				projectId,
				topicId,
				organizationId,
				postType,
				// The REVIEWED text, which is what the reader decided change by
				// change. The server falls back to the proposal it stored when
				// this is absent; it is never absent from this call site,
				// because the reader has always been through the diff.
				body: merged,
				// The BODY's concurrency token, never the proposal's own
				// `updatedAt` sitting beside it: this is the compare-and-set
				// the server makes against the row it is about to replace.
				expectedUpdatedAt: new Date(working.updatedAt),
			});
		},
		reject: () => {
			reject.mutate({ projectId, topicId, organizationId, postType });
		},
		isAccepting: accept.isPending,
		isRejecting: reject.isPending,
	};
}

/**
 * One line of explanation and a way out, for a proposal that cannot be
 * reviewed.
 *
 * Every terminal state that is not READY ends here, and every one of them
 * carries Discard — a proposal a reader cannot dismiss is one that sits on the
 * panel forever.
 */
function RefinementNotice({
	children,
	tone,
	onDiscard,
	isRejecting,
}: {
	children: string;
	tone: "alert" | "status";
	onDiscard: () => void;
	isRejecting: boolean;
}) {
	return (
		<section className="space-y-2 rounded-xl border border-border bg-muted/40 p-4">
			<p
				className="text-muted-foreground text-sm leading-relaxed"
				role={tone}
			>
				{children}
			</p>
			<Button
				type="button"
				variant="ghost"
				size="sm"
				onClick={onDiscard}
				disabled={isRejecting}
			>
				<XIcon className="mr-2 size-4" aria-hidden="true" />
				Discard refinement
			</Button>
		</section>
	);
}

/**
 * The proposal, in whichever of its states it is in.
 *
 * Renders nothing at all for a viewer: every decision this surface offers is a
 * write, and a live run has its own pending line in the action row above.
 */
export function DraftRefinementReview({
	refinement,
	baseline,
	label,
	canEdit,
}: {
	refinement: DraftRefinementController;
	/** The saved text the proposal revises. */
	baseline: string;
	label: string;
	canEdit: boolean;
}) {
	const state = refinement.state;
	if (!canEdit || state === null) {
		return null;
	}

	if (state.status === "GENERATING") {
		return state.isExpired ? (
			<RefinementNotice
				tone="alert"
				onDiscard={refinement.reject}
				isRejecting={refinement.isRejecting}
			>
				{`This refinement didn't report back within its time limit. Refining again will start a fresh one.`}
			</RefinementNotice>
		) : null;
	}

	if (state.status === "FAILED") {
		return (
			<RefinementNotice
				tone="alert"
				onDiscard={refinement.reject}
				isRejecting={refinement.isRejecting}
			>
				{`${state.error ?? "The refinement could not be completed."} Refining again will start a fresh one.`}
			</RefinementNotice>
		);
	}

	if (state.isStale) {
		return (
			<RefinementNotice
				tone="status"
				onDiscard={refinement.reject}
				isRejecting={refinement.isRejecting}
			>
				{`The saved ${label} changed after this refinement was computed, so accepting it would discard that change. Refine again to revise the text you have now.`}
			</RefinementNotice>
		);
	}

	// READY with nothing in it. Not reachable through the server's own writes —
	// `completeRefinement` is what sets READY and it writes the body in the
	// same statement — but a panel that rendered a diff against `null` would
	// crash the whole Topic Item Page, and this is one branch.
	if (!state.proposedBody) {
		return (
			<RefinementNotice
				tone="alert"
				onDiscard={refinement.reject}
				isRejecting={refinement.isRejecting}
			>
				{
					"The refinement came back with nothing to review. Refining again will start a fresh one."
				}
			</RefinementNotice>
		);
	}

	return (
		<RefinedDraftReview
			baseline={baseline}
			proposed={state.proposedBody}
			instruction={state.instruction}
			note={state.note}
			label={label}
			onConfirm={refinement.accept}
			onReject={refinement.reject}
			isSaving={refinement.isAccepting}
			isRejecting={refinement.isRejecting}
		/>
	);
}
