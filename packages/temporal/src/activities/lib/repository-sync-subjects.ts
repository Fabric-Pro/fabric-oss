/**
 * Repository sync subjects, the Temporal half (Decision 46). Each subject
 * is its database store from `@repo/database` plus `startRun`, which starts
 * the subject's sync workflow. The poll's activities, and the push webhook
 * in `@repo/api` (through the `@repo/temporal/repository-sync-subjects`
 * export), resolve a subject by kind here and reach its table and its
 * workflow only through it. This PR registers exactly one subject,
 * `instructions`.
 *
 * Lives in ./lib so the activities barrel never exposes it as an activity.
 */
import {
	type InstructionSyncTrigger,
	REPOSITORY_SYNC_SUBJECT_STORES,
	type RepositorySyncSubjectKind,
	type RepositorySyncSubjectStore,
} from "@repo/database";
import type { RepositorySyncExpectation } from "../../lib/instruction-sync-types";
import {
	type RepositorySyncStartDecorator,
	type RepositorySyncStartResult,
	startAutomaticInstructionSync,
} from "./instruction-sync-start";

export { REPOSITORY_SYNC_SUBJECT_KINDS } from "../../lib/instruction-sync-types";

export interface RepositorySyncSubject extends RepositorySyncSubjectStore {
	/**
	 * Starts the subject's sync workflow for one row's project: one workflow
	 * id per project and `workflowIdConflictPolicy: "FAIL"`, so an open run
	 * answers `already_running`. The workflow takes no run id: it records its
	 * runs under its own (Decision 44). `trigger`'s type is any value of the
	 * run row's enum but MANUAL; only a trigger in
	 * `AUTOMATIC_INSTRUCTION_SYNC_TRIGGERS` is actually eligible for the
	 * automatic-sync switches `begin` and `deriveSyncRunOutcome` enforce
	 * (Decision 47). `options.expected` is the row the start was decided on,
	 * which `begin` refuses once it has moved; the poll and the webhook always
	 * pass it (Decision 56). `options.decorate` adjusts the start options; the
	 * webhook passes `withCorrelationMemo`. One attempt, and the result names
	 * the run reached (Decisions 51 and 56).
	 */
	startRun(
		row: { id: string; projectId: string; organizationId: string },
		trigger: Exclude<InstructionSyncTrigger, "MANUAL">,
		options?: {
			expected?: RepositorySyncExpectation;
			decorate?: RepositorySyncStartDecorator;
		},
	): Promise<RepositorySyncStartResult>;
}

export const REPOSITORY_SYNC_SUBJECTS: Readonly<
	Record<RepositorySyncSubjectKind, RepositorySyncSubject>
> = {
	instructions: {
		...REPOSITORY_SYNC_SUBJECT_STORES.instructions,
		startRun: (row, trigger, options = {}) =>
			startAutomaticInstructionSync(
				{
					syncId: row.id,
					projectId: row.projectId,
					organizationId: row.organizationId,
					trigger,
					expected: options.expected,
				},
				options.decorate,
			),
	},
};

/** The subject for `kind`. The poll's activities and the webhook go through this, never a subject's queries. */
export function repositorySyncSubject(
	kind: RepositorySyncSubjectKind,
): RepositorySyncSubject {
	return REPOSITORY_SYNC_SUBJECTS[kind];
}
