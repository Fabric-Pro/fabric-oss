import { ORPCError } from "@orpc/client";
import { hasProjectAccess } from "@repo/database";
import { executeMicrosoftTeamsTool } from "@repo/integrations/microsoft";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/** Maximum characters per meeting transcript before truncation */
const MAX_TRANSCRIPT_LENGTH = 15_000;

/**
 * Fetch meeting transcripts/summaries for selected meetings.
 *
 * For each provided join URL, resolves the meeting via Microsoft Graph,
 * fetches the most recent transcript, and returns formatted content.
 * Used by the document editor to inject meeting context into AI-assisted editing.
 *
 * AUTHORIZATION: Uses hasProjectAccess() - verifies org membership + project access
 */
export const fetchMeetingNotesProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.DOCUMENT_READ))
	.route({
		method: "POST",
		path: "/projects/{projectId}/documents/meeting-notes",
		tags: ["Projects", "Documents"],
		summary: "Fetch meeting transcripts for document context",
		description:
			"Fetch meeting transcripts from Microsoft Teams for selected meetings to use as context in document editing",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			selectedMeetings: z
				.array(
					z.object({
						joinUrl: z.string(),
						startTime: z.string().optional(),
					}),
				)
				.min(1)
				.max(10),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const hasAccess = await hasProjectAccess(
			input.projectId,
			user.id,
			organizationId,
		);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		const notes: Array<{
			subject: string;
			content: string;
			error?: string;
		}> = [];

		// Process meetings sequentially to avoid Microsoft Graph rate limits
		for (const meeting of input.selectedMeetings) {
			const joinUrl = meeting.joinUrl;
			try {
				// Step 1: Resolve online meeting ID from join URL
				const meetingResult = (await executeMicrosoftTeamsTool(
					"get_meeting_by_join_url",
					{ joinWebUrl: joinUrl },
					user.id,
					organizationId ?? undefined,
				)) as {
					meeting?: { id: string; subject?: string } | null;
					error?: string;
				};

				if (!meetingResult.meeting?.id) {
					notes.push({
						subject: "Unknown Meeting",
						content: "",
						error:
							meetingResult.error ||
							"Could not resolve meeting from join URL",
					});
					continue;
				}

				const meetingId = meetingResult.meeting.id;
				const meetingSubject =
					meetingResult.meeting.subject || "Untitled Meeting";

				// Step 2: List transcripts for this meeting
				const transcriptListResult = (await executeMicrosoftTeamsTool(
					"list_meeting_transcripts",
					{ meetingId },
					user.id,
					organizationId ?? undefined,
				)) as {
					transcripts?: Array<{
						id: string;
						createdDateTime?: string;
					}>;
					error?: string;
				};

				if (
					!transcriptListResult.transcripts ||
					transcriptListResult.transcripts.length === 0
				) {
					notes.push({
						subject: meetingSubject,
						content: "",
						error:
							transcriptListResult.error ||
							"No transcripts available for this meeting. Transcription may not have been enabled.",
					});
					continue;
				}

				// Select transcript matching the requested date, or fall back to most recent
				let transcriptId: string;
				if (
					meeting.startTime &&
					transcriptListResult.transcripts.length > 1
				) {
					const targetDate = new Date(meeting.startTime).getTime();
					const sorted = [...transcriptListResult.transcripts].sort(
						(a, b) => {
							const aDiff = Math.abs(
								new Date(a.createdDateTime ?? "").getTime() -
									targetDate,
							);
							const bDiff = Math.abs(
								new Date(b.createdDateTime ?? "").getTime() -
									targetDate,
							);
							return aDiff - bDiff;
						},
					);
					transcriptId = sorted[0].id;
				} else {
					transcriptId = transcriptListResult.transcripts[0].id;
				}

				// Step 3: Fetch transcript content
				const transcriptContent = (await executeMicrosoftTeamsTool(
					"get_meeting_transcript_content",
					{ meetingId, transcriptId },
					user.id,
					organizationId ?? undefined,
				)) as {
					format?: string;
					content?: string;
					entries?: Array<{
						speaker: string;
						text: string;
						start?: string;
						end?: string;
					}>;
					error?: string;
				};

				if (transcriptContent.error) {
					notes.push({
						subject: meetingSubject,
						content: "",
						error: transcriptContent.error,
					});
					continue;
				}

				// Format transcript into readable text
				let rawTranscript = "";

				if (
					transcriptContent.entries &&
					transcriptContent.entries.length > 0
				) {
					rawTranscript = transcriptContent.entries
						.map((entry) => `${entry.speaker}: ${entry.text}`)
						.join("\n");
				} else if (transcriptContent.content) {
					rawTranscript = transcriptContent.content;
				}

				if (!rawTranscript || rawTranscript.trim().length === 0) {
					notes.push({
						subject: meetingSubject,
						content: "",
						error: "Transcript content was empty",
					});
					continue;
				}

				// Truncate if too long
				const content =
					rawTranscript.length > MAX_TRANSCRIPT_LENGTH
						? `${rawTranscript.substring(0, MAX_TRANSCRIPT_LENGTH)}\n\n[Transcript truncated — ${rawTranscript.length} characters total]`
						: rawTranscript;

				notes.push({ subject: meetingSubject, content });
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : "Unknown error";

				if (
					errorMessage.includes("Microsoft not connected") ||
					errorMessage.includes(
						"Please connect your Microsoft account",
					)
				) {
					notes.push({
						subject: "Unknown Meeting",
						content: "",
						error: "Microsoft account not connected. Please connect your Microsoft account in Settings > Integrations.",
					});
					// No point trying other meetings if Microsoft isn't connected
					break;
				}

				notes.push({
					subject: "Unknown Meeting",
					content: "",
					error: `Failed to fetch transcript: ${errorMessage}`,
				});
			}
		}

		return { notes };
	});
