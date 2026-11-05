/**
 * Accepting a decision created with "Create as update" names the decision it
 * replaces, once, and never one that is no longer in force.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getArchitectureDecision: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getArchitectureDecision: mocks.getArchitectureDecision,
	livingMemoryUpdateTargetId: ({
		sourceKind,
		sourceMetadata,
	}: {
		sourceKind: string | null;
		sourceMetadata: { supersedes?: string } | null;
	}) =>
		sourceKind === "living_memory"
			? (sourceMetadata?.supersedes ?? null)
			: null,
}));

import { acceptedUpdateTargetIds } from "../accepted-update";

const update = {
	projectId: "p-1",
	previousStatus: "PROPOSED",
	newStatus: "ACCEPTED",
	sourceKind: "living_memory",
	sourceMetadata: { supersedes: "dec-old" },
};

beforeEach(() => {
	mocks.getArchitectureDecision.mockReset();
	mocks.getArchitectureDecision.mockResolvedValue({
		id: "dec-old",
		status: "ACCEPTED",
	});
});

describe("acceptedUpdateTargetIds", () => {
	it("names the decision an update replaces when it is accepted", async () => {
		await expect(acceptedUpdateTargetIds(update)).resolves.toEqual([
			"dec-old",
		]);
		expect(mocks.getArchitectureDecision).toHaveBeenCalledWith({
			id: "dec-old",
			projectId: "p-1",
		});
	});

	it("does nothing when an accepted decision is saved again", async () => {
		await expect(
			acceptedUpdateTargetIds({ ...update, previousStatus: "ACCEPTED" }),
		).resolves.toEqual([]);
		expect(mocks.getArchitectureDecision).not.toHaveBeenCalled();
	});

	it.each(["PROPOSED", "REJECTED", "DEPRECATED"])(
		"does nothing when the update is moved to %s",
		async (newStatus) => {
			await expect(
				acceptedUpdateTargetIds({ ...update, newStatus }),
			).resolves.toEqual([]);
		},
	);

	it("does nothing for a decision that was not created as an update", async () => {
		await expect(
			acceptedUpdateTargetIds({ ...update, sourceMetadata: {} }),
		).resolves.toEqual([]);
		await expect(
			acceptedUpdateTargetIds({
				...update,
				sourceKind: "meeting_decision",
			}),
		).resolves.toEqual([]);
	});

	it.each(["SUPERSEDED", "DEPRECATED", "REJECTED"])(
		"leaves a target that is already %s alone",
		async (status) => {
			mocks.getArchitectureDecision.mockResolvedValue({
				id: "dec-old",
				status,
			});

			await expect(acceptedUpdateTargetIds(update)).resolves.toEqual([]);
		},
	);

	it("names nothing when the target was deleted", async () => {
		mocks.getArchitectureDecision.mockResolvedValue(null);

		await expect(acceptedUpdateTargetIds(update)).resolves.toEqual([]);
	});
});
