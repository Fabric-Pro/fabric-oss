/**
 * Unit tests for `logReinjectedAttachments`.
 *
 * The helper is the single source of truth for the structured `warn`
 * line emitted by the four attachment-guard sites. These tests pin the
 * call shape — message string and field schema — so the surface enum
 * cannot drift across the four call sites and so future edits to the
 * helper cannot silently change the observability contract.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		loggerWarn: vi.fn(),
	},
}));

vi.mock("@repo/logs", () => ({
	logger: {
		warn: mocks.loggerWarn,
		info: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock("@repo/database", () => ({}));

const { logReinjectedAttachments } = await import(
	"../log-reinjected-attachments"
);

beforeEach(() => {
	mocks.loggerWarn.mockReset();
});

describe("logReinjectedAttachments", () => {
	it("emits one `logger.warn` whose payload matches the §10.1 field schema", () => {
		logReinjectedAttachments({
			storyId: "story-1",
			projectId: "project-1",
			surface: "stage-transition",
			targetStage: "SANITY_CHECK",
			draftingStage: "ACTIVE_ANALYSIS",
			droppedKeys: [
				"story-media/project-1/story-1/k1.png",
				"story-media/project-1/story-1/k2.png",
			],
		});

		expect(mocks.loggerWarn).toHaveBeenCalledTimes(1);
		expect(mocks.loggerWarn).toHaveBeenCalledWith(
			"[stage-transition] reinjected dropped attachments",
			{
				storyId: "story-1",
				projectId: "project-1",
				surface: "stage-transition",
				targetStage: "SANITY_CHECK",
				droppedKeyCount: 2,
				droppedKeys: [
					"story-media/project-1/story-1/k1.png",
					"story-media/project-1/story-1/k2.png",
				],
				draftingStage: "ACTIVE_ANALYSIS",
			},
		);
	});

	it("computes `droppedKeyCount` from `droppedKeys.length` inside the helper, not from the caller", () => {
		// Caller passes only the array; the helper derives the count. This
		// pins the §10.1 contract: callers cannot pass a mismatched
		// `droppedKeyCount` because the helper does not accept one.
		logReinjectedAttachments({
			storyId: "story-2",
			projectId: "project-2",
			surface: "update-with-context",
			targetStage: null,
			draftingStage: "DRAFT",
			droppedKeys: [
				"story-media/project-2/story-2/a.png",
				"story-media/project-2/story-2/b.png",
				"story-media/project-2/story-2/c.png",
			],
		});

		const payload = mocks.loggerWarn.mock.calls[0]?.[1] as {
			droppedKeyCount: number;
			droppedKeys: string[];
		};
		expect(payload.droppedKeyCount).toBe(payload.droppedKeys.length);
		expect(payload.droppedKeyCount).toBe(3);
	});

	it("emits an empty `droppedKeys` array with `droppedKeyCount: 0` when called with no keys", () => {
		// Defensive — call sites are expected to guard against the empty-
		// drop case before invoking the helper, but the helper itself
		// remains a pure structural emitter and must not throw when
		// invoked with an empty array.
		logReinjectedAttachments({
			storyId: "story-3",
			projectId: "project-3",
			surface: "reevaluate-bug",
			targetStage: null,
			draftingStage: null,
			droppedKeys: [],
		});

		expect(mocks.loggerWarn).toHaveBeenCalledWith(
			"[stage-transition] reinjected dropped attachments",
			expect.objectContaining({
				droppedKeyCount: 0,
				droppedKeys: [],
			}),
		);
	});

	describe("each surface discriminant emits the same `[stage-transition]` prefix", () => {
		const cases: Array<{
			surface:
				| "stage-transition"
				| "update-with-context"
				| "reevaluate-bug"
				| "enhance-feature";
			targetStage: "PUBLISHED" | null;
		}> = [
			{ surface: "stage-transition", targetStage: "PUBLISHED" },
			{ surface: "update-with-context", targetStage: null },
			{ surface: "reevaluate-bug", targetStage: null },
			{ surface: "enhance-feature", targetStage: null },
		];

		for (const { surface, targetStage } of cases) {
			it(`surface = "${surface}" → message prefix unchanged, payload carries the discriminant`, () => {
				logReinjectedAttachments({
					storyId: "story-x",
					projectId: "project-x",
					surface,
					targetStage,
					draftingStage: "DRAFT",
					droppedKeys: ["story-media/project-x/story-x/k.png"],
				});

				expect(mocks.loggerWarn).toHaveBeenCalledWith(
					"[stage-transition] reinjected dropped attachments",
					expect.objectContaining({
						surface,
						targetStage,
						droppedKeyCount: 1,
						droppedKeys: ["story-media/project-x/story-x/k.png"],
					}),
				);
			});
		}
	});

	it("emits the §10.1 fields in the documented order (storyId → projectId → surface → targetStage → droppedKeyCount → droppedKeys → draftingStage)", () => {
		// Field order in object literals is irrelevant to vitest matchers,
		// but observability tools that index by line ergonomics benefit
		// from grep-stable ordering. Pin the order here so a future
		// refactor cannot silently shuffle the payload shape.
		logReinjectedAttachments({
			storyId: "story-4",
			projectId: "project-4",
			surface: "stage-transition",
			targetStage: "PASSIVE_ANALYSIS",
			draftingStage: "PLACEHOLDER",
			droppedKeys: ["story-media/project-4/story-4/k.png"],
		});

		const payload = mocks.loggerWarn.mock.calls[0]?.[1] as Record<
			string,
			unknown
		>;
		expect(Object.keys(payload)).toEqual([
			"storyId",
			"projectId",
			"surface",
			"targetStage",
			"droppedKeyCount",
			"droppedKeys",
			"draftingStage",
		]);
	});
});
