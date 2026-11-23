"use client";

/**
 * The ticket page's side of a Proposal Inbox line-by-line review (see
 * `proposal-ticket-review.ts`). Once the ticket is on screen, the update's
 * changes are painted into the editor as diff marks, the same marks the AI
 * assistant's edits carry, and `DiffReviewBar` accepts or rejects them one
 * by one. Apply approves only the changes accepted so far, and changes the
 * editor only once the approval succeeds; Reject all moves the item to
 * Rejected; Cancel puts the ticket back and applies nothing.
 *
 * While the review is open the editor is read-only and nothing autosaves.
 */

import { mergeWithinUpdate } from "@repo/utils/proposal-update-edits";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Editor } from "@tiptap/react";
import {
	type MutableRefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { diffPartialText, fromMarkdown } from "../../lib/diff-utils";
import { editorHoldsDiffMarks } from "../../lib/editor-diff-marks";
import { getTurndownService } from "../../lib/editor-markdown-save";
import { spliceReviewedText } from "../../lib/review-splice";
import { buildProjectProposalRoute } from "../../lib/stories/routes";
import {
	formatStoredStoryContent,
	resolveStoryContentForSave,
} from "../../lib/story-content";
import type { ChangeItem } from "./BacklogChangeProposal";
import { enrichmentPreviewQueryOptions } from "./enrichment-preview";
import {
	approveHeldBackToast,
	approveOutcomeToast,
	approveRefusalTitle,
	proposalConflictMessage,
} from "./proposal-approve-outcome";
import {
	invalidateProposalInboxQueries,
	requestProposalApproval,
} from "./proposal-inbox-client";
import {
	acceptedTicketDocument,
	endProposalTicketReview,
	type ProposalTicketReview,
	pendingProposalTicketReview,
	proposalItemStillOpen,
	proposedBodiesAsIs,
	reviewedTicketChange,
	type TicketBodies,
} from "./proposal-ticket-review";

type Phase = "idle" | "merging" | "diff" | "applying";

/** The ticket document Apply writes, and the update it approves (null when
 * it would apply nothing). */
type ReviewedTicket = { document: string; change: ChangeItem | null };

// The ticket's own text, hand-written: kept out of the legacy bullet repair,
// as everywhere the editor shows stored content.
const STORED_CONTENT_MD_OPTIONS = { repairLegacyBullets: false } as const;

function storedMarkdown(text: string): string {
	return text.startsWith("<") ? getTurndownService().turndown(text) : text;
}

/** The editor document for a ticket's bodies, as the editor seeds it. */
function ticketDocument(bodies: TicketBodies): string {
	return formatStoredStoryContent({
		description: storedMarkdown(bodies.description),
		acceptanceCriteria: storedMarkdown(bodies.acceptanceCriteria),
	});
}

export function useProposalTicketReview(params: {
	story: {
		id: string;
		description?: string | null;
		acceptanceCriteria?: string | null;
	};
	editor: Editor | null;
	/** The page can write the ticket and has no other review open. */
	enabled: boolean;
	basePath: string;
	/** Raised around the editor writes so they are not taken as edits. */
	isSyncingFromPropRef: MutableRefObject<boolean>;
	/** The ticket changed: refresh what shows it. */
	onTicketChanged: () => void;
}) {
	const { story, editor, enabled, isSyncingFromPropRef } = params;
	const queryClient = useQueryClient();
	const [review, setReview] = useState<ProposalTicketReview | null>(null);
	const [phase, setPhase] = useState<Phase>("idle");
	// The changes could not be marked line by line: the editor shows the
	// proposed text unmarked, and the review can only reject or cancel it.
	const [unmarked, setUnmarked] = useState(false);
	// Read after mount: the hand-off lives in the browser (memory, or the
	// tab's storage after a reload), and the server render has none.
	useEffect(() => {
		const handed = pendingProposalTicketReview(story.id);
		setReview(handed);
		setPhase(handed ? "merging" : "idle");
	}, [story.id]);
	// The ticket's stored bodies the review compares with, and the bodies it
	// proposes, both read when the review starts.
	const storedRef = useRef<TicketBodies | null>(null);
	const proposedRef = useRef<TicketBodies | null>(null);
	const startedRef = useRef(false);

	const stored: TicketBodies = {
		description: story.description ?? "",
		acceptanceCriteria: story.acceptanceCriteria ?? "",
	};
	// The item may have been decided since it was handed over (in another
	// tab, by another reviewer, or before a reload): its proposal is read
	// first, and nothing is painted until it says the item is still open.
	// Only an answer fetched for this page counts, never a cached one.
	const statusQuery = useQuery({
		queryKey: [
			"proposal-ticket-review-status",
			review?.projectId,
			review?.organizationId,
			review?.proposalId,
		],
		queryFn: async () =>
			review
				? await orpcClient.projects.teamsChannelMonitor.pendingProposals.get(
						{
							projectId: review.projectId,
							organizationId: review.organizationId,
							proposalId: review.proposalId,
						},
					)
				: null,
		enabled: enabled && review !== null && !startedRef.current,
		staleTime: 0,
		gcTime: 0,
		refetchOnMount: "always",
		retry: false,
	});
	const statusFetched = statusQuery.isFetchedAfterMount;
	const stillOpen =
		review && statusFetched && statusQuery.data !== undefined
			? proposalItemStillOpen(statusQuery.data, review.changeIndex)
			: null;
	const asIs = review ? proposedBodiesAsIs(review.change, stored) : null;
	// An update not yet merged into the ticket as it is now, and not a whole
	// version of its body, is merged into it the way apply would merge it;
	// the review then offers only the edits the update holds.
	// No query at all on a ticket page with no review.
	const mergeQueries: ReturnType<typeof enrichmentPreviewQueryOptions>[] =
		enabled &&
		review &&
		stillOpen === true &&
		asIs === null &&
		!startedRef.current
			? [
					enrichmentPreviewQueryOptions({
						projectId: review.projectId,
						organizationId: review.organizationId,
						targetStoryId: story.id,
						routing: {
							proposedDescription: review.change.description?.to,
							proposedAcceptanceCriteria:
								review.change.acceptanceCriteria?.to,
							reasoning: review.change.reasoning,
						},
					}),
				]
			: [];
	const [merge] = useQueries({ queries: mergeQueries });
	const mergeData = merge?.data;

	const itemTitle = review?.change.title.to ?? "";
	const backToInbox = review
		? {
				label: "Back to the proposal",
				onClick: () => {
					window.location.assign(
						buildProjectProposalRoute(
							params.basePath,
							review.projectId,
							review.proposalId,
						),
					);
				},
			}
		: undefined;

	// A hand-off whose item was decided, or that cannot be checked, is
	// dropped before anything is painted; the editor was never locked.
	const statusFailed = statusFetched && statusQuery.isError;
	useEffect(() => {
		if (!review || startedRef.current) {
			return;
		}
		if (stillOpen === false || statusFailed) {
			endProposalTicketReview();
			setReview(null);
			setPhase("idle");
			toast.info(
				statusFailed
					? "Couldn't check the proposed update, so its review was closed."
					: "This proposed update was already decided, so its review was closed.",
				{ description: "Open it again from the Proposal Inbox." },
			);
		}
	}, [review, stillOpen, statusFailed]);

	// Paint the review once the item is known to be open and the ticket and
	// the proposed bodies are known.
	useEffect(() => {
		if (
			!editor ||
			!review ||
			!enabled ||
			stillOpen !== true ||
			startedRef.current
		) {
			return;
		}
		let proposed: TicketBodies;
		let against: TicketBodies = stored;
		if (asIs) {
			proposed = asIs;
		} else if (mergeData) {
			against = {
				description: mergeData.currentDescription,
				acceptanceCriteria: mergeData.currentAcceptanceCriteria,
			};
			// The merge is a model's rewrite: only the edits the update holds
			// are offered, never a line it keeps changed or text it lacks.
			// Apply all holds its merge to the update the same way. A merge
			// that fell back merged nothing: the update's new detail is
			// offered appended to the ticket as it is.
			const withinUpdate = mergeWithinUpdate(
				review.change,
				against,
				mergeData.fallbackUsed
					? against
					: {
							description: mergeData.mergedDescription,
							acceptanceCriteria:
								mergeData.mergedAcceptanceCriteria,
						},
			);
			proposed = withinUpdate?.bodies ?? against;
		} else {
			return;
		}
		startedRef.current = true;
		storedRef.current = against;
		proposedRef.current = proposed;
		const baseline = ticketDocument(against);
		const proposedDoc = ticketDocument(proposed);
		editor.setEditable(false);
		isSyncingFromPropRef.current = true;
		try {
			editor.commands.setContent(
				fromMarkdown(
					diffPartialText(baseline, proposedDoc, true),
					STORED_CONTENT_MD_OPTIONS,
				),
			);
			// Apply reads what was decided from the reviewed document
			// (`readReviewed`). Without that reading no Apply can tell what
			// was accepted, and the same document reads the same way on a
			// second try.
			if (acceptedTicketDocument(editor) === null) {
				throw new Error("The review's document can't be read");
			}
		} catch {
			// Diff marks can break a table's structure, or the marked
			// document can't be read: show the proposed text unmarked.
			// Nothing in it can be accepted, so Apply stays off, with the
			// reason; the update applies whole from the Proposal Inbox.
			editor.commands.setContent(
				fromMarkdown(proposedDoc, STORED_CONTENT_MD_OPTIONS),
			);
			setUnmarked(true);
		} finally {
			isSyncingFromPropRef.current = false;
		}
		setPhase("diff");
	}, [editor, review, enabled, stillOpen, asIs, mergeData]);

	// End the review and leave the editor showing `content`.
	const finish = useCallback(
		(content: string) => {
			endProposalTicketReview();
			setReview(null);
			setPhase("idle");
			setUnmarked(false);
			if (!editor) {
				return;
			}
			isSyncingFromPropRef.current = true;
			try {
				editor.commands.setContent(
					fromMarkdown(content, STORED_CONTENT_MD_OPTIONS),
				);
			} catch {
				// The refreshed ticket replaces the editor content.
			} finally {
				isSyncingFromPropRef.current = false;
			}
			editor.setEditable(true);
		},
		[editor, isSyncingFromPropRef],
	);

	const refresh = useCallback(() => {
		if (review) {
			invalidateProposalInboxQueries(
				queryClient,
				review.projectId,
				review.organizationId,
			);
		}
		params.onTicketChanged();
	}, [queryClient, review]);

	const rejectAll = useCallback(async () => {
		if (!review || phase !== "diff") {
			return;
		}
		setPhase("applying");
		try {
			await orpcClient.projects.backlog.proposals.rejectItem({
				projectId: review.projectId,
				organizationId: review.organizationId,
				proposalId: review.proposalId,
				changeIndex: review.changeIndex,
				noteRejectedUpdate: true,
				reviewedTicketId: story.id,
			});
			finish(ticketDocument(storedRef.current ?? stored));
			refresh();
			toast.success(`Rejected every change to “${itemTitle}”`, {
				description:
					"Nothing was applied. Find it anytime in Rejected proposals on your roadmap.",
				action: backToInbox,
			});
		} catch (error) {
			setPhase("diff");
			toast.error(`Couldn't move “${itemTitle}” to Rejected`, {
				description:
					proposalConflictMessage(error) ??
					(error instanceof Error ? error.message : "Unknown error"),
			});
		}
	}, [review, phase, finish, refresh, itemTitle, story.id]);

	// What Apply would write, read without changing the editor. Null when
	// the editor can't be read. The editor's reading says only what was
	// decided: the decided changes are spliced into the ticket's own text,
	// so every line nobody decided is written as it was.
	const readReviewed = useCallback((): ReviewedTicket | null => {
		const storedBodies = storedRef.current;
		const proposedBodies = proposedRef.current;
		if (!editor || !review || !storedBodies || !proposedBodies) {
			return null;
		}
		const accepted = acceptedTicketDocument(editor);
		if (accepted === null) {
			return null;
		}
		const original = ticketDocument(storedBodies);
		const document = spliceReviewedText(
			original,
			ticketDocument(proposedBodies),
			accepted,
		);
		const split = (text: string) => {
			const bodies = resolveStoryContentForSave(
				text,
				storedBodies.acceptanceCriteria,
			);
			return {
				description: bodies.description,
				acceptanceCriteria: bodies.acceptanceCriteria,
			};
		};
		return {
			document,
			change: reviewedTicketChange({
				change: review.change,
				stored: storedBodies,
				unchanged: split(original),
				reviewed: split(document),
				undecidedBodyChanges: editorHoldsDiffMarks(editor.state.doc),
			}),
		};
	}, [editor, review]);

	const apply = useCallback(async () => {
		if (!review || phase !== "diff" || unmarked) {
			return;
		}
		// Only what the reviewer accepted is written; an undecided change is
		// left out. The editor keeps every mark until the approval succeeds.
		const reviewedDoc = readReviewed();
		if (!reviewedDoc) {
			toast.error(
				"Couldn't read the editor content. Nothing was applied; try again or reload the page.",
			);
			return;
		}
		const { change } = reviewedDoc;
		if (!change) {
			toast.info("Accept at least one change to apply it.", {
				description:
					"To move the item to Rejected instead, choose Reject all.",
			});
			return;
		}
		setPhase("applying");
		try {
			const result = await requestProposalApproval({
				projectId: review.projectId,
				organizationId: review.organizationId,
				pmConfig: review.pmConfig,
				proposalId: review.proposalId,
				source: review.source,
				approvedChanges: [change],
				approvedChangeIndexes: [review.changeIndex],
				pmSyncOverrides: review.pmSyncOverrides,
				syncToPM: review.syncToPM,
				expectedProposalRevision: review.expectedProposalRevision,
			});
			const heldBack = approveHeldBackToast(result);
			if (heldBack) {
				toast.error(heldBack.title, {
					description: heldBack.description,
				});
			}
			const message = approveOutcomeToast(result, {
				source: review.source,
				changeIndex: review.changeIndex,
				itemTitle,
				targetStoryId: story.id,
			});
			if (message.variant === "error") {
				setPhase("diff");
				toast.error(message.title, {
					description: message.description,
				});
				return;
			}
			finish(reviewedDoc.document);
			refresh();
			toast.success(message.title, {
				...(message.description
					? { description: message.description }
					: {}),
				action: backToInbox,
			});
		} catch (error) {
			setPhase("diff");
			toast.error(approveRefusalTitle(itemTitle), {
				description:
					proposalConflictMessage(error) ??
					(error instanceof Error ? error.message : "Unknown error"),
			});
		}
	}, [review, phase, unmarked, readReviewed, finish, refresh, itemTitle]);

	// Put the ticket back as it was; the item stays in the inbox.
	const cancel = useCallback(() => {
		if (!review || phase === "applying") {
			return;
		}
		finish(ticketDocument(storedRef.current ?? stored));
		toast.info("Review cancelled. Nothing was applied.", {
			description: `“${itemTitle}” is still waiting in the Proposal Inbox.`,
			action: backToInbox,
		});
	}, [review, phase, finish, itemTitle]);

	return {
		/** The item under review, while one is open. */
		review,
		/** Any part of a review is open, reading its merge included. */
		isActive: review !== null && enabled,
		isMerging: phase === "merging" && review !== null,
		mergeFailed: merge?.isError ?? false,
		retryMerge: () => {
			void merge?.refetch();
		},
		showingDiff: phase === "diff" || phase === "applying",
		isApplying: phase === "applying",
		/** The changes could not be marked, so none can be accepted here. */
		lineByLineUnavailable: unmarked,
		/**
		 * Apply would write something: a change was accepted, or every body
		 * change is answered and the item changes fields outside the editor.
		 * Read from the editor each call.
		 */
		canApply: () => !unmarked && !!readReviewed()?.change,
		apply,
		rejectAll,
		cancel,
	};
}
