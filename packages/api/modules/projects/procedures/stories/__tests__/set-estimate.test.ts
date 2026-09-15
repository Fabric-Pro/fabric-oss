/**
 * `setEstimateProcedure` (plan Slice 7).
 *
 * The oRPC builder is mocked so the `.handler()` callback is captured and
 * invoked directly. Covers:
 *   - SPIKE without an accepted spike run → confidence forced to LOW and
 *     `forcedLowConfidence: true`, whatever the caller asked for.
 *   - SPIKE with an accepted run → caller's confidence is honoured.
 *   - Non-spike → caller's confidence is honoured, no run lookup.
 *   - Cross-project storyId → NOT_FOUND (fail closed).
 *   - Input schema: confidence / size enums and point bounds.
 *   - Permission middleware wiring (STORY_UPDATE).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (args: {
	input: Record<string, unknown>;
	context: Record<string, unknown>;
}) => Promise<unknown>;

const captured = vi.hoisted(
	(): { handler: Handler | null; uses: unknown[] } => ({
		handler: null,
		uses: [],
	}),
);

const { mocks, ACCEPTED } = vi.hoisted(() => ({
	mocks: {
		findFirst: vi.fn(),
		updateMany: vi.fn(),
		findFirstOrThrow: vi.fn(),
	},
	ACCEPTED: {
		kind: "SPIKE",
		status: "COMPLETED",
		findings: { not: null },
	} as const,
}));

vi.mock("@repo/database", () => ({
	db: {
		userStory: {
			findFirst: mocks.findFirst,
			updateMany: mocks.updateMany,
			findFirstOrThrow: mocks.findFirstOrThrow,
		},
	},
	ACCEPTED_SPIKE_RUN_WHERE: ACCEPTED,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const builder = {
		use: vi.fn((middleware: unknown) => {
			captured.uses.push(middleware);
			return builder;
		}),
		route: vi.fn(),
		input: vi.fn(),
		output: vi.fn(),
		handler: vi.fn((fn: Handler) => {
			captured.handler = fn;
			return builder;
		}),
	};
	builder.route.mockReturnValue(builder);
	builder.input.mockReturnValue(builder);
	builder.output.mockReturnValue(builder);
	return {
		Permissions: { STORY_UPDATE: "STORY_UPDATE" },
		requireProjectPermission: vi.fn(
			(permission: string) => `require:${permission}`,
		),
		tenantProtectedProcedure: builder,
	};
});

import { setEstimateInputSchema } from "../set-estimate";

function getHandler(): Handler {
	if (!captured.handler) {
		throw new Error("setEstimateProcedure handler was not captured");
	}
	return captured.handler;
}

const context = { user: { id: "u1" }, session: {} };

describe("setEstimateProcedure", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.findFirst.mockResolvedValue({ id: "s1" });
		mocks.findFirstOrThrow.mockResolvedValue({
			id: "s1",
			projectId: "p1",
			estimateConfidence: "LOW",
		});
	});

	it("declares STORY_UPDATE", () => {
		expect(captured.uses).toContain("require:STORY_UPDATE");
	});

	it("writes a non-LOW confidence only where the row is not an unproven SPIKE, and falls back to LOW", async () => {
		// First (conditional) write matches nothing: the row is a SPIKE with
		// no accepted run at write time. Second write forces LOW.
		mocks.updateMany
			.mockResolvedValueOnce({ count: 0 })
			.mockResolvedValueOnce({ count: 1 });

		const result = (await getHandler()({
			input: {
				projectId: "p1",
				storyId: "s1",
				storyPoints: 3,
				estimateConfidence: "HIGH",
			},
			context,
		})) as { forcedLowConfidence: boolean };

		expect(mocks.updateMany).toHaveBeenNthCalledWith(1, {
			where: {
				id: "s1",
				projectId: "p1",
				OR: [
					{ deliveryTrack: { not: "SPIKE" } },
					{ codingRuns: { some: ACCEPTED } },
				],
			},
			data: { storyPoints: 3, estimateConfidence: "HIGH" },
		});
		expect(mocks.updateMany).toHaveBeenNthCalledWith(2, {
			where: { id: "s1", projectId: "p1" },
			data: { storyPoints: 3, estimateConfidence: "LOW" },
		});
		expect(result.forcedLowConfidence).toBe(true);
	});

	it("honours the caller's confidence when the conditional write lands (not a SPIKE, or accepted)", async () => {
		mocks.updateMany.mockResolvedValueOnce({ count: 1 });

		const result = (await getHandler()({
			input: {
				projectId: "p1",
				storyId: "s1",
				estimateConfidence: "MEDIUM",
			},
			context,
		})) as { forcedLowConfidence: boolean };

		expect(mocks.updateMany).toHaveBeenCalledTimes(1);
		expect(mocks.updateMany.mock.calls[0][0].data).toEqual({
			estimateConfidence: "MEDIUM",
		});
		expect(result.forcedLowConfidence).toBe(false);
	});

	it("writes LOW, or size/points without a confidence, unconditionally", async () => {
		mocks.updateMany.mockResolvedValue({ count: 1 });

		await getHandler()({
			input: {
				projectId: "p1",
				storyId: "s1",
				estimateConfidence: "LOW",
			},
			context,
		});
		expect(mocks.updateMany).toHaveBeenLastCalledWith({
			where: { id: "s1", projectId: "p1" },
			data: { estimateConfidence: "LOW" },
		});

		await getHandler()({
			input: {
				projectId: "p1",
				storyId: "s1",
				size: "L",
				storyPoints: 8,
			},
			context,
		});
		expect(mocks.updateMany).toHaveBeenLastCalledWith({
			where: { id: "s1", projectId: "p1" },
			data: { size: "L", storyPoints: 8 },
		});
	});

	it("fails closed with NOT_FOUND when the story is not in the project", async () => {
		mocks.findFirst.mockResolvedValue(null);
		await expect(
			getHandler()({
				input: { projectId: "p1", storyId: "other", storyPoints: 1 },
				context,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.updateMany).not.toHaveBeenCalled();
	});

	it("fails closed with NOT_FOUND when the row vanishes between read and write", async () => {
		mocks.updateMany.mockResolvedValue({ count: 0 });
		await expect(
			getHandler()({
				input: {
					projectId: "p1",
					storyId: "s1",
					estimateConfidence: "HIGH",
				},
				context,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	describe("input schema", () => {
		it("accepts the confidence and size enums and bounded points", () => {
			expect(
				setEstimateInputSchema.safeParse({
					projectId: "p1",
					storyId: "s1",
					size: "M",
					storyPoints: 5,
					estimateConfidence: "MEDIUM",
				}).success,
			).toBe(true);
			expect(
				setEstimateInputSchema.safeParse({
					projectId: "p1",
					storyId: "s1",
					estimateConfidence: "SURE",
				}).success,
			).toBe(false);
			expect(
				setEstimateInputSchema.safeParse({
					projectId: "p1",
					storyId: "s1",
					storyPoints: -1,
				}).success,
			).toBe(false);
		});
	});
});
