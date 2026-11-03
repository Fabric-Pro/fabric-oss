/**
 * Chunking tuning tools (spec 2026-10-28 §8c), for the attached project:
 *
 *  - `fabric_tune_chunking` (READ): `estimate` profiles the content and
 *    returns the bounded cost; `confirm` starts the analysis once the person
 *    agreed to it; `status` reports progress or the proposal table.
 *  - `fabric_update_chunking_settings` (WRITE, so it goes through the
 *    orchestrator's approval step): applies a finished proposal, which
 *    re-chunks the project.
 *
 * Asking for the analysis needs read access to the project; applying needs
 * the permission saving RAG Settings needs. Every run is looked up by
 * project AND organization, so a run id from another tenant matches nothing.
 */

import { findAiUsageLimitError } from "@repo/ai/lib/find-usage-limit-error";
import { rethrowIfDispatchStopped } from "@repo/utils/dispatch-guard";
import type { ExecuteStepInput, ExecuteStepOutput } from "../../types";
import type { HandlerContext, HandlerResult, StepHandler } from "./types";

export const TUNE_CHUNKING_TOOL = "fabric_tune_chunking";
export const UPDATE_CHUNKING_TOOL = "fabric_update_chunking_settings";

function pct(value: number | null): string {
	return value === null ? "–" : `${Math.round(value * 100)}%`;
}

/** The proposal as the agent shows it (§8c step 5). */
export function formatChunkingProposal(
	rows: Array<{
		contentType: string;
		sources: number;
		current: string;
		proposed: string;
		recallBefore: number | null;
		recallAfter: number | null;
		reembedChunks: number | null;
		reason: string;
	}>,
): string {
	const lines = [
		"| Type | Sources | Current | Proposed | Recall before → after | Re-embed (sample chunks) | Why |",
		"|---|---|---|---|---|---|---|",
		...rows.map(
			(r) =>
				`| ${r.contentType} | ${r.sources} | ${r.current} | ${r.proposed} | ${pct(r.recallBefore)} → ${pct(r.recallAfter)} | ${r.reembedChunks ?? "–"} | ${r.reason} |`,
		),
	];
	return lines.join("\n");
}

export class ChunkingTuningHandler implements StepHandler {
	readonly name = "chunking-tuning";
	readonly capabilities = ["chunking_tuning"];

	canHandle(input: ExecuteStepInput): boolean {
		const tool = input.step.app ?? input.step.executor;
		return tool === TUNE_CHUNKING_TOOL || tool === UPDATE_CHUNKING_TOOL;
	}

	async execute(context: HandlerContext): Promise<HandlerResult> {
		try {
			return { handled: true, output: await this.run(context.input) };
		} catch (error) {
			rethrowIfDispatchStopped(error);
			const usageLimitError = findAiUsageLimitError(error);
			if (usageLimitError) {
				throw usageLimitError;
			}
			const message =
				error instanceof Error ? error.message : String(error);
			return {
				handled: false,
				error: `Chunking tuning failed: ${message}`,
				shouldFallback: false,
			};
		}
	}

