/**
 * `setDeliveryTrackProcedure` (plan Slice 3 / Slice 7).
 *
 * The oRPC builder is mocked so the `.handler()` callback is captured and
 * invoked directly. Covers:
 *   - HUMAN assignment stamps trackSetBy/trackUpdatedAt.
 *   - Moving to SPIKE without an accepted spike run forces LOW estimate
 *     confidence (review sprint3 #5).
 *   - Moving to SPIKE with an accepted run leaves the confidence alone.
 *   - Non-spike tracks never touch the confidence or consult spike runs.
 *   - Cross-project storyId → NOT_FOUND (fail closed).
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
	ASSIGNABLE_DELIVERY_TRACKS: ["SPIKE", "DISCOVERY", "SPECIFY", "DEFER"],
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

import "../set-delivery-track";

function getHandler(): Handler {
	if (!captured.handler) {
		throw new Error("setDeliveryTrackProcedure handler was not captured");
	}
	return captured.handler;
}

const context = { user: { id: "u1" }, session: {} };

describe("setDeliveryTrackProcedure", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.findFirst.mockResolvedValue({ id: "s1" });
		mocks.findFirstOrThrow.mockResolvedValue({
			id: "s1",
			projectId: "p1",
			deliveryTrack: "SPIKE",
		});
	});

	it("declares STORY_UPDATE", () => {
		expect(captured.uses).toContain("require:STORY_UPDATE");
	});

	it("enters SPIKE and forces LOW in one conditional write when no spike is accepted", async () => {
		mocks.updateMany.mockResolvedValueOnce({ count: 1 });

		const result = (await getHandler()({
			input: {
				projectId: "p1",
				storyId: "s1",
				track: "SPIKE",
				rationale: "Unknown latency",
			},
			context,
		})) as { forcedLowConfidence: boolean };

		expect(mocks.updateMany).toHaveBeenCalledTimes(1);
		const call = mocks.updateMany.mock.calls[0][0];
		expect(call.where).toEqual({
			id: "s1",
			projectId: "p1",
			codingRuns: { none: ACCEPTED },
		});
		expect(call.data).toMatchObject({
			deliveryTrack: "SPIKE",
			trackRationale: "Unknown latency",
			trackSetBy: "HUMAN",
			estimateConfidence: "LOW",
		});
		expect(call.data.trackUpdatedAt).toBeInstanceOf(Date);
		expect(result.forcedLowConfidence).toBe(true);
	});

	it("keeps the earned confidence when the spike is already accepted", async () => {
		// Conditional (no accepted run) write matches nothing → plain write.
		mocks.updateMany
			.mockResolvedValueOnce({ count: 0 })
			.mockResolvedValueOnce({ count: 1 });

		const result = (await getHandler()({
			input: { projectId: "p1", storyId: "s1", track: "SPIKE" },
			context,
		})) as { forcedLowConfidence: boolean };

		expect(mocks.updateMany).toHaveBeenCalledTimes(2);
		const second = mocks.updateMany.mock.calls[1][0];
		expect(second.where).toEqual({ id: "s1", projectId: "p1" });
		expect(second.data).not.toHaveProperty("estimateConfidence");
		expect(second.data.trackRationale).toBeNull();
		expect(result.forcedLowConfidence).toBe(false);
	});

	it("never touches the confidence for other tracks", async () => {
		mocks.updateMany.mockResolvedValue({ count: 1 });
		for (const track of ["DISCOVERY", "SPECIFY", "DEFER"]) {
			mocks.updateMany.mockClear();
			await getHandler()({
				input: { projectId: "p1", storyId: "s1", track },
				context,
			});
			expect(mocks.updateMany).toHaveBeenCalledTimes(1);
			const call = mocks.updateMany.mock.calls[0][0];
			expect(call.where).toEqual({ id: "s1", projectId: "p1" });
			expect(call.data.deliveryTrack).toBe(track);
			expect(call.data).not.toHaveProperty("estimateConfidence");
		}
	});

	it("fails closed on a storyId from another project", async () => {
		mocks.findFirst.mockResolvedValue(null);
		await expect(
			getHandler()({
				input: { projectId: "p1", storyId: "other", track: "SPIKE" },
				context,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.updateMany).not.toHaveBeenCalled();
		expect(mocks.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "other", projectId: "p1" },
			}),
		);
	});

	it("fails closed with NOT_FOUND when the row vanishes between read and write", async () => {
		mocks.updateMany.mockResolvedValue({ count: 0 });
		await expect(
			getHandler()({
				input: { projectId: "p1", storyId: "s1", track: "SPECIFY" },
				context,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});
