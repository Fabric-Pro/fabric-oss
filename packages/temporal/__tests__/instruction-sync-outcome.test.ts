import type { InstructionSyncTrigger } from "@repo/database";
import { describe, expect, it } from "vitest";
import {
	deriveSyncRunOutcome,
	type SyncOutcomeInput,
} from "../src/activities/lib/instruction-sync-outcome";
import { AUTOMATIC_INSTRUCTION_SYNC_TRIGGERS } from "../src/lib/instruction-sync-types";

const SHA = "c".repeat(40);
const base: SyncOutcomeInput = {
	trigger: "MANUAL",
	skipped: false,
	unchanged: false,
	error: null,
	commitSha: SHA,
	snapshot: null,
	publishReason: null,
};
const ready = {
	status: "READY" as const,
	publishedAt: null,
	rejection: null,
	isPublishedPointer: false,
};
const abandoned = [
	{ path: "(upload)", reason: "abandoned", detail: "staging pending" },
];

describe("deriveSyncRunOutcome: the spec §5.4 outcome table", () => {
	it.each([
		[
			"pointer is this snapshot",
			{
				snapshot: {
					...ready,
					publishedAt: new Date(),
					isPublishedPointer: true,
				},
			},
			{
				status: "SUCCEEDED",
				error: null,
				note: null,
				scheduling: { kind: "success", commitSha: SHA },
			},
		],
		[
			"published once, pointer elsewhere since",
			{ snapshot: { ...ready, publishedAt: new Date() } },
			{
				status: "SUCCEEDED",
				error: null,
				note: "superseded",
				scheduling: { kind: "success", commitSha: SHA },
			},
		],
		[
			"READY, fenced by a configuration change",
			{ snapshot: ready, publishReason: "configuration_changed" },
			{
				status: "NOT_PUBLISHED",
				error: "CONFIGURATION_CHANGED",
				note: null,
				scheduling: { kind: "none" },
			},
		],
		[
			"READY, a later version won",
			{ snapshot: ready, publishReason: "older_than_current" },
			{
				status: "NOT_PUBLISHED",
				error: null,
				note: null,
				scheduling: { kind: "none" },
			},
		],
		[
			"READY, permission revoked, manual",
			{ snapshot: ready, publishReason: "permission_revoked" },
			{
				status: "NOT_PUBLISHED",
				error: "PERMISSION_DENIED",
				note: null,
				scheduling: { kind: "none" },
			},
		],
		[
			"READY, permission revoked, automatic",
			{
				trigger: "POLL",
				snapshot: ready,
				publishReason: "permission_revoked",
			},
			{
				status: "NOT_PUBLISHED",
				error: "PERMISSION_DENIED",
				note: null,
				scheduling: { kind: "pause", reason: "PERMISSION_REVOKED" },
			},
		],
		[
			"READY, reason unknown (the child threw before reporting), manual",
			{ snapshot: ready },
			{
				status: "FAILED",
				error: "CHILD_ABORTED",
				note: null,
				scheduling: { kind: "none" },
			},
		],
		[
			"READY, reason unknown (the child threw before reporting), automatic",
			{ trigger: "POLL", snapshot: ready },
			{
				status: "FAILED",
				error: "CHILD_ABORTED",
				note: null,
				scheduling: { kind: "backoff" },
			},
		],
		[
			"REJECTED with the abandoned marker, checked before the generic REJECTED row",
			{
				trigger: "POLL",
				snapshot: {
					...ready,
					status: "REJECTED",
					rejection: abandoned,
				},
			},
			{
				status: "FAILED",
				error: "CHILD_ABORTED",
				note: null,
				scheduling: { kind: "backoff" },
			},
		],
		[
			"abandoned after the acquisition itself failed: its own error wins",
			{
				trigger: "POLL",
				error: "STORAGE_FAILED",
				snapshot: {
					...ready,
					status: "REJECTED",
					rejection: abandoned,
				},
			},
			{
				status: "FAILED",
				error: "STORAGE_FAILED",
				note: null,
				scheduling: { kind: "backoff" },
			},
		],
		[
			"REJECTED by the gate",
			{
				snapshot: {
					...ready,
					status: "REJECTED",
					rejection: [{ path: "a.md", reason: "secret" }],
				},
			},
			{
				status: "REJECTED",
				error: null,
				note: null,
				scheduling: { kind: "suppress", commitSha: SHA },
			},
		],
		[
			"FAILED",
			{ trigger: "POLL", snapshot: { ...ready, status: "FAILED" } },
			{
				status: "FAILED",
				error: "CHILD_ABORTED",
				note: null,
				scheduling: { kind: "backoff" },
			},
		],
		[
			"still RECEIVING (child still unknown)",
			{ trigger: "POLL", snapshot: { ...ready, status: "RECEIVING" } },
			{
				status: "FAILED",
				error: "CHILD_ABORTED",
				note: null,
				scheduling: { kind: "backoff" },
			},
		],
		[
			"no snapshot, unchanged",
			{ unchanged: true },
			{
				status: "UNCHANGED",
				error: null,
				note: null,
				scheduling: { kind: "success", commitSha: SHA },
			},
		],
		[
			"begin skipped",
			{ skipped: true },
			{
				status: "SKIPPED",
				error: null,
				note: null,
				scheduling: { kind: "none" },
			},
		],
		[
			"no snapshot, LIMITS_EXCEEDED",
			{ error: "LIMITS_EXCEEDED" },
			{
				status: "FAILED",
				error: "LIMITS_EXCEEDED",
				note: null,
				scheduling: { kind: "suppress", commitSha: SHA },
			},
		],
		[
			"no snapshot, LIMITS_EXCEEDED before the commit was known",
			{ trigger: "POLL", error: "LIMITS_EXCEEDED", commitSha: null },
			{
				status: "FAILED",
				error: "LIMITS_EXCEEDED",
				note: null,
				scheduling: { kind: "backoff" },
			},
		],
		[
			"no snapshot, TREE_REFUSED",
			{ error: "TREE_REFUSED" },
			{
				status: "FAILED",
				error: "TREE_REFUSED",
				note: null,
				scheduling: { kind: "suppress", commitSha: SHA },
			},
		],
		[
			"no snapshot, PERMISSION_DENIED, manual",
			{ error: "PERMISSION_DENIED" },
			{
				status: "FAILED",
				error: "PERMISSION_DENIED",
				note: null,
				scheduling: { kind: "none" },
			},
		],
		[
			"no snapshot, PERMISSION_DENIED, automatic",
			{ trigger: "WEBHOOK", error: "PERMISSION_DENIED" },
			{
				status: "FAILED",
				error: "PERMISSION_DENIED",
				note: null,
				scheduling: { kind: "pause", reason: "PERMISSION_REVOKED" },
			},
		],
		[
			"no snapshot, REF_MISSING, automatic",
			{ trigger: "POLL", error: "REF_MISSING" },
			{
				status: "FAILED",
				error: "REF_MISSING",
				note: null,
				scheduling: { kind: "pause", reason: "REF_MISSING" },
			},
		],
		[
			"no snapshot, ROOT_MISSING, automatic",
			{ trigger: "WEBHOOK", error: "ROOT_MISSING" },
			{
				status: "FAILED",
				error: "ROOT_MISSING",
				note: null,
				scheduling: { kind: "pause", reason: "REF_MISSING" },
			},
		],
		...(
			[
				"CLONE_FAILED",
				"INTEGRATION_UNAVAILABLE",
				"STORAGE_FAILED",
			] as const
		).map(
			(error) =>
				[
					`no snapshot, ${error}, automatic`,
					{ trigger: "POLL", error },
					{
						status: "FAILED",
						error,
						note: null,
						scheduling: { kind: "backoff" },
					},
				] as const,
		),
		[
			"begin found its run under an older generation",
			{ error: "CONFIGURATION_CHANGED" },
			{
				status: "FAILED",
				error: "CONFIGURATION_CHANGED",
				note: null,
				scheduling: { kind: "none" },
			},
		],
	] as const)("%s", (_label, overrides, expected) => {
		expect(
			deriveSyncRunOutcome({
				...base,
				...(overrides as Partial<SyncOutcomeInput>),
			}),
		).toEqual(expected);
	});
});

