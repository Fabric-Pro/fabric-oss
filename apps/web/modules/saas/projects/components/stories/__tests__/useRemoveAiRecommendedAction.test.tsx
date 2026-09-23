import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RoadmapBlock } from "../roadmap-entry/entry-point-states";

const gate = vi.hoisted(() => ({ hidden: false }));

vi.mock("../../capability-gates/useCapabilityGates", () => ({
	useCapabilityGate: (key: string) => {
		if (key !== "roadmap.remove-ai-recommended") {
			throw new Error(`unexpected gate ${key}`);
		}
		return { gate: null, view: null, blocked: false, hidden: gate.hidden };
	},
}));
vi.mock("../RemoveAiBatchDialog", () => ({
	RemoveAiBatchDialog: () => null,
}));

import { useRemoveAiRecommendedAction } from "../useRemoveAiRecommendedAction";

function roadmap(overrides: Partial<RoadmapBlock> = {}): RoadmapBlock {
	return {
		canUpdateStories: true,
		canCreateStories: true,
		recommendationsEnabled: false,
		providerAvailable: false,
		activePmSync: null,
		aiRecommendedLifecycleEnabled: true,
		...overrides,
	} as RoadmapBlock;
}

function run(block: RoadmapBlock | undefined) {
	return renderHook(() =>
		useRemoveAiRecommendedAction({
			projectId: "project-1",
			roadmap: block,
		}),
	).result.current;
}

describe("useRemoveAiRecommendedAction", () => {
	beforeEach(() => {
		gate.hidden = false;
	});

	it("offers Remove AI Recommended Items when the flag is on, the person can edit and the gate is not hidden", () => {
		const { item, overlay } = run(roadmap());
		expect(item).toMatchObject({
			id: "remove-ai-recommended",
			// The global next-intl mock echoes the key.
			label: "menuItem",
			disabledReason: null,
		});
		expect(overlay).toBeNull();
	});

	it("mounts the dialog once the item is selected", () => {
		const { result } = renderHook(() =>
			useRemoveAiRecommendedAction({
				projectId: "project-1",
				roadmap: roadmap(),
			}),
		);
		act(() => result.current.item?.onSelect());
		expect(result.current.overlay).not.toBeNull();
	});

	it("offers nothing with the lifecycle flag off", () => {
		expect(
			run(roadmap({ aiRecommendedLifecycleEnabled: false })).item,
		).toBeNull();
	});

	it("offers nothing to someone who cannot update stories", () => {
		expect(run(roadmap({ canUpdateStories: false })).item).toBeNull();
	});

	it("offers nothing while the project is loading", () => {
		expect(run(undefined).item).toBeNull();
	});

	it("offers nothing when the engine hides it: no batch has an eligible item", () => {
		gate.hidden = true;
		expect(run(roadmap()).item).toBeNull();
	});
});
