/**
 * Which of the meetings on the To Do page have feature proposals still awaiting
 * review (Fizzy #2340).
 *
 * WHY THIS IS ITS OWN PROCEDURE and not a field on `todos.list`. Three reasons,
 * and the first is the one that decides it:
 *
 *  1. THE SIGNAL IS MEETING-SHAPED AND THE LIST IS ITEM-SHAPED. The Feature
 *     Proposals inbox is a queue per meeting, and a person reviews it per
 *     meeting. Carried on the list, the same boolean would repeat on every row
 *     of one meeting — a badge on eight lines that all mean the one thing,
 *     which reads as eight things to do.
 *  2. THE LIST IS PAGED AND THE ANSWER IS NOT. A meeting's items routinely
 *     straddle a page boundary, so a count computed from the rows in one
 *     response would say something different on page 2 than on page 1. Asked
 *     about a set of meetings, the answer is the same whichever page they came
 *     from.
 *  3. THEY CHANGE ON DIFFERENT CLOCKS. Approving a proposal in the inbox
 *     changes this and nothing else; the page can refresh the indicator without
 *     re-paging a list whose rows did not move.
 *
 * THE FLAG IT IS NOT BEHIND. `MEETING_ACTION_ITEM_LINKING` gates links between
 * an action item and a work item. This read touches no link: it counts
 * `PendingBacklogProposal` rows, which the Feature Proposals inbox has always
 * written and shown. With the linking flag off, this still answers — and it
 * must, or turning the linking rollout off would take the review queue's
 * indicator with it. `TODO_LIST` is the gate that applies, because this is a
 * read of the To Do page and the page is what that gate covers.
 *
 * AUTHORIZATION IS IN TWO HALVES, exactly as `list.ts`'s is. The declared gate
 * proves membership of the organization NAMED IN THE INPUT and nothing more —
 * `requireOrganization: true` is mandatory, because without it an explicit
 * `organizationId: null` resolves to nothing and skips the role check. The
 * second half is the project-access predicate this module imports from
 * `../lib/visibility.ts` rather than restating: a caller may only be told about
 * meetings held in projects they can already reach, and the one predicate the
 * read composes is what decides that.
 *
 * AND THE PREDICATE IT IMPORTS IS THE STRICT ONE (#2615), BECAUSE THIS
 * RESPONSE IS AN HREF. `projectId` is returned for one purpose — the page links
 * straight into that project's Feature Proposals inbox — and an inbox route
 * resolves its project through `getProjectById`, which runs
 * `buildProjectAccessWhere`. `openableProjectWhere` is that rule; the wide
 * `organizationProjectWhere` is a tenant-scoping question that admits every
 * project of the organization. Answered against the wide one, as this was, the
 * badge appears on a meeting whose inbox then says "Project not found" — the
 * reader is told work is waiting for them somewhere they cannot go. A link may
 * only be offered against the rule its own destination enforces.
 */

import { db, type Prisma } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { requireTodoListEnabled } from "../lib/mutation-access";
import { openableProjectWhere } from "../lib/visibility";
import { requireOrganizationContext } from "./contacts/shared";

/**
 * Only PENDING counts as "awaiting review".
 *
 * BACKLOG is deliberately excluded although it is reversible: that status exists
 * to take a proposal OUT of the active review queue, and every needs-attention
 * count in the product already treats it like REJECTED. An indicator that
 * disagreed would send people to an inbox that shows them nothing.
 */
const AWAITING_REVIEW = "PENDING" as const;

/** Separates the two halves of the grouping key. Not a character an id carries. */
const MEETING_KEY_SEPARATOR = "::";

export const pendingProposalMeetingsInputSchema = z.object({
	organizationId: z.string().nullable().optional(),
	/**
	 * The `meetingTranscriptRef` values the page is currently showing — Graph
	 * transcript ids, the same field `todos.list` returns and the same field the
	 * page groups its "from <meeting>" headings by.
	 *
	 * Asked rather than derived, because the answer is about the meetings IN
	 * VIEW. Deriving the set server-side would mean re-running the whole to-do
	 * read to find out which meetings those were, and would still not know which
	 * page the reader is on.
	 */
	transcriptRefs: z.array(z.string().min(1)).min(1).max(100),
});

/** One meeting with something waiting in its Feature Proposals inbox. */
interface PendingProposalMeeting {
	/** The Graph transcript id, as given — never the transcript row cuid. */
	transcriptRef: string;
	/** Where the inbox lives, so the page can link straight into it. */
	projectId: string;
	pendingCount: number;
}

