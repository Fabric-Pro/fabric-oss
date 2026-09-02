/**
 * The QA sign-off gate on marking a feature done.
 *
 * The gate is on the TRANSITION into DONE, not on the value being DONE, and that
 * distinction is the whole test. Gating the value looks equivalent and passes any
 * test that only ever moves a feature forward — but it freezes every feature that
 * is ALREADY done the moment somebody raises the project's threshold, because a
 * client echoing the current status alongside an unrelated edit is then refused.
 *
 * So the load-bearing case here is the boring one: DONE → DONE with the threshold
 * unsatisfied must SUCCEED. Without it, simplifying the condition back to
 * `input.maturationStatus === "DONE"` reintroduces that bug with no CI signal.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	priorFindFirst,
	updateStoryFn,
	signOffStatus,
	qaSettings,
	storyCoverage,
} = vi.hoisted(() => ({
	priorFindFirst: vi.fn(),
	updateStoryFn: vi.fn(),
	signOffStatus: vi.fn(),
	qaSettings: vi.fn(),
	storyCoverage: vi.fn(),
}));

vi.mock("@repo/database", async () => {
	const { z } = await import("zod");
	// Real schemas so `.optional()` in the procedure's input builder works.
	return {
		db: { userStory: { findFirst: priorFindFirst, findUnique: vi.fn() } },
		updateStory: updateStoryFn,
		getQaSignOffStatus: signOffStatus,
		getProjectQaSettings: qaSettings,
		getStoryCoverage: storyCoverage,
		setLastContextUpdateAt: vi.fn(),
		FeatureDraftingStageSchema: z.string(),
		MaturationStatusSchema: z.string(),
	};
});

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../../../../lib/notification-service", () => ({
	fanOut: {
		subscriptionUpdate: vi.fn().mockResolvedValue(undefined),
		assigned: vi.fn().mockResolvedValue(undefined),
	},
}));

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: vi.fn(),
}));

// `update-story` now runs the Ready-for-Dev auto-draft trigger, whose module
// graph reaches the Temporal client. Mocked at the trigger so this suite
// stays about its own subject and never loads a workflow client.
vi.mock("../../../lib/auto-draft-test-cases", () => ({
	maybeAutoDraftOnStageChange: vi.fn(),
}));
vi.mock("../../../lib/enqueue-pm-sync", () => ({
	enqueuePmSync: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../lib/strip-internal-story-fields", () => ({
	stripInternalStoryFields: (story: unknown) => story,
}));

vi.mock("../../../lib/validate-stage-for-kind", () => ({
	validateStageForKind: vi.fn(),
}));

vi.mock("../../scan/lib/start-scan", () => ({
	maybeTriggerMaturationScan: vi.fn(),
}));

vi.mock("../../../../../orpc/procedures", () => {
	const makeChain = () => {
		const chain: Record<string, unknown> = {
			use: () => chain,
			route: () => chain,
			input: () => chain,
			output: () => chain,
			handler: (h: unknown) => h,
		};
		return chain;
	};
	return {
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => () => undefined,
		resolveOrganizationId: (orgId: string | null | undefined) =>
			orgId ?? null,
		get tenantProtectedProcedure() {
			return makeChain();
		},
	};
});

import { updateStoryProcedure } from "../update-story";

const ctx = {
	context: { user: { id: "u1", name: "Alice" }, session: {} },
} as const;

function run(input: Record<string, unknown>) {
	return (
		updateStoryProcedure as unknown as (a: {
			context: unknown;
			input: unknown;
		}) => Promise<unknown>
	)({
		...ctx,
		input: { projectId: "p1", storyId: "story-1", ...input },
	});
}

/** Two sign-offs required, one recorded — the gate should bite on a transition. */
const unsatisfied = { recorded: 1, required: 2, satisfied: false };

beforeEach(() => {
	vi.clearAllMocks();
	updateStoryFn.mockResolvedValue({
		id: "story-1",
		title: "Checkout retry",
		version: 3,
		pmAutoSyncEnabled: false,
		externalId: null,
	});
	signOffStatus.mockResolvedValue(unsatisfied);
	// Coverage gate off by default here, so the sign-off tests above stay about
	// sign-offs. A target of 0 short-circuits before coverage is even computed.
	// The reporting target stays at 80 on purpose: the Done gate must not read it.
	qaSettings.mockResolvedValue({ coverageTarget: 80, testCoverageTarget: 0 });
	storyCoverage.mockResolvedValue({
		totalCriteria: 0,
		coveredCriteria: 0,
		percent: 100,
	});
});

