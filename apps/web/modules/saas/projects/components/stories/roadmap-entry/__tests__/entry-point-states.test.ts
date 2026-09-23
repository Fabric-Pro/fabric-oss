import { describe, expect, it } from "vitest";
import type { CapabilityGateView } from "../../../../lib/capability-gate-view";
import {
	deriveEntryPointStates,
	type EntryPointInputs,
	type RoadmapBlock,
} from "../entry-point-states";

const roadmap: RoadmapBlock = {
	canUpdateStories: true,
	canCreateStories: true,
	recommendationsEnabled: true,
	providerAvailable: true,
	activePmSync: null,
	aiRecommendedLifecycleEnabled: false,
};

const open = { view: null, blocked: false };

const blockedView = {
	capabilityKey: "roadmap.pull-from-pm",
	reasonKey: "roadmap.pm-not-connected",
} as CapabilityGateView;

function inputs(overrides: Partial<EntryPointInputs> = {}): EntryPointInputs {
	return {
		roadmap,
		canUpdateProject: true,
		starterAvailable: true,
		pm: { hasIntegration: true, canList: true },
		gatesEnabled: false,
		pullGate: open,
		recommendGate: open,
		doBothGate: open,
		syncGate: open,
		syncRunning: false,
		recommendRunning: false,
		...overrides,
	};
}