	private async run(input: ExecuteStepInput): Promise<ExecuteStepOutput> {
		const startTime = Date.now();
		const tool =
			input.step.app === UPDATE_CHUNKING_TOOL ||
			input.step.executor === UPDATE_CHUNKING_TOOL
				? UPDATE_CHUNKING_TOOL
				: TUNE_CHUNKING_TOOL;
		const args = (input.step.inputs ?? {}) as Record<string, unknown>;
		const respond = (
			response: string,
			result: Record<string, unknown>,
		): ExecuteStepOutput => {
			const toolCalls = [
				{
					id: `${tool}-${startTime}`,
					name: tool,
					args,
					result,
					status: "success" as const,
					durationMs: Date.now() - startTime,
				},
			];
			return {
				outputs: { response, toolResults: toolCalls },
				variables: {},
				toolCalls,
				response,
			};
		};

		const projectId = input.projectId;
		const organizationId = input.organizationId;
		if (!projectId || !organizationId) {
			return respond("Attach a project to tune its chunking.", {
				message: "No project attached",
			});
		}
		const db = await import("@repo/database");
		const runs = await import("../../../../lib/project-chunking-runs");
		const scope = {
			projectId,
			organizationId,
			userId: input.userId,
		};

		if (tool === UPDATE_CHUNKING_TOOL) {
			if (!(await db.canEditProjectSettings(projectId, input.userId))) {
				return respond(
					"You need permission to edit this project's settings to change its chunking.",
					{ message: "Forbidden" },
				);
			}
			const runId = typeof args.runId === "string" ? args.runId : "";
			const applied = await runs.applyChunkingProposalRun({
				...scope,
				runId,
			});
			if (!applied.ok) {
				return respond(
					"That chunking proposal can't be applied (it is missing, not finished, or already applied).",
					{ refusal: applied.refusal },
				);
			}
			return respond(
				"Applied. The project now chunks by content type with the proposed settings, and a re-chunk has started; search keeps working while it runs. Progress is on RAG Settings.",
				{
					chunkingVersion: applied.chunkingVersion,
					rechunkRunId: applied.rechunkRunId,
				},
			);
		}

		if (
			!(await db.hasProjectAccess(
				projectId,
				input.userId,
				organizationId,
			))
		) {
			return respond("You don't have access to this project.", {
				message: "Access denied",
			});
		}

		const action =
			typeof args.action === "string" ? args.action : "estimate";
		const runId = typeof args.runId === "string" ? args.runId : "";

		if (action === "confirm") {
			const started = await runs.confirmChunkingAnalysisRun({
				...scope,
				runId,
			});
			return started.ok
				? respond(
						"The chunking analysis has started. It usually takes a few minutes; ask for its status with the same run id.",
						{ runId, started: true },
					)
				: respond("That analysis is not waiting for a confirmation.", {
						refusal: started.refusal,
					});
		}

		if (action === "status") {
			const run = await db.getProjectChunkingRun(runId);
			if (
				!run ||
				run.projectId !== projectId ||
				run.organizationId !== organizationId
			) {
				return respond("No such chunking analysis in this project.", {
					refusal: "not-found",
				});
			}
			const result = (run.result ?? {}) as {
				stage?: string;
				rows?: Parameters<typeof formatChunkingProposal>[0];
			};
			if (result.stage === "proposal" && result.rows) {
				return respond(
					[
						"Proposed chunking per content type (measured on a sample of this project's content):",
						"",
						formatChunkingProposal(result.rows),
						"",
						`To apply it, call ${UPDATE_CHUNKING_TOOL} with runId ${run.id}. Nothing changes until then.`,
					].join("\n"),
					{ runId: run.id, status: run.status, rows: result.rows },
				);
			}
			return respond(`The analysis is ${run.status.toLowerCase()}.`, {
				runId: run.id,
				status: run.status,
				error: run.error,
			});
		}

		const { runId: newRunId, plan } = await runs.prepareChunkingAnalysisRun(
			{
				...scope,
				mode: "TUNE",
			},
		);
		const skipped = plan.types.filter((t) => !t.measurable);
		return respond(
			[
				`I can analyse this project's chunking and propose settings per content type. It will sample ${plan.estimate.sampledSources} sources, write about ${plan.estimate.questions} test questions with your organization's model, and make about ${plan.estimate.embeddingCalls} embedding calls. Nothing in the project changes until you approve a proposal.`,
				skipped.length > 0
					? `Types with fewer than 5 sources get the default without a measurement: ${skipped.map((t) => t.contentType).join(", ")}.`
					: "",
				`Shall I go ahead? (run ${newRunId})`,
			]
				.filter(Boolean)
				.join("\n\n"),
			{ runId: newRunId, estimate: plan.estimate },
		);
	}
}
