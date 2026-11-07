import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	get: vi.fn(),
	find: vi.fn(),
	count: vi.fn(),
	update: vi.fn(),
	finish: vi.fn(),
	run: vi.fn(),
}));
vi.mock("@repo/agent-runtime/harness/triage", () => ({
	runSignalTriager: m.run,
	SignalTriageError: class extends Error {
		constructor(readonly code: string) {
			super("Signal triage could not complete.");
		}
	},
}));
vi.mock("@repo/database", () => ({
	db: {
		harnessTriageRun: { findFirst: m.find, updateMany: m.update },
		harnessTriageCall: { count: m.count },
	},
	countUncertainHarnessTriageCalls: m.count,
	getHarnessTriageFailureMetadata: async (
		scope,
		id,
		workflowId,
		nativeRunId,
	) => {
		m.find({
			where: {
				id,
				...scope,
				workflowId,
				OR: [{ nativeRunId: null }, { nativeRunId }],
			},
		});
		return m.find.mock.results.at(-1)?.value;
	},
	failHarnessTriageMetadata: async (
		scope,
		id,
		workflowId,
		status,
		failureCode,
	) =>
		m.update({
			where: {
				id,
				...scope,
				workflowId,
				status: { in: ["QUEUED", "RUNNING"] },
			},
			data: { status, failureCode },
		}),
	getHarnessTriageRun: m.get,
	finishHarnessTriageRun: m.finish,
	markHarnessTriageNativeRun: vi.fn(),
	reserveHarnessTriageCall: vi.fn(),
	dispatchHarnessTriageCall: vi.fn(),
	recordHarnessTriageResponse: vi.fn(),
	transitionHarnessTriageCall: vi.fn(),
	purgeExpiredHarnessTriageContent: vi.fn(),
}));
vi.mock("@repo/temporal/client", () => ({ getTemporalClient: vi.fn() }));
vi.mock("@repo/utils", () => ({
	decryptApiKey: () => "Example goal",
	encryptApiKey: (x: string) => `encrypted:${x}`,
}));
vi.mock("../harness-triage-commands", () => ({
	assertTriagePins: async () => [{ observationId: "example-observation" }],
	authorizeTriage: vi.fn(),
	checkTriageCredential: vi.fn(),
	triageLimits: () => ({ monthlyTokens: 100000, monthlyMicroUsd: 10000 }),
}));
vi.mock("../harness-triage-native", () => ({
	resolveTriageExecutionBinding: async () => ({
		routingDigest: "example-route",
	}),
	triageStoredModel: {
		parse: () => ({
			pin: { modelString: "example-model", maxOutputTokens: 128 },
			execution: { routingDigest: "example-route" },
		}),
	},
}));
vi.mock("../harness-triage-evidence", () => ({
	createPrivateTriageEvidenceReader: vi.fn(),
}));
vi.mock("../harness-triage-model", () => ({
	generateTriageModelOnce: vi.fn(),
	triageCharge: vi.fn(),
}));

import { SignalTriageError } from "@repo/agent-runtime/harness/triage";
import {
	executePrivateHarnessTriage,
	markPrivateTriageFailed,
} from "../harness-triage-host";

const scope = {
	organizationId: "example-org",
	projectId: "example-project",
	userId: "example-user",
};
const workflowInput = {
	...scope,
	runId: "example-run",
	expiresAt: "2030-01-01T00:00:00.000Z",
};
const row = {
	...scope,
	id: "example-run",
	workflowId: "example-workflow",
	nativeRunId: "example-native",
	status: "RUNNING",
	credential: { kind: "SESSION" },
	model: {},
	evidence: [],
	goalCiphertext: "encrypted:goal",
	cancelRequestedAt: null,
	inputHash: "a".repeat(64),
};
beforeEach(() => {
	vi.resetAllMocks();
	m.get.mockResolvedValue({ ...row });
	m.find.mockResolvedValue({ ...row });
	m.count.mockResolvedValue(0);
});

describe("trusted Harness host contracts", () => {
	it("strips workflow-only fields from current actor store scope", async () => {
		m.run.mockRejectedValue(new SignalTriageError("INVALID_INPUT"));
		await executePrivateHarnessTriage(
			workflowInput,
			row.id,
			row.workflowId,
			row.nativeRunId,
			new AbortController().signal,
		);
		expect(m.get).toHaveBeenCalledWith(scope, row.id);
		expect(m.finish).toHaveBeenLastCalledWith(
			scope,
			row.id,
			"FAILED",
			undefined,
			"INVALID_RESULT",
		);
	});
	it("uses only identity fields in terminal failure queries", async () => {
		await markPrivateTriageFailed(
			workflowInput,
			row.id,
			row.workflowId,
			row.nativeRunId,
		);
		expect(m.find).toHaveBeenCalledWith({
			where: {
				id: row.id,
				...scope,
				workflowId: row.workflowId,
				OR: [{ nativeRunId: null }, { nativeRunId: row.nativeRunId }],
			},
		});
		expect(m.update.mock.calls[0][0].where).not.toHaveProperty("runId");
		expect(m.update.mock.calls[0][0].where).not.toHaveProperty("expiresAt");
	});
	it("keeps cancellation metadata distinct from authorization failure", async () => {
		m.find.mockResolvedValue({ ...row, cancelRequestedAt: new Date() });
		await markPrivateTriageFailed(
			workflowInput,
			row.id,
			row.workflowId,
			row.nativeRunId,
		);
		expect(m.update.mock.calls[0][0].data).toEqual({
			status: "CANCELLED",
			failureCode: "CANCELLED",
		});
	});
	it("leaves safe transient failures to native activity retries", async () => {
		m.run.mockRejectedValue(new SignalTriageError("EVIDENCE_UNAVAILABLE"));
		await expect(
			executePrivateHarnessTriage(
				workflowInput,
				row.id,
				row.workflowId,
				row.nativeRunId,
				new AbortController().signal,
			),
		).rejects.toThrow("TRIAGE_RETRYABLE_UNAVAILABLE");
		expect(m.finish).toHaveBeenCalledTimes(1);
	});
	it("never retries a dispatched send with unknown outcome", async () => {
		m.count.mockResolvedValue(1);
		m.run.mockRejectedValue(new SignalTriageError("MODEL_UNAVAILABLE"));
		await expect(
			executePrivateHarnessTriage(
				workflowInput,
				row.id,
				row.workflowId,
				row.nativeRunId,
				new AbortController().signal,
			),
		).resolves.toEqual({ runId: row.id, status: "OUTCOME_UNKNOWN" });
		expect(m.finish).toHaveBeenLastCalledWith(
			scope,
			row.id,
			"OUTCOME_UNKNOWN",
			undefined,
			"OUTCOME_UNKNOWN",
		);
	});
});
