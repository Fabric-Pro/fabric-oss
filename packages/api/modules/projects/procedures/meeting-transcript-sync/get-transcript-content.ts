/**
 * Get Full Meeting Transcript Content
 *
 * Returns the FULL (never truncated) content of a single meeting transcript,
 * resolved by either ProjectMeetingTranscript.id OR its contextId, for the
 * human-facing transcript reader.
 *
 * Contrast with getTranscriptContextProcedure (the AI-context path), which
 * truncates to MAX_CONTENT_LENGTH = 3000 and is not addressable per-transcript.
 *
 * AUTHORIZATION: Uses hasProjectAccess() - any project member can read a
 * project transcript. The body is fetched via the tenant-XOR-safe
 * getContextById() so cross-project / cross-tenant rows resolve to null.
 */

import { ORPCError } from "@orpc/server";
import { db, getContextById, hasProjectAccess } from "@repo/database";
import type { ProjectContextType } from "@repo/database/prisma/client";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

const MEETING_TRANSCRIPT_TYPE: ProjectContextType = "MEETING_TRANSCRIPT";

export const getTranscriptContentProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/meeting-transcript-sync/transcripts/{transcriptRef}/content",
		tags: ["Projects", "Meeting Transcript Sync"],
		summary: "Get full content for a single meeting transcript",
		description:
			"Returns the full (never truncated) transcript content for a single transcript, resolved by ProjectMeetingTranscript.id or its contextId.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			// ProjectMeetingTranscript.id OR its contextId.
			transcriptRef: z.string(),
		}),
	)
	.output(
		z.object({
			transcript: z.object({
				id: z.string(),
				contextId: z.string(),
				meetingSubject: z.string().nullable(),
				meetingDate: z.string().nullable(),
				speakerNames: z.array(z.string()),
				wasSummarized: z.boolean(),
				content: z.string(),
				syncedAt: z.string(),
			}),
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

		// Resolve the transcript row scoped to the project. transcriptRef may be
		// either the ProjectMeetingTranscript.id or its contextId. The projectId
		// predicate is the project-scope guard (FR-7/DV-2); the OR is on
		// IDENTIFIER columns only - it is NOT the forbidden multi-tenant
		// organizationId/userId OR (that is enforced by getContextById below).
		const transcript = await db.projectMeetingTranscript.findFirst({
			where: {
				projectId: input.projectId,
				OR: [
					{ id: input.transcriptRef },
					{ contextId: input.transcriptRef },
				],
			},
			select: {
				id: true,
				contextId: true,
				meetingSubject: true,
				meetingDate: true,
				speakerNames: true,
				wasSummarized: true,
				summary: true,
				syncedAt: true,
			},
		});
		if (!transcript || !transcript.contextId) {
			throw new ORPCError("NOT_FOUND", {
				message: "Transcript not found",
			});
		}

		// Fetch the full body via the tenant-XOR-safe getter (do NOT read
		// ProjectContext directly). The XOR + projectId IDOR guard make
		// cross-tenant / cross-project rows resolve to null.
		const ctx = await getContextById(
			transcript.contextId,
			input.projectId,
			{
				userId: user.id,
				organizationId,
			},
		);
		if (!ctx || ctx.type !== MEETING_TRANSCRIPT_TYPE) {
			throw new ORPCError("NOT_FOUND", {
				message: "Transcript content not found",
			});
		}

		// Resolve the body. When the transcript was summarized at ingest and the
		// stored context body is empty, fall back to the persisted summary.
		// Otherwise return the full stored body. Never truncate.
		const content =
			transcript.wasSummarized && ctx.content.trim().length === 0
				? (transcript.summary ?? "")
				: ctx.content;

		return {
			transcript: {
				id: transcript.id,
				contextId: transcript.contextId,
				meetingSubject: transcript.meetingSubject,
				meetingDate: transcript.meetingDate
					? transcript.meetingDate.toISOString()
					: null,
				speakerNames: transcript.speakerNames,
				wasSummarized: transcript.wasSummarized,
				content,
				syncedAt: transcript.syncedAt.toISOString(),
			},
		};
	});
