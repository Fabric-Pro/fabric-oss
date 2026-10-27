import type {
	AnswerModelSnapshot,
	AnswerRouteChange,
} from "@repo/ai/lib/answer-model-snapshot";

/** Patch chosen before the snapshot command and reused for the answer's inputs. */
export const ADVISOR_ANSWER_SNAPSHOT_PATCH = "orch-advisor-answer-snapshot-v1";
export interface AdvisorAnswerSnapshot {
	version: 1;
	skills: {
		status: "loaded" | "unavailable";
		failure?: "load_failed" | "too_large";
		descriptors: Array<{
			slug: string;
			name: string;
			version: number;
			hash: string;
		}>;
		systemBlock: string | null;
		tools: Record<
			string,
			{ description: string; inputSchema: Record<string, unknown> }
		>;
	};
	model: AnswerModelSnapshot;
}
export interface AdvisorAnswerUpdate {
	model?: AnswerModelSnapshot;
	changes?: AnswerRouteChange[];
}
