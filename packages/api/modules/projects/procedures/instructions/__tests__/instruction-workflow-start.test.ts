/**
 * The "did the workflow start actually happen" marker, and the finalizer that
 * raises it.
 *
 * `submit-change.ts` creates a snapshot row and then calls the shared
 * finalizer. If that call fails, what it does next depends entirely on this
 * one question: close the row out, or leave it to the reaper. Getting it wrong
 * in one direction strands a proposal in the admission set for six hours; in
 * the other it rejects a row a validation run is already reading.
 *
 * So the answer is branded rather than named. These tests cover both ends —
 * that the brand cannot be forged, and that the finalizer applies it to
 * exactly one failure.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	getInstructionSnapshot: vi.fn(),
	startInstructionSnapshotValidation: vi.fn(),
	getTemporalClient: vi.fn(),
	workflowStart: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getInstructionSnapshot: (...a: unknown[]) => m.getInstructionSnapshot(...a),
	startInstructionSnapshotValidation: (...a: unknown[]) =>
		m.startInstructionSnapshotValidation(...a),
}));
vi.mock("@repo/temporal", () => ({
	getTemporalClient: (...a: unknown[]) => m.getTemporalClient(...a),
}));
vi.mock("../../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (options: unknown) => options,
}));

import { finalizeInstructionSnapshot } from "../finalize";
import {
	instructionWorkflowNotStarted,
	isInstructionWorkflowNotStarted,
	unwrapInstructionWorkflowError,
} from "../instruction-workflow-start";

const input = {
	snapshot: { id: "snap_1", status: "RECEIVING" as const },
	projectId: "proj_1",
	organizationId: "org_1",
	userId: "user_1",
};

beforeEach(() => {
	for (const fn of Object.values(m)) {
		(fn as ReturnType<typeof vi.fn>).mockReset();
	}
	m.startInstructionSnapshotValidation.mockResolvedValue({ changed: true });
	m.workflowStart.mockResolvedValue(undefined);
	m.getTemporalClient.mockResolvedValue({
		workflow: { start: (...a: unknown[]) => m.workflowStart(...a) },
	});
});

describe("the marker", () => {
	it("recognises one it made itself, and carries the original failure", () => {
		const cause = new Error("getaddrinfo ENOTFOUND temporal");
		const marker = instructionWorkflowNotStarted(cause);

		expect(isInstructionWorkflowNotStarted(marker)).toBe(true);
		expect(unwrapInstructionWorkflowError(marker)).toBe(cause);
	});

	/**
	 * The reason it is a Symbol and not a name.
	 *
	 * `name === "InstructionWorkflowNotStartedError"` is the obvious check and
	 * the wrong one: an error that merely carries that name — wrapped by a
	 * library, deserialised across a boundary, constructed by code that never
	 * went near this path — would be read as a promise that no execution
	 * exists, and the caller would then reject a snapshot a workflow may own.
	 */
	it("does not recognise a foreign error that only borrows the name", () => {
		const impostor = Object.assign(new Error("something else"), {
			name: "InstructionWorkflowNotStartedError",
			cause: new Error("inner"),
		});

		expect(isInstructionWorkflowNotStarted(impostor)).toBe(false);
		// And unwrapping leaves it exactly as it is, so no caller can be
		// tricked into surfacing the wrong error either.
		expect(unwrapInstructionWorkflowError(impostor)).toBe(impostor);
	});

	/**
	 * A rejection can carry no value at all — `Promise.reject()`, a transport
	 * that throws `null`. The wrapper still records it, because
	 * `new Error(msg, { cause })` installs the property whatever the value is,
	 * so the question is whether a cause is PRESENT and not whether it is
	 * truthy. A `cause ?? error` handed back the wrapper for exactly these two
	 * failures, and the caller then surfaced "Could not reach Temporal to
	 * start the validation workflow" as though that were what went wrong.
	 */
	it.each([
		["null", null],
		["undefined", undefined],
	])("unwraps a %s cause instead of the wrapper", (_label, cause) => {
		const marker = instructionWorkflowNotStarted(cause);

		expect(isInstructionWorkflowNotStarted(marker)).toBe(true);
		expect(unwrapInstructionWorkflowError(marker)).toBe(cause);
		expect(unwrapInstructionWorkflowError(marker)).not.toBe(marker);
	});

	it.each([
		["a plain error", new Error("boom")],
		["null", null],
		["a string", "InstructionWorkflowNotStartedError"],
		["an object with a same-named symbol", { [Symbol("x")]: true }],
	])("does not recognise %s", (_label, value) => {
		expect(isInstructionWorkflowNotStarted(value)).toBe(false);
		expect(unwrapInstructionWorkflowError(value)).toBe(value);
	});
});

describe("finalizeInstructionSnapshot's two halves", () => {
	it("marks a failure to REACH Temporal as a start that never happened", async () => {
		const cause = new Error("getaddrinfo ENOTFOUND temporal");
		m.getTemporalClient.mockRejectedValue(cause);

		const error = await finalizeInstructionSnapshot(input).catch(
			(e: unknown) => e,
		);

		expect(isInstructionWorkflowNotStarted(error)).toBe(true);
		expect(unwrapInstructionWorkflowError(error)).toBe(cause);
		expect(m.workflowStart).not.toHaveBeenCalled();
		expect(m.startInstructionSnapshotValidation).not.toHaveBeenCalled();
	});

	// A start that WAS called and rejected may have succeeded with only its
	// acknowledgement lost — which is exactly why the finalizer tolerates
	// `WorkflowExecutionAlreadyStartedError` at all. It must not be dressed up
	// as "never started".
	it("leaves a rejected workflow.start unmarked and unchanged", async () => {
		const failure = new Error("workflow start rejected by the server");
		m.workflowStart.mockRejectedValue(failure);

		const error = await finalizeInstructionSnapshot(input).catch(
			(e: unknown) => e,
		);

		expect(error).toBe(failure);
		expect(isInstructionWorkflowNotStarted(error)).toBe(false);
	});

	// The early returns happen before Temporal is reached at all, so they are
	// not failures and must not be marked as anything.
	it("does not reach Temporal for a row a run already owns", async () => {
		const result = await finalizeInstructionSnapshot({
			...input,
			snapshot: { id: "snap_1", status: "VALIDATING" },
		});

		expect(result).toEqual({ status: "VALIDATING" });
		expect(m.getTemporalClient).not.toHaveBeenCalled();
	});
});