export const pendingProposalMeetingsProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.TODO_READ, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "POST",
		path: "/todos/pending-proposals",
		tags: ["Todos"],
		summary: "Which meetings in view have proposals awaiting review",
		description:
			"Given the meetings the To Do page is showing, reports which of them have PendingBacklogProposal rows still awaiting review, and how many. Meeting granularity, because the Feature Proposals inbox is a queue per meeting. A meeting absent from the response has nothing waiting.",
	})
	.input(pendingProposalMeetingsInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = requireOrganizationContext(
			resolveOrganizationId(input.organizationId, context.session),
		);
		await requireTodoListEnabled(organizationId);

		// One clock, for the same reason every other to-do procedure takes one:
		// the membership-expiry arm of the project predicate must not disagree
		// with itself inside a single request.
		const now = new Date();

		// Deduplicated because the page sends one ref per row it rendered, and a
		// meeting with eight to-dos would otherwise be asked about eight times.
		const refs = [...new Set(input.transcriptRefs)];

		// The project predicate is the access boundary. A transcript whose
		// project the caller cannot OPEN is unmatchable here rather than merely
		// uncounted, so no ref they guessed can confirm a meeting exists.
		//
		// STRICT, not the wide tenant set: every meeting that survives this
		// query is handed back with its `projectId`, and the page turns that
		// into a link into the project's Feature Proposals inbox. See the
		// header.
		const transcripts = await db.projectMeetingTranscript.findMany({
			where: {
				transcriptId: { in: refs },
				organizationId,
				project: openableProjectWhere(
					context.user.id,
					organizationId,
					now,
				),
			},
			select: {
				id: true,
				transcriptId: true,
				projectId: true,
				analyzedProposalId: true,
			},
		});
		if (transcripts.length === 0) {
			return { meetings: [] as PendingProposalMeeting[] };
		}

		// A proposal names its meeting in one of two ways, and both are counted.
		// A meeting-level auto-analyze proposal owns the transcript's
		// `analyzedProposalId` back-link; a per-action-item proposal (#1823)
		// never does, and carries `sourceMetadata.transcriptRecordId` instead.
		// Counting only one shape would make the indicator silently wrong for
		// half the inbox.
		const analyzedProposalIds = transcripts
			.map((transcript) => transcript.analyzedProposalId)
			.filter((id): id is string => id !== null);

		const metadataMatches: Prisma.PendingBacklogProposalWhereInput[] =
			transcripts.map((transcript) => ({
				sourceMetadata: {
					path: ["transcriptRecordId"],
					equals: transcript.id,
				},
			}));

		const pending = await db.pendingBacklogProposal.findMany({
			where: {
				projectId: {
					in: [
						...new Set(
							transcripts.map(
								(transcript) => transcript.projectId,
							),
						),
					],
				},
				status: AWAITING_REVIEW,
				OR: [
					// `in: []` matches nothing, so a set of meetings that were
					// never auto-analyzed costs an unmatchable arm rather than a
					// special case.
					{ id: { in: analyzedProposalIds } },
					...metadataMatches,
				],
			},
			select: { id: true, sourceMetadata: true },
		});
		if (pending.length === 0) {
			return { meetings: [] as PendingProposalMeeting[] };
		}

		const transcriptByRowId = new Map(
			transcripts.map((transcript) => [transcript.id, transcript]),
		);
		const transcriptByProposalId = new Map(
			transcripts
				.filter((transcript) => transcript.analyzedProposalId !== null)
				.map((transcript) => [
					transcript.analyzedProposalId as string,
					transcript,
				]),
		);

		// Keyed on the (ref, project) PAIR rather than the ref alone: two
		// projects can monitor the same meeting, and their inboxes are separate
		// queues reviewed by different people. Summing them would report one
		// number that belongs to neither.
		const counts = new Map<string, PendingProposalMeeting>();
		for (const proposal of pending) {
			const metadata = (proposal.sourceMetadata ?? {}) as Record<
				string,
				unknown
			>;
			const transcriptRecordId =
				typeof metadata.transcriptRecordId === "string"
					? metadata.transcriptRecordId
					: null;
			const transcript =
				(transcriptRecordId
					? transcriptByRowId.get(transcriptRecordId)
					: undefined) ?? transcriptByProposalId.get(proposal.id);
			if (!transcript) {
				// The row named a transcript that is not in view, or one whose
				// project the caller cannot reach. Either way it is not theirs
				// to be told about.
				continue;
			}
			const key = `${transcript.transcriptId}${MEETING_KEY_SEPARATOR}${transcript.projectId}`;
			const existing = counts.get(key);
			if (existing) {
				existing.pendingCount += 1;
				continue;
			}
			counts.set(key, {
				transcriptRef: transcript.transcriptId,
				projectId: transcript.projectId,
				pendingCount: 1,
			});
		}

		return { meetings: [...counts.values()] };
	});
