/**
 * Which Roadmap entry points show, and why any of them is disabled
 * (Fizzy #2204, FR3–FR5, FR11–FR17, FR35, FR46).
 *
 * One pure function so the empty-state cards and the toolbar's Pull button
 * reach the same verdict. Flag, provider and permission come from
 * `project.roadmap` rather than the capability engine, so they hold whether
 * `CAPABILITY_GATING` is on or off; the engine adds the PM and grounding
 * verdicts on top when it is on.
 */

import type { orpcClient } from "@shared/lib/orpc-client";
import type { CapabilityGateView } from "../../../lib/capability-gate-view";

type ProjectGetOutput = Awaited<ReturnType<typeof orpcClient.projects.get>>;

/** `project.roadmap` from `projects.get`. */
export type RoadmapBlock = ProjectGetOutput["project"]["roadmap"];

/** The slice of `useCapabilityGate` this resolver reads. */
interface GateVerdict {
	view: CapabilityGateView | null;
	blocked: boolean;
}

export type EntryPointReason =
	| { kind: "permission" }
	| { kind: "not-connected" }
	/** A PM sync is running. */
	| { kind: "running" }
	/** A recommendation run is in flight. */
	| { kind: "recommending" }
	| { kind: "gate"; view: CapabilityGateView };

interface EntryPointState {
	visible: boolean;
	disabled: boolean;
	reason: EntryPointReason | null;
	/**
	 * A WARNING verdict (FR56/FR59): shown beside the action, never blocking
	 * it. Null when the gate is quiet, blocked, or the warning was dismissed.
	 */
	warning: CapabilityGateView | null;
}

export interface EntryPointStates {
	pull: EntryPointState;
	recommend: EntryPointState;
	doBoth: EntryPointState;
	/** Sync selected / Sync to {tool}: pushing items to the PM tool. */
	sync: EntryPointState;
}

export interface EntryPointInputs {
	/** Undefined while `projects.get` loads: nothing is denied on an unknown. */
	roadmap: RoadmapBlock | undefined;
	/** `project.canUpdateProject` (PROJECT_UPDATE): generating recommendations. */
	canUpdateProject: boolean | undefined;
	starterAvailable: boolean;
	/** Undefined while PM capabilities load: never "not connected" on an unknown. */
	pm: { hasIntegration: boolean; canList: boolean } | undefined;
	gatesEnabled: boolean;
	pullGate: GateVerdict;
	recommendGate: GateVerdict;
	doBothGate: GateVerdict;
	/** `roadmap.sync-to-pm`: pushing to the PM tool. */
	syncGate: GateVerdict;
	/** A PM sync this page knows about is running. */
	syncRunning: boolean;
	/** A recommendation run is starting or in flight. */
	recommendRunning: boolean;
}

function gateReason(gate: GateVerdict): EntryPointReason | null {
	return gate.blocked && gate.view ? { kind: "gate", view: gate.view } : null;
}

function gateWarning(gate: GateVerdict): CapabilityGateView | null {
	return !gate.blocked && gate.view?.state === "WARNING" ? gate.view : null;
}

function state(
	visible: boolean,
	reason: EntryPointReason | null,
	warning: CapabilityGateView | null = null,
): EntryPointState {
	return { visible, disabled: reason !== null, reason, warning };
}

export function deriveEntryPointStates(
	input: EntryPointInputs,
): EntryPointStates {
	const { roadmap, pm, gatesEnabled } = input;
	const pmReady = pm?.hasIntegration === true && pm.canList;
	const lacksStoryUpdate = roadmap !== undefined && !roadmap.canUpdateStories;
	const lacksProjectUpdate = input.canUpdateProject === false;

	// With gating off, the engine says nothing about the connection, so the
	// page falls back to what it has always read.
	const pullBlock = gatesEnabled
		? gateReason(input.pullGate)
		: pm === undefined || pmReady
			? null
			: ({ kind: "not-connected" } as const);

	const pullReason: EntryPointReason | null = lacksStoryUpdate
		? { kind: "permission" }
		: (pullBlock ?? (input.syncRunning ? { kind: "running" } : null));

	const recommendVisible =
		roadmap?.recommendationsEnabled === true &&
		roadmap.providerAvailable &&
		input.starterAvailable;

	const recommending: EntryPointReason | null = input.recommendRunning
		? { kind: "recommending" }
		: null;

	const recommendReason: EntryPointReason | null = lacksProjectUpdate
		? { kind: "permission" }
		: (gateReason(input.recommendGate) ?? recommending);

	const doBothReason: EntryPointReason | null =
		lacksStoryUpdate || lacksProjectUpdate
			? { kind: "permission" }
			: (gateReason(input.doBothGate) ??
				(input.syncRunning ? { kind: "running" } : recommending));

	// Push has no legacy connection fallback: with gating off its buttons
	// only render with a PM tool, exactly as before.
	const syncReason: EntryPointReason | null = lacksStoryUpdate
		? { kind: "permission" }
		: (gateReason(input.syncGate) ??
			(input.syncRunning ? { kind: "running" } : null));

	return {
		pull: state(true, pullReason),
		recommend: state(
			recommendVisible,
			recommendReason,
			gateWarning(input.recommendGate),
		),
		doBoth: state(
			recommendVisible && pmReady,
			doBothReason,
			gateWarning(input.doBothGate),
		),
		sync: state(true, syncReason),
	};
}