describe("automatic eligibility is AUTOMATIC_INSTRUCTION_SYNC_TRIGGERS, not every non-MANUAL trigger (Decision 47)", () => {
	// A value no migration has added yet, e.g. a future PULL_REQUEST_MERGED
	// trigger. It is not in AUTOMATIC_INSTRUCTION_SYNC_TRIGGERS, so it must be
	// treated like MANUAL: never paused for a revoked delegate.
	const FUTURE = "FUTURE_TRIGGER" as unknown as InstructionSyncTrigger;

	it("does not pause a revoked delegate's run for a trigger outside AUTOMATIC_INSTRUCTION_SYNC_TRIGGERS", () => {
		expect(
			deriveSyncRunOutcome({
				...base,
				trigger: FUTURE,
				error: "PERMISSION_DENIED",
			}).scheduling,
		).toEqual({ kind: "none" });
	});

	it("pauses a revoked delegate's run for POLL and WEBHOOK, the automatic set", () => {
		for (const trigger of AUTOMATIC_INSTRUCTION_SYNC_TRIGGERS) {
			expect(
				deriveSyncRunOutcome({
					...base,
					trigger,
					error: "PERMISSION_DENIED",
				}).scheduling,
			).toEqual({ kind: "pause", reason: "PERMISSION_REVOKED" });
		}
	});

	it("still reads outcomes that do not depend on the delegate's permission the same for a future trigger as for MANUAL", () => {
		expect(
			deriveSyncRunOutcome({ ...base, trigger: FUTURE, unchanged: true }),
		).toEqual(
			deriveSyncRunOutcome({
				...base,
				trigger: "MANUAL",
				unchanged: true,
			}),
		);
		expect(
			deriveSyncRunOutcome({ ...base, trigger: FUTURE, skipped: true }),
		).toEqual(
			deriveSyncRunOutcome({ ...base, trigger: "MANUAL", skipped: true }),
		);
	});
});

