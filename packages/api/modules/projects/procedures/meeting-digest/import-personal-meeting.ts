/**
 * Import one of the caller's own meetings into a project as context (#2170).
 *
 * THE EXCEPTION, AND WHY IT IS ONE. Every other procedure in the personal
 * meeting lane is forbidden to persist anything: transcripts are read live from
 * Graph, summarised in-request, and dropped, and a source-level guard test
 * (apps/web/__tests__/api/meeting-digest/personal-no-persistence.test.ts) keeps
 * it that way. That guarantee is about what Fabric does ON ITS OWN. It was never
 * a claim that a person may not publish their own meeting into a project they
 * work in — which is exactly what this card asks for, and what this file does.
 *
 * The distinction is kept sharp by construction rather than by intent:
 *
 *  - it is a SEPARATE FILE, so the guard's deny-list over the read procedures is
 *    untouched and still means what it says; the guard names this file as the
 *    single sanctioned exception, so deleting that note fails the build;
 *  - it needs its OWN FLAG (`MEETING_CONTEXT_IMPORT`) on top of
 *    `PERSONAL_MEETINGS`, so the one persisting path can be withdrawn without
 *    taking the read-only lane down with it;
 *  - it requires `CONTEXT_CREATE`, the same permission as adding any other
 *    project context — the card's "project-level permissions for adding context
 *    should govern who can perform the import";
 *  - it is AUDITED. The personal reads are hardcoded into both audit
 *    middlewares' skip lists because a log of someone's private calendar is
 *    itself a leak; a write that publishes content into an org-visible project
 *    is the opposite case, and an org admin is entitled to the record;
 *  - the UI does not fire it without an explicit confirmation that names what
 *    changes (stored, visible to the project, used by AI).
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It creates no `ProjectLinkedMeeting`.
 * Linking would hand the whole team pipeline over for free, but
 * `getLinkedMeetingJoinUrls` selects every linked meeting regardless of
 * `includedInDigest`, so a private recurring meeting would be enrolled in
 * ongoing auto-sync and every future occurrence would land in the project
 * without anyone acting again. An import is a one-off snapshot of one
 * occurrence; nothing reaches back to the meeting afterwards.
 */
import { ORPCError } from "@orpc/server";
import {
	createContext,
	db,
	hasProjectAccess,
	isFeatureEnabled,
} from "@repo/database";
import { executeMicrosoftTeamsTool } from "@repo/integrations/microsoft";
import { logger } from "@repo/logs";
import { z } from "zod";
import { emitActivity, emitContextChange } from "../../../../lib/realtime";
import {
	Permissions,
	requireInputOrgPermission,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	buildImportedContextMetadata,
	buildImportedTranscriptContent,
	MAX_IMPORT_CHARS,
	speakerNamesFromTranscript,
} from "./import-personal-meeting-content";
import { fetchPersonalTranscriptContent } from "./personal-transcript-fetch";