describe("update-story QA sign-off gate", () => {
	it("refuses the transition into DONE when the threshold is unmet", async () => {
		priorFindFirst.mockResolvedValue({
			assigneeId: null,
			title: "Checkout retry",
			version: 3,
			maturationStatus: "DISCOVERY",
		});

		await expect(run({ maturationStatus: "DONE" })).rejects.toThrow(
			/requires 2 QA sign-offs before a feature can be marked done. 1 recorded/,
		);
		expect(updateStoryFn).not.toHaveBeenCalled();
	});

	it("allows an edit to a feature that is ALREADY done, threshold unmet", async () => {
		// The regression this file exists for: raising the threshold must not make
		// already-shipped features uneditable.
		priorFindFirst.mockResolvedValue({
			assigneeId: null,
			title: "Checkout retry",
			version: 3,
			maturationStatus: "DONE",
		});

		await run({ maturationStatus: "DONE", title: "Checkout retry v2" });

		expect(updateStoryFn).toHaveBeenCalled();
		// The threshold is not even consulted — there is no transition to gate.
		expect(signOffStatus).not.toHaveBeenCalled();
	});

	it("allows the transition once the threshold is satisfied", async () => {
		priorFindFirst.mockResolvedValue({
			assigneeId: null,
			title: "Checkout retry",
			version: 3,
			maturationStatus: "DISCOVERY",
		});
		signOffStatus.mockResolvedValue({
			recorded: 2,
			required: 2,
			satisfied: true,
		});

		await run({ maturationStatus: "DONE" });

		expect(updateStoryFn).toHaveBeenCalled();
	});

	it("leaves every other status change ungated", async () => {
		priorFindFirst.mockResolvedValue({
			assigneeId: null,
			title: "Checkout retry",
			version: 3,
			maturationStatus: "DONE",
		});

		// Moving OUT of done is not a claim that the work is finished, so it must
		// not be blocked by a threshold the feature has not met.
		await run({ maturationStatus: "DISCOVERY" });

		expect(updateStoryFn).toHaveBeenCalled();
		expect(signOffStatus).not.toHaveBeenCalled();
	});

	it("does not consult the threshold on an edit that omits maturationStatus", async () => {
		priorFindFirst.mockResolvedValue({
			assigneeId: null,
			title: "Checkout retry",
			version: 3,
			maturationStatus: "DISCOVERY",
		});

		await run({ title: "Checkout retry v2" });

		expect(signOffStatus).not.toHaveBeenCalled();
	});
});

/**
 * The test-coverage-target gate on marking a feature done.
 *
 * The gate reads its own setting (`testCoverageTarget`) and never the reporting
 * target (`coverageTarget`) the automation rings measure against. One number
 * used to drive both, which armed a blocking transition from a field the
 * settings screen described as an automation-reporting target — the defect this
 * split exists to remove, so the split itself is pinned here from both sides.
 *
 * It refuses the move to Done below target — but takes a reason rather than
 * being immovable, because a low-risk feature may legitimately ship under it
 * and a second wall as absolute as the sign-off gate would strand work for a
 * far less clear-cut reason.
 *
 * The two failure modes worth pinning, and neither is "does it block":
 *
 *  - an override that is not recorded. A silent escape hatch is the same as no
 *    gate, since nobody can later see that a team shipped under target twelve
 *    times;
 *  - an override recorded when the target was MET. That would manufacture a
 *    record of a decision nobody made, from a client that always sends the
 *    field.
 */
