/**
 * Meeting Transcripts Handler
 *
 * Handles the `list_meeting_transcripts` tool on the orchestrator seam: reads
 * the attached project's synced transcripts straight from the
 * ProjectMeetingTranscript table, ordered by the meeting's OWN occurrence date.
 *
 * The filter parsing and rendering live in
 * `activities/shared/meeting-transcript-listing` because direct chat exposes
 * the same tool and the two seams must answer a date question identically.
 * See that module for why the tool exists (Fizzy #2473).
 */

import {
	listProjectMeetingTranscripts,
	readTranscriptFilters,
} from "../../../shared/meeting-transcript-listing";
import type { ExecuteStepInput, ExecuteStepOutput } from "../../types";
import type {
	HandlerContext,
	HandlerResult,
	StepHandler,
	ToolCallRecord,
} from "./types";

const TOOL_NAME = "list_meeting_transcripts";

export class MeetingTranscriptsHandler implements StepHandler {
	readonly name = "meeting-transcripts";
	readonly capabilities = ["meeting_transcripts"];

	canHandle(input: ExecuteStepInput): boolean {
		const app = input.step.app;
		const executor = input.step.executor;
		return app === TOOL_NAME || executor === TOOL_NAME;
	}

	async execute(context: HandlerContext): Promise<HandlerResult> {
		const { input } = context;
		try {
			const output = await this.listTranscripts(input);
			return { handled: true, output };
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			console.error("[MeetingTranscriptsHandler] failed:", error);
			return {
				handled: false,
				error: `Meeting transcript lookup failed: ${message}`,
				shouldFallback: false,
			};
		}
	}

	private async listTranscripts(
		input: ExecuteStepInput,
	): Promise<ExecuteStepOutput> {
		const startTime = Date.now();
		const stepInputs = input.step.inputs as
			| Record<string, unknown>
			| undefined;
		const projectId = input.projectId;
		const filters = readTranscriptFilters(stepInputs);

		const respond = (
			response: string,
			result: Record<string, unknown>,
			transcriptCount = 0,
		): ExecuteStepOutput => {
			const toolCalls: ToolCallRecord[] = [
				{
					id: `meeting-transcripts-${startTime}`,
					name: TOOL_NAME,
					args: {
						projectId,
						from: filters.from?.toISOString(),
						to: filters.to?.toISOString(),
						subject: filters.subject,
					},
					result,
					status: "success",
					durationMs: Date.now() - startTime,
				},
			];
			return {
				outputs: { response, toolResults: toolCalls, transcriptCount },
				variables: {},
				toolCalls,
				response,
			};
		};

		if (!projectId) {
			return respond(
				"No project is attached to this conversation, so there are no meeting transcripts to read. " +
					"Attach a project to enable meeting lookups.",
				{ message: "No project attached" },
			);
		}

		const listing = await listProjectMeetingTranscripts({
			projectId,
			userId: input.userId,
			organizationId: input.organizationId,
			filters,
		});

		return respond(
			listing.response,
			{
				transcriptCount: listing.transcriptCount,
				total: listing.total,
			},
			listing.transcriptCount,
		);
	}
}