export const importPersonalMeetingProcedure = tenantProtectedProcedure
	// Doubled gate, for the same reason getPersonalTranscript carries it:
	// requireProjectPermission resolves on (projectId, userId) and never reads
	// the org, and hasProjectAccess ignores its third argument outright, so
	// without the input-org check a caller could pair a project they legitimately
	// reach with an organization they do not belong to (#1899 ratchet,
	// SOC 2 CC6.1/CC6.3).
	.use(requireInputOrgPermission(Permissions.CONTEXT_CREATE))
	.use(requireProjectPermission(Permissions.CONTEXT_CREATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/meeting-digest/personal/import",
		tags: ["Projects", "Meeting Digest"],
		summary: "Import a personal meeting into the project as context",
		description:
			"Store the caller's own meeting transcript as project context, where it becomes visible to the project's members and available to Fabric's AI features. Requires an explicit user action.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			joinUrl: z.string(),
			startTime: z.string().optional(),
			meetingSubject: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		// Both flags, not either: PERSONAL_MEETINGS is what makes the meeting
		// reachable at all, MEETING_CONTEXT_IMPORT is what makes storing it
		// permissible. Checked before anything else so a disabled deployment
		// never even reaches Graph on a caller's behalf.
		const [personalEnabled, importEnabled] = await Promise.all([
			isFeatureEnabled("PERSONAL_MEETINGS"),
			isFeatureEnabled("MEETING_CONTEXT_IMPORT"),
		]);
		if (!personalEnabled || !importEnabled) {
			throw new ORPCError("NOT_FOUND", {
				message: "Importing personal meetings is not enabled.",
			});
		}

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

		// Read on the CALLER's delegated token, so a meeting that is not theirs
		// is unreachable by construction rather than by a check we could forget:
		// Graph answers `no-access` for a meeting a colleague organised.
		const callGraph = (methodName: string, args: Record<string, unknown>) =>
			executeMicrosoftTeamsTool(
				methodName,
				args,
				user.id,
				organizationId ?? undefined,
			);

		let transcript: Awaited<
			ReturnType<typeof fetchPersonalTranscriptContent>
		>;
		try {
			transcript = await fetchPersonalTranscriptContent({
				callGraph,
				joinUrl: input.joinUrl,
				startTime: input.startTime,
			});
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Unknown error";
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: `Failed to read the meeting transcript: ${message}`,
			});
		}

		// A known, actionable state — no transcript yet, admin consent needed,
		// Microsoft not connected, someone else's meeting. Returned rather than
		// thrown so the UI can say what to do next, and so the join URL (a
		// meeting capability URL) never rides an error path.
		if (transcript.content === null) {
			return {
				status: "unavailable" as const,
				reason: transcript.reason,
			};
		}

		const { meetingId, transcriptId } = transcript;

		// Duplicate check (spec D2). Keyed on the Graph occurrence, because a
		// transcript is immutable once produced: the same pair always means the
		// same content, so a repeat import is a no-op rather than a second copy.
		// Deliberately NOT scoped to `origin: "personal-import"` — a transcript
		// the team sync path already pulled in is the same content, and an
		// import must not shadow it.
		//
		// KNOWN LIMIT: a read-then-write with no unique index behind it, so it
		// collapses SEQUENTIAL repeats, not SIMULTANEOUS ones. Two imports of the
		// same meeting started within the Graph round-trip (three network calls,
		// so seconds — two browser tabs, or a double submit that outruns the
		// button's own pending guard) can both miss here and both write. Closing
		// it properly needs a unique expression index over
		// (projectId, metadata->>'meetingId', metadata->>'transcriptId'), which
		// is a migration against a table that already holds team-synced rows this
		// procedure did not create — out of scope here, and the failure mode is a
		// duplicate context row the user can delete, not lost or leaked data.
		const existing = await db.projectContext.findFirst({
			where: {
				projectId: input.projectId,
				type: "MEETING_TRANSCRIPT",
				AND: [
					{ metadata: { path: ["meetingId"], equals: meetingId } },
					{
						metadata: {
							path: ["transcriptId"],
							equals: transcriptId,
						},
					},
				],
			},
			select: { id: true },
		});
		if (existing) {
			return { status: "duplicate" as const, contextId: existing.id };
		}

		const meetingSubject =
			input.meetingSubject?.trim() || "Personal meeting";
		const content = buildImportedTranscriptContent({
			meetingSubject,
			occurrenceDate: input.startTime,
			transcript: transcript.content,
		});

		// Refuse rather than slice. The card's NFR asks for long transcripts
		// "without silent truncation", and a stored fragment is worse than a
		// clear failure: nothing downstream could tell it was incomplete.
		if (content.length > MAX_IMPORT_CHARS) {
			return { status: "too-large" as const, limit: MAX_IMPORT_CHARS };
		}

		// `occurrenceDate` is the calendar start time the user clicked, not the
		// transcript's own createdDateTime (which the team path uses and this
		// Graph chain does not surface). That is the right choice here rather
		// than a compromise: the backlog fetcher matches an imported meeting by
		// comparing this value against the `startTime` of the occurrence the
		// user selected, so storing the calendar time is what makes the two
		// sides of that comparison the same clock.
		const metadata = buildImportedContextMetadata({
			meetingId,
			transcriptId,
			joinUrl: input.joinUrl,
			meetingSubject,
			occurrenceDate: input.startTime,
			speakerNames: speakerNamesFromTranscript(transcript.content),
			importedByUserId: user.id,
			importedAt: new Date(),
		});

		const projectContext = await createContext({
			projectId: input.projectId,
			type: "MEETING_TRANSCRIPT",
			content,
			sourceTitle: `Meeting Transcript: ${meetingSubject}`,
			metadata,
			// The content arrived complete; there is no extraction step to wait
			// for. Leaving this PENDING would make the contexts list poll a row
			// that is never going to change.
			extractionStatus: "COMPLETED",
			userId: user.id,
			organizationId: organizationId ?? undefined,
		});

		// Fire-and-forget, and non-fatal on failure — mirrors create-context.ts.
		// The row is already committed: failing the request here would tell the
		// user their import did not happen when it did, and the retry would hit
		// the duplicate check rather than fix the missing embedding.
		try {
			const { getTemporalClient } = await import("@repo/temporal");
			const client = await getTemporalClient();
			await client.workflow.start("contextEmbeddingWorkflow", {
				taskQueue: "project-documents",
				workflowId: `context-embedding-${projectContext.id}-${Date.now()}`,
				args: [
					{
						contextId: projectContext.id,
						projectId: input.projectId,
						userId: user.id,
						organizationId,
						content,
						type: "MEETING_TRANSCRIPT",
						metadata: {
							sourceTitle: `Meeting Transcript: ${meetingSubject}`,
							provider: "microsoft-teams",
							meetingId,
							transcriptId,
						},
					},
				],
			});
		} catch (error) {
			logger.error(
				"[ImportPersonalMeeting] Failed to start embedding workflow",
				{
					contextId: projectContext.id,
					error:
						error instanceof Error ? error.message : String(error),
				},
			);
		}

		const contextName = `Meeting Transcript: ${meetingSubject}`;
		await Promise.all([
			emitContextChange({
				projectId: input.projectId,
				contextId: projectContext.id,
				action: "added",
				userId: user.id,
				userName: user.name || "Anonymous",
				contextType: "MEETING_TRANSCRIPT",
				contextName,
			}),
			emitActivity({
				projectId: input.projectId,
				userId: user.id,
				userName: user.name || "Anonymous",
				activityType: "context_added",
				resourceType: "context",
				resourceId: projectContext.id,
				resourceName: contextName,
				timestamp: new Date().toISOString(),
			}),
		]);

		return { status: "imported" as const, contextId: projectContext.id };
	});
