/**
 * The capability gate on starting a security / accessibility scan (Fizzy #1930).
 *
 * The assert lives in this shared helper rather than in `trigger-scan.ts`
 * because the maturation gate starts scans through the same function, as do the
 * public API and MCP tools. Two placement facts are pinned below and both are
 * load-bearing:
 *
 *   - it runs AFTER the nothing-to-scan guard, so "no scanner enabled" still
 *     answers `null` instead of becoming a refusal;
 *   - it runs BEFORE the scan row is created, so a refused scan leaves no row
 *     and no history entry behind.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		isFeatureEnabled: vi.fn(),
		gatherCapabilityEvidence: vi.fn(),
		createProjectScan: vi.fn(),
		updateProjectScan: vi.fn(),
		recordScanActivity: vi.fn(),
		getProjectScanConfig: vi.fn(),
		getProjectReposForCodeSearch: vi.fn(),
		hasActiveScan: vi.fn(),
		workflowStart: vi.fn(),
	},
}));

vi.mock("@repo/database", () => ({
	isFeatureEnabled: mocks.isFeatureEnabled,
	createProjectScan: mocks.createProjectScan,
	updateProjectScan: mocks.updateProjectScan,
	recordScanActivity: mocks.recordScanActivity,
	getProjectScanConfig: mocks.getProjectScanConfig,
	getProjectReposForCodeSearch: mocks.getProjectReposForCodeSearch,
	hasActiveScan: mocks.hasActiveScan,
}));

vi.mock("../../../../../capabilities/evidence", () => ({
	gatherCapabilityEvidence: mocks.gatherCapabilityEvidence,
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({
		workflow: { start: mocks.workflowStart },
	}),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: <T>(args: T) => args,
}));

import {
	evidenceWith,
	healthyEvidence,
} from "../../../../../capabilities/__tests__/evidence-fixture";
import { maybeTriggerMaturationScan, startProjectScan } from "../start-scan";

function start(overrides: Record<string, unknown> = {}) {
	return startProjectScan({
		projectId: "project_example",
		targetType: "PROJECT",
		trigger: "MANUAL",
		userId: "user_example",
		organizationId: null,
		securityEnabled: true,
		accessibilityEnabled: false,
		...overrides,
	});
}

async function errorFrom(promise: Promise<unknown>) {
	try {
		await promise;
	} catch (err) {
		return err as { code?: string; message?: string };
	}
	throw new Error("expected startProjectScan to throw");
}

/** A scan that is genuinely running right now, on a fresh progress clock. */
function runningScanEvidence() {
	return evidenceWith({
		scan: {
			running: true,
			lastProgressAt: new Date(),
			lastRunFailed: false,
		},
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.isFeatureEnabled.mockResolvedValue(true);
	mocks.gatherCapabilityEvidence.mockResolvedValue(healthyEvidence());
	mocks.getProjectScanConfig.mockResolvedValue({ scanBranch: null });
	mocks.getProjectReposForCodeSearch.mockResolvedValue([{ branch: "main" }]);
	mocks.createProjectScan.mockResolvedValue({ id: "scan_example" });
	mocks.recordScanActivity.mockResolvedValue(undefined);
	mocks.updateProjectScan.mockResolvedValue(undefined);
	mocks.workflowStart.mockResolvedValue({
		workflowId: "security-scan-scan_example",
	});
});

describe("startProjectScan — the capability door", () => {
	it("refuses with PRECONDITION_FAILED naming the scan already running", async () => {
		mocks.gatherCapabilityEvidence.mockResolvedValue(runningScanEvidence());

		const err = await errorFrom(start());

		expect(err.code).toBe("PRECONDITION_FAILED");
		expect(err.message).toContain("the running scan");
	});

	it("refuses before a scan row or history entry exists", async () => {
		mocks.gatherCapabilityEvidence.mockResolvedValue(runningScanEvidence());

		await errorFrom(start());

		expect(mocks.createProjectScan).not.toHaveBeenCalled();
		expect(mocks.recordScanActivity).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("refuses a disconnected repository once a repo-reading engine is on", async () => {
		mocks.gatherCapabilityEvidence.mockResolvedValue(
			evidenceWith({
				scan: { requiresCodebase: true },
				codebase: { connected: false },
			}),
		);

		const err = await errorFrom(start());

		expect(err.code).toBe("PRECONDITION_FAILED");
		expect(err.message).toContain("a connected repository");
	});

	it("lets a document-only scan run with no repository at all", async () => {
		// The other half of the same conditional. The two engines that run by
		// default read documents and features, never code — refusing them for a
		// missing repository would take spec review away from spec-only projects.
		mocks.gatherCapabilityEvidence.mockResolvedValue(
			evidenceWith({
				scan: { requiresCodebase: false },
				codebase: { connected: false },
			}),
		);

		await expect(start()).resolves.not.toBeNull();
		expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
	});

	it("proceeds and dispatches when nothing is blocking", async () => {
		await expect(start()).resolves.toEqual({
			scanId: "scan_example",
			workflowId: "security-scan-scan_example",
		});
		expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
	});

	it("still answers null for a project with no scanner enabled, ungated", async () => {
		// Placement proof: the guard runs first, so this contract is unchanged
		// and no evidence is gathered for a call that was never going to scan.
		mocks.gatherCapabilityEvidence.mockResolvedValue(runningScanEvidence());

		await expect(
			start({ securityEnabled: false, accessibilityEnabled: false }),
		).resolves.toBeNull();
		expect(mocks.gatherCapabilityEvidence).not.toHaveBeenCalled();
	});

	it("is inert with the flag off — no evidence read, no refusal", async () => {
		mocks.isFeatureEnabled.mockResolvedValue(false);
		mocks.gatherCapabilityEvidence.mockResolvedValue(runningScanEvidence());

		await expect(start()).resolves.not.toBeNull();
		expect(mocks.gatherCapabilityEvidence).not.toHaveBeenCalled();
	});

	it("resolves the gate against the tenant the caller already resolved", async () => {
		await start({ organizationId: "organization_example" });

		expect(mocks.gatherCapabilityEvidence).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "project_example",
				userId: "user_example",
				organizationId: "organization_example",
			}),
		);
	});
});

describe("maybeTriggerMaturationScan — a refused auto-trigger", () => {
	beforeEach(() => {
		mocks.getProjectScanConfig.mockResolvedValue({
			scanBranch: null,
			autoScanOnMaturation: true,
			securityEnabled: true,
			accessibilityEnabled: false,
			maturationGate: "READY",
		});
		mocks.hasActiveScan.mockResolvedValue(false);
	});

	it("swallows the refusal rather than failing the stage transition", async () => {
		// Documented, not accidental. This auto-trigger is best-effort and its
		// pre-existing catch guards the stage transition that called it — a
		// feature must not fail to move because a scan could not start. The
		// refusal still reaches the user on the manual path, which is where
		// they asked for a scan.
		mocks.gatherCapabilityEvidence.mockResolvedValue(runningScanEvidence());

		await expect(
			maybeTriggerMaturationScan({
				projectId: "project_example",
				storyId: "story_example",
				previousStage: "DRAFT",
				newStage: "READY",
				userId: "user_example",
				organizationId: null,
			}),
		).resolves.toBeUndefined();

		expect(mocks.createProjectScan).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("still starts the scan when nothing is blocking", async () => {
		await maybeTriggerMaturationScan({
			projectId: "project_example",
			storyId: "story_example",
			previousStage: "DRAFT",
			newStage: "READY",
			userId: "user_example",
			organizationId: null,
		});

		expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
	});
});