describe("a manual run never pauses or backs off the automatic schedule (Fizzy #2706)", () => {
	// Every row of the table that would pause or back off, keyed by the
	// input that reaches it. For MANUAL (and any trigger outside the
	// automatic set) the effect is none: the failure belongs to the run's
	// own row, and polling that was healthy stays healthy.
	const WOULD_PAUSE_OR_BACK_OFF = [
		[
			"REF_MISSING",
			{ error: "REF_MISSING" },
			{ kind: "pause", reason: "REF_MISSING" },
		],
		[
			"ROOT_MISSING",
			{ error: "ROOT_MISSING" },
			{ kind: "pause", reason: "REF_MISSING" },
		],
		[
			"PERMISSION_DENIED",
			{ error: "PERMISSION_DENIED" },
			{ kind: "pause", reason: "PERMISSION_REVOKED" },
		],
		["CLONE_FAILED", { error: "CLONE_FAILED" }, { kind: "backoff" }],
		[
			"INTEGRATION_UNAVAILABLE",
			{ error: "INTEGRATION_UNAVAILABLE" },
			{ kind: "backoff" },
		],
		["STORAGE_FAILED", { error: "STORAGE_FAILED" }, { kind: "backoff" }],
		["INTERRUPTED", { error: "INTERRUPTED" }, { kind: "backoff" }],
		[
			"LIMITS_EXCEEDED before the commit was known",
			{ error: "LIMITS_EXCEEDED", commitSha: null },
			{ kind: "backoff" },
		],
		["child aborted", { snapshot: ready }, { kind: "backoff" }],
		[
			"snapshot FAILED",
			{ snapshot: { ...ready, status: "FAILED" } },
			{ kind: "backoff" },
		],
		[
			"abandoned",
			{
				snapshot: {
					...ready,
					status: "REJECTED",
					rejection: abandoned,
				},
			},
			{ kind: "backoff" },
		],
	] as const;

	it.each(WOULD_PAUSE_OR_BACK_OFF)(
		"%s: no effect for MANUAL, the automatic effect for POLL and WEBHOOK",
		(_label, overrides, automaticEffect) => {
			const input = {
				...base,
				...(overrides as Partial<SyncOutcomeInput>),
			};
			expect(
				deriveSyncRunOutcome({ ...input, trigger: "MANUAL" })
					.scheduling,
			).toEqual({ kind: "none" });
			for (const trigger of AUTOMATIC_INSTRUCTION_SYNC_TRIGGERS) {
				expect(
					deriveSyncRunOutcome({ ...input, trigger }).scheduling,
				).toEqual(automaticEffect);
			}
		},
	);

	it("a manual failure still records its status and error; only the schedule is untouched", () => {
		expect(deriveSyncRunOutcome({ ...base, error: "REF_MISSING" })).toEqual(
			{
				status: "FAILED",
				error: "REF_MISSING",
				note: null,
				scheduling: { kind: "none" },
			},
		);
	});

	it("a manual success and a commit-keyed suppression keep moving the schedule", () => {
		expect(
			deriveSyncRunOutcome({ ...base, unchanged: true }).scheduling,
		).toEqual({ kind: "success", commitSha: SHA });
		expect(
			deriveSyncRunOutcome({ ...base, error: "TREE_REFUSED" }).scheduling,
		).toEqual({ kind: "suppress", commitSha: SHA });
	});
});
