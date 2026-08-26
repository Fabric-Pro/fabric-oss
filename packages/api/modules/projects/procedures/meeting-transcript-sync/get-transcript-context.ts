/**
 * Get Meeting Transcript Context for AI
 *
 * Fetches recent meeting transcript content from ProjectContext records
 * for injection into AI agent context (ragContexts).
 *
 * Returns transcript content with meeting metadata extracted from ProjectContext.metadata.
 * Used by DocumentEditor to include meeting context alongside Teams/Slack messages.
 *
 * AUTHORIZATION: Uses hasProjectAccess() - any project member can view transcript context.
 */

import { ORPCError } from "@orpc/server";
import { db, hasProjectAccess } from "@repo/database";
import type { ProjectContextType } from "@repo/database/prisma/client";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

const MAX_CONTENT_LENGTH = 3000;

interface TranscriptContextItem {
	meetingSubject: string;
	meetingDate: string | null;
	speakerNames: string[];
	content: string;
	wasSummarized: boolean;
}

export const getTranscriptContextProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/meeting-transcript-sync/context",
		tags: ["Projects", "Meeting Transcript Sync"],
		summary: "Get meeting transcript context for AI",
		description:
			"Returns recent meeting transcript content formatted for AI context injection",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			limit: z.number().min(1).max(20).default(10),
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

		// Fetch MEETING_TRANSCRIPT ProjectContext records directly
		// These have metadata with meetingSubject, meetingDate, speakerNames, etc.
		const contexts = await db.projectContext.findMany({
			where: {
				projectId: input.projectId,
				type: "MEETING_TRANSCRIPT" as ProjectContextType,
			},
			orderBy: { createdAt: "desc" },
			take: input.limit,
			select: {
				content: true,
				metadata: true,
			},
		});

		const items: TranscriptContextItem[] = contexts
			.filter((c) => c.content && c.content.trim().length > 0)
			.map((c) => {
				const metadata = (c.metadata as Record<string, unknown>) || {};

				let content = c.content;
				if (content.length > MAX_CONTENT_LENGTH) {
					content = `${content.slice(0, MAX_CONTENT_LENGTH)}...`;
				}

				return {
					meetingSubject:
						(metadata.meetingSubject as string) || "Meeting",
					meetingDate: (metadata.meetingDate as string) ?? null,
					speakerNames: (metadata.speakerNames as string[]) ?? [],
					content,
					wasSummarized: (metadata.wasSummarized as boolean) ?? false,
				};
			});

		return {
			transcripts: items,
			transcriptCount: items.length,
		};
	});