describe("update-story test-coverage-target gate", () => {
	const satisfied = { recorded: 2, required: 2, satisfied: true };

	function transitioningToDone() {
		priorFindFirst.mockResolvedValue({
			assigneeId: null,
			title: "Checkout retry",
			version: 3,
			maturationStatus: "DISCOVERY",
		});
	}

	beforeEach(() => {
		// Sign-offs satisfied throughout: this block is about coverage, and a
		// sign-off refusal would mask it. The reporting target is 0 here so any
		// gating observed below can only come from the dedicated field.
		signOffStatus.mockResolvedValue(satisfied);
		transitioningToDone();
		qaSettings.mockResolvedValue({
			coverageTarget: 0,
			testCoverageTarget: 80,
		});
	});

	it("ignores the reporting coverageTarget — rings on, gate off means Done", async () => {
		// The regression this block exists for: a project that only ever set the
		// automation-reporting target must not have its features blocked.
		qaSettings.mockResolvedValue({
			coverageTarget: 80,
			testCoverageTarget: 0,
		});

		await run({ maturationStatus: "DONE" });

		expect(storyCoverage).not.toHaveBeenCalled();
		expect(updateStoryFn).toHaveBeenCalled();
	});

	it("refuses Done below the target, naming the numbers", async () => {
		storyCoverage.mockResolvedValue({
			totalCriteria: 5,
			coveredCriteria: 2,
			percent: 40,
		});

		await expect(run({ maturationStatus: "DONE" })).rejects.toThrow(
			/covers 40% of its acceptance criteria \(2 of 5\).*asks for 80%/s,
		);
		expect(updateStoryFn).not.toHaveBeenCalled();
	});

	it("allows Done with a reason, and records who decided and why", async () => {
		storyCoverage.mockResolvedValue({
			totalCriteria: 5,
			coveredCriteria: 2,
			percent: 40,
		});

		await run({
			maturationStatus: "DONE",
			coverageOverrideReason:
				"Config-only change, covered by the smoke run.",
		});

		const [, , data] = updateStoryFn.mock.calls[0];
		expect(data).toMatchObject({
			coverageOverrideReason:
				"Config-only change, covered by the smoke run.",
			coverageOverrideById: "u1",
		});
		expect(data.coverageOverrideAt).toBeInstanceOf(Date);
	});

	it("records NO override when the target was met", async () => {
		// A client that always sends the field must not be able to manufacture a
		// record of a decision nobody had to make.
		storyCoverage.mockResolvedValue({
			totalCriteria: 5,
			coveredCriteria: 5,
			percent: 100,
		});

		await run({
			maturationStatus: "DONE",
			coverageOverrideReason: "sent regardless",
		});

		const [, , data] = updateStoryFn.mock.calls[0];
		expect(data.coverageOverrideReason).toBeUndefined();
		expect(data.coverageOverrideById).toBeUndefined();
	});

	it("is silent for a project whose gate target is 0", async () => {
		// The default for every project — saved or not — after the split.
		// Coverage is not even computed.
		qaSettings.mockResolvedValue({
			coverageTarget: 80,
			testCoverageTarget: 0,
		});

		await run({ maturationStatus: "DONE" });

		expect(storyCoverage).not.toHaveBeenCalled();
		expect(updateStoryFn).toHaveBeenCalled();
	});

	it("lets a feature with no acceptance criteria through", async () => {
		// A spike or chore legitimately states none. Reporting 0% would block it
		// behind a target it can never reach.
		storyCoverage.mockResolvedValue({
			totalCriteria: 0,
			coveredCriteria: 0,
			percent: 100,
		});

		await run({ maturationStatus: "DONE" });

		expect(updateStoryFn).toHaveBeenCalled();
	});

	it("leaves an already-done feature editable below target", async () => {
		// Same rule as the sign-off gate: this is on the TRANSITION. Otherwise
		// raising the target freezes every shipped feature.
		priorFindFirst.mockResolvedValue({
			assigneeId: null,
			title: "Checkout retry",
			version: 3,
			maturationStatus: "DONE",
		});
		storyCoverage.mockResolvedValue({
			totalCriteria: 5,
			coveredCriteria: 1,
			percent: 20,
		});

		await run({ maturationStatus: "DONE", title: "Renamed" });

		expect(updateStoryFn).toHaveBeenCalled();
	});

	it("refuses before the sign-off gate has been satisfied", async () => {
		// Ordering: sign-offs are the older and stricter gate, so a project
		// failing both should hear about sign-offs rather than coverage.
		signOffStatus.mockResolvedValue(unsatisfied);
		storyCoverage.mockResolvedValue({
			totalCriteria: 5,
			coveredCriteria: 0,
			percent: 0,
		});

		await expect(run({ maturationStatus: "DONE" })).rejects.toThrow(
			/QA sign-offs/,
		);
	});
});
