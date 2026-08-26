import { ORPCError } from "@orpc/server";
import {
	createPendingBacklogProposal,
	db,
	hasProjectAccess,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/** Pure: the analyzer-schema one-change proposal for a single action item. */
export function buildActionItemProposal(itemText: string): {
	summary: string;
	changes: Array<{
		type: "feature";
		action: "create";
		title: { to: string };
	}>;
} {
	return {
		summary: `Ticket proposed from meeting action item: "${itemText}"`,
		changes: [
			{ type: "feature", action: "create", title: { to: itemText } },
		],
	};
}

/**
 * Pure-ish DB op: file ONE action item as a pending proposal in the Feature
 * Proposals inbox (same approval workflow as meeting-level proposals — the
 * card's recorded decision).
 *
 * Scoping goes through the `transcript` relation (action items have no direct
 * `projectId` column), mirroring `applyActionItemCompletion` in
 * `set-action-item-completed.ts`.
 *
 * Dedupe: one open (PENDING) proposal per action item, matched on
 * `sourceMetadata.actionItemId` via Prisma's JSON-path filter (already used
 * elsewhere in this repo, e.g. `slack-channel-monitor/link-channel.ts`'s
 * `metadata: { path: ["channelId"], equals }` and
 * `projects/contexts.ts`'s `metadata: { path: ["provider"], equals: "SLACK" }`).
 *
 * The stored `sourceMetadata` mirrors the auto-analyze activity's shape
 * (`backlog-context/auto-analyze-meeting-transcript.ts`) — the Teams approve
 * procedure's drafting reads `sourceMetadata.transcript` for context — plus
 * `actionItemId` (this dedupe) and `transcriptRecordId` (the #1823 provenance
 * fallback in `lib/meeting-provenance.ts`, since a per-item proposal never
 * owns the transcript's `analyzedProposalId` back-link).
 */
export async function proposeActionItemTicket(params: {
	projectId: string;
	actionItemId: string;
	userId: string;
	organizationId?: string | null;
}): Promise<{ status: "proposed" | "already-proposed"; proposalId: string }> {
	const item = await db.projectMeetingActionItem.findFirst({
		where: {
			id: params.actionItemId,
			transcript: { projectId: params.projectId },
		},
		select: {
			id: true,
			text: true,
			transcript: {
				select: {
					id: true,
					contextId: true,
					meetingId: true,
					transcriptId: true,
					linkedMeetingId: true,
					meetingSubject: true,
					meetingDate: true,
				},
			},
		},
	});
	if (!item) {
		throw new ORPCError("NOT_FOUND", { message: "Action item not found" });
	}

	const existing = await db.pendingBacklogProposal.findFirst({
		where: {
			projectId: params.projectId,
			status: "PENDING",
			sourceMetadata: {
				path: ["actionItemId"],
				equals: item.id,
			},
		},
		select: { id: true },
	});
	if (existing) {
		return { status: "already-proposed" as const, proposalId: existing.id };
	}

	// Approve-time drafting reads sourceMetadata.transcript for context —
	// mirror the auto-analyze metadata shape (plus actionItemId for dedupe
	// and transcriptRecordId for the provenance fallback).
	const ctx = item.transcript.contextId
		? await db.projectContext.findUnique({
				where: { id: item.transcript.contextId },
				select: { content: true },
			})
		: null;

	const proposal = buildActionItemProposal(item.text);
	const pending = await createPendingBacklogProposal({
		projectId: params.projectId,
		source: "MONITORED_MEETING",
		proposal: JSON.parse(JSON.stringify(proposal)),
		summary: proposal.summary,
		changeCount: 1,
		sourceMetadata: JSON.parse(
			JSON.stringify({
				actionItemId: item.id,
				transcriptRecordId: item.transcript.id,
				meetingId: item.transcript.meetingId,
				transcriptId: item.transcript.transcriptId,
				linkedMeetingId: item.transcript.linkedMeetingId,
				meetingSubject: item.transcript.meetingSubject,
				meetingDate: item.transcript.meetingDate ?? null,
				contextId: item.transcript.contextId,
				transcript: ctx?.content ?? "",
				attachments: [],
				attachmentWarnings: [],
			}),
		),
		userId: params.userId,
		organizationId: params.organizationId ?? undefined,
	});

	return { status: "proposed" as const, proposalId: pending.id };
}

/**
 * #1823 FR11: file ONE action item as a pending proposal in the Feature
 * Proposals inbox (same approval workflow as meeting-level proposals — the
 * card's recorded decision). PROJECT_READ: the proposal still requires an
 * approver, so this cannot create stories by itself.
 */
export const proposeActionItemProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "POST",
		path: "/projects/{projectId}/meeting-digest/action-items/{actionItemId}/propose",
		tags: ["Projects", "Meeting Digest"],
		summary: "Propose a ticket from one meeting action item",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			actionItemId: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const access = await hasProjectAccess(
			input.projectId,
			user.id,
			organizationId,
		);
		if (!access) {
			throw new ORPCError("FORBIDDEN", {
				message: "You do not have access to this project",
			});
		}

		return proposeActionItemTicket({
			projectId: input.projectId,
			actionItemId: input.actionItemId,
			userId: user.id,
			organizationId,
		});
	});