describe("deriveEntryPointStates", () => {
	it("offers all three, enabled, when everything is in place", () => {
		const s = deriveEntryPointStates(inputs());
		expect(s.pull).toEqual({
			visible: true,
			disabled: false,
			reason: null,
			warning: null,
		});
		expect(s.recommend).toEqual({
			visible: true,
			disabled: false,
			reason: null,
			warning: null,
		});
		expect(s.doBoth).toEqual({
			visible: true,
			disabled: false,
			reason: null,
			warning: null,
		});
	});

	it("FR4: Pull is always visible, even without a PM tool", () => {
		const s = deriveEntryPointStates(
			inputs({ pm: { hasIntegration: false, canList: false } }),
		);
		expect(s.pull.visible).toBe(true);
	});

	it("gating off: no PM connection disables Pull as not-connected", () => {
		const s = deriveEntryPointStates(
			inputs({ pm: { hasIntegration: false, canList: false } }),
		);
		expect(s.pull.reason).toEqual({ kind: "not-connected" });
	});

	it("gating on: the pull gate's verdict replaces the legacy connection check", () => {
		const s = deriveEntryPointStates(
			inputs({
				gatesEnabled: true,
				pm: { hasIntegration: false, canList: false },
				pullGate: { view: blockedView, blocked: true },
			}),
		);
		expect(s.pull.reason).toEqual({ kind: "gate", view: blockedView });
	});

	it("gating on with an open gate does not fall back to the legacy check", () => {
		const s = deriveEntryPointStates(
			inputs({
				gatesEnabled: true,
				pm: { hasIntegration: false, canList: false },
			}),
		);
		expect(s.pull.disabled).toBe(false);
	});

	it("FR46: a viewer without STORY_UPDATE sees Pull and Do both disabled for permission", () => {
		const s = deriveEntryPointStates(
			inputs({ roadmap: { ...roadmap, canUpdateStories: false } }),
		);
		expect(s.pull.reason).toEqual({ kind: "permission" });
		expect(s.doBoth.reason).toEqual({ kind: "permission" });
		expect(s.recommend.disabled).toBe(false);
	});

	it("FR46: a viewer without PROJECT_UPDATE sees Recommend and Do both disabled", () => {
		const s = deriveEntryPointStates(inputs({ canUpdateProject: false }));
		expect(s.recommend.reason).toEqual({ kind: "permission" });
		expect(s.doBoth.reason).toEqual({ kind: "permission" });
		expect(s.pull.disabled).toBe(false);
	});

	it("while projects.get loads, nothing is denied and nothing flag-gated shows", () => {
		const s = deriveEntryPointStates(
			inputs({ roadmap: undefined, canUpdateProject: undefined }),
		);
		expect(s.pull.disabled).toBe(false);
		expect(s.recommend.visible).toBe(false);
		expect(s.doBoth.visible).toBe(false);
	});

	it("while PM capabilities load, Pull is not reported as not-connected", () => {
		const s = deriveEntryPointStates(inputs({ pm: undefined }));
		expect(s.pull.disabled).toBe(false);
		expect(s.doBoth.visible).toBe(false);
	});

	it("flag off: Recommend and Do both are not rendered", () => {
		const s = deriveEntryPointStates(
			inputs({ roadmap: { ...roadmap, recommendationsEnabled: false } }),
		);
		expect(s.recommend.visible).toBe(false);
		expect(s.doBoth.visible).toBe(false);
	});

	it("no provider or no starter hides Recommend and Do both", () => {
		expect(
			deriveEntryPointStates(
				inputs({ roadmap: { ...roadmap, providerAvailable: false } }),
			).recommend.visible,
		).toBe(false);
		expect(
			deriveEntryPointStates(inputs({ starterAvailable: false })).doBoth
				.visible,
		).toBe(false);
	});

	it("FR5: Do both needs a PM tool that can list", () => {
		const s = deriveEntryPointStates(
			inputs({ pm: { hasIntegration: true, canList: false } }),
		);
		expect(s.recommend.visible).toBe(true);
		expect(s.doBoth.visible).toBe(false);
	});

	it("a running sync disables Pull and Do both but not Recommend", () => {
		const s = deriveEntryPointStates(inputs({ syncRunning: true }));
		expect(s.pull.reason).toEqual({ kind: "running" });
		expect(s.doBoth.reason).toEqual({ kind: "running" });
		expect(s.recommend.disabled).toBe(false);
	});

	it("3B's gates disable Recommend and Do both with their own verdicts", () => {
		const view = {
			capabilityKey: "roadmap.recommend-features",
		} as CapabilityGateView;
		const s = deriveEntryPointStates(
			inputs({
				gatesEnabled: true,
				recommendGate: { view, blocked: true },
				doBothGate: { view, blocked: true },
			}),
		);
		expect(s.recommend.reason).toEqual({ kind: "gate", view });
		expect(s.doBoth.reason).toEqual({ kind: "gate", view });
	});

	it("a warning gate (not blocked) disables nothing", () => {
		const view = { capabilityKey: "x" } as CapabilityGateView;
		const s = deriveEntryPointStates(
			inputs({
				gatesEnabled: true,
				recommendGate: { view, blocked: false },
			}),
		);
		expect(s.recommend.disabled).toBe(false);
	});

	it("FR56/FR59: a WARNING shows on Recommend and Do both without disabling them", () => {
		const recommendWarning = {
			capabilityKey: "roadmap.recommend-features",
			state: "WARNING",
		} as CapabilityGateView;
		const doBothWarning = {
			capabilityKey: "roadmap.do-both",
			state: "WARNING",
		} as CapabilityGateView;
		const s = deriveEntryPointStates(
			inputs({
				gatesEnabled: true,
				recommendGate: { view: recommendWarning, blocked: false },
				doBothGate: { view: doBothWarning, blocked: false },
			}),
		);
		expect(s.recommend).toMatchObject({
			disabled: false,
			warning: recommendWarning,
		});
		expect(s.doBoth).toMatchObject({
			disabled: false,
			warning: doBothWarning,
		});
		expect(s.pull.warning).toBeNull();
	});

	it("a blocked gate is a reason, never also a warning", () => {
		const view = {
			capabilityKey: "roadmap.recommend-features",
			state: "SOFT_BLOCK",
		} as CapabilityGateView;
		const s = deriveEntryPointStates(
			inputs({
				gatesEnabled: true,
				recommendGate: { view, blocked: true },
			}),
		);
		expect(s.recommend.warning).toBeNull();
	});

	it("a recommendation run in flight disables Recommend and Do both, not Pull", () => {
		const s = deriveEntryPointStates(inputs({ recommendRunning: true }));
		expect(s.recommend.reason).toEqual({ kind: "recommending" });
		expect(s.doBoth.reason).toEqual({ kind: "recommending" });
		expect(s.pull.disabled).toBe(false);
	});

	it("FR53/FR54: sync reads the sync-to-pm gate, permission and a running sync", () => {
		const view = {
			capabilityKey: "roadmap.sync-to-pm",
			state: "HARD_BLOCK",
		} as CapabilityGateView;
		expect(
			deriveEntryPointStates(
				inputs({
					gatesEnabled: true,
					syncGate: { view, blocked: true },
				}),
			).sync.reason,
		).toEqual({ kind: "gate", view });
		expect(
			deriveEntryPointStates(
				inputs({ roadmap: { ...roadmap, canUpdateStories: false } }),
			).sync.reason,
		).toEqual({ kind: "permission" });
		expect(
			deriveEntryPointStates(inputs({ syncRunning: true })).sync.reason,
		).toEqual({ kind: "running" });
	});

	it("gating off: sync keeps today's behaviour", () => {
		expect(deriveEntryPointStates(inputs()).sync.disabled).toBe(false);
	});
});
