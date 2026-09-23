/**
 * "Recommend Features from Context" in the Roadmap actions menu
 * (Fizzy #2204 FR10, FR46; #2208 FR55–FR59).
 */

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RoadmapRecommendationStarter } from "../../roadmap-entry/recommendation-starter";

const mocks = vi.hoisted(() => ({
	gate: vi.fn(),
	toastError: vi.fn(),
	trackEvent: vi.fn(),
}));

vi.mock("../../../capability-gates/useCapabilityGates", () => ({
	useCapabilityGate: (key: string) => mocks.gate(key),
	useCapabilityGates: () => ({
		linkFor: () => ({ href: "/app/example-org/projects/p1?tab=context" }),
	}),
}));
vi.mock("sonner", () => ({ toast: { error: mocks.toastError } }));
vi.mock("@analytics", () => ({
	useAnalytics: () => ({ trackEvent: mocks.trackEvent }),
}));

import { useRecommendActionItem } from "../useRecommendActionItem";
import { RecommendationStartError } from "../useRecommendationRun";

function starter(
	overrides: Partial<RoadmapRecommendationStarter> = {},
): RoadmapRecommendationStarter {
	return {
		start: vi.fn().mockResolvedValue(undefined),
		isStarting: false,
		isRunning: false,
		...overrides,
	};
}

function item(
	args: Parameters<typeof useRecommendActionItem>[0],
): ReturnType<typeof useRecommendActionItem> {
	return renderHook(() => useRecommendActionItem(args)).result.current;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.gate.mockReturnValue({
		gate: null,
		view: null,
		blocked: false,
		hidden: false,
	});
});

describe("useRecommendActionItem", () => {
	it("is absent without a starter (flag off or no AI provider)", () => {
		expect(item({ starter: null, canUpdateProject: true })).toBeNull();
	});

	it("is absent while permissions load", () => {
		expect(
			item({ starter: starter(), canUpdateProject: undefined }),
		).toBeNull();
	});

	it("FR46: a viewer sees it disabled with the permission reason, not hidden", () => {
		expect(
			item({ starter: starter(), canUpdateProject: false }),
		).toMatchObject({
			id: "recommend-features",
			disabledReason: "permission",
		});
	});

	it("FR10: carries the approved description under its label", () => {
		expect(
			item({ starter: starter(), canUpdateProject: true })?.description,
		).toBe("menuDescription");
	});

	it("starts a MATURE_ROADMAP run and tracks the menu placement when selected", () => {
		const s = starter();
		const result = item({ starter: s, canUpdateProject: true });
		expect(result).toMatchObject({
			id: "recommend-features",
			label: "menuItem",
			disabledReason: null,
		});
		result?.onSelect();
		expect(s.start).toHaveBeenCalledWith({ entryPoint: "MATURE_ROADMAP" });
		expect(mocks.gate).toHaveBeenCalledWith("roadmap.recommend-features");
		expect(mocks.trackEvent).toHaveBeenCalledWith(
			"roadmap_entry_point_selected",
			{ entryPoint: "recommend", placement: "menu" },
		);
	});

	it("FR37/FR57: a soft block gives the gate's title, its body and the remedy", () => {
		mocks.gate.mockReturnValue({
			gate: {},
			view: {
				state: "SOFT_BLOCK",
				title: "reason.roadmap.recommend.context-insufficient.title",
				body: "reason.roadmap.recommend.context-insufficient.body",
				params: { dependency: "project context" },
				ctaKind: "navigate",
				ctaTarget: "context",
				ctaLabel: "remedy.addContext",
			},
			blocked: true,
			hidden: false,
		});
		expect(
			item({ starter: starter(), canUpdateProject: true }),
		).toMatchObject({
			disabledReason:
				"reason.roadmap.recommend.context-insufficient.title",
			disabledDetail:
				"reason.roadmap.recommend.context-insufficient.body",
			remedy: {
				label: "remedy.addContext",
				href: "/app/example-org/projects/p1?tab=context",
			},
		});
	});

	it("FR56/FR59: a WARNING is shown and never disables the item", () => {
		mocks.gate.mockReturnValue({
			gate: {},
			view: {
				state: "WARNING",
				title: "reason.context.thin.title",
				body: "reason.context.thin.body",
				params: { dependency: "" },
			},
			blocked: false,
			hidden: false,
		});
		expect(
			item({ starter: starter(), canUpdateProject: true }),
		).toMatchObject({
			disabledReason: null,
			warning: "reason.context.thin.body",
		});
	});

	it.each([{ isRunning: true }, { isStarting: true }])(
		"is disabled while a run is in flight (%o)",
		(state) => {
			expect(
				item({ starter: starter(state), canUpdateProject: true })
					?.disabledReason,
			).toBe("running");
		},
	);

	it("toasts a gate refusal with its title and its body apart", async () => {
		const s = starter({
			start: vi
				.fn()
				.mockRejectedValue(
					new RecommendationStartError("Body.", "Title"),
				),
		});
		item({ starter: s, canUpdateProject: true })?.onSelect();
		await vi.waitFor(() =>
			expect(mocks.toastError).toHaveBeenCalledWith("Title", {
				description: "Body.",
			}),
		);
	});

	it("toasts the start failure with the starter's message", async () => {
		const s = starter({
			start: vi.fn().mockRejectedValue(new Error("Not ready yet.")),
		});
		item({ starter: s, canUpdateProject: true })?.onSelect();
		await vi.waitFor(() =>
			expect(mocks.toastError).toHaveBeenCalledWith("startFailed", {
				description: "Not ready yet.",
			}),
		);
	});
});
