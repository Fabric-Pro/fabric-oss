import { beforeEach, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
	weave: { status: "RUNNING" },
	coding: { status: "RUNNING" },
	plan: { status: "RUNNING" },
	updateWeave: vi.fn(),
	updateCoding: vi.fn(),
	find: vi.fn(),
	provider: vi.fn(),
	audit: vi.fn(),
	cleanup: undefined as any,
	findStale: undefined as any,
	mark: undefined as any,
}));
vi.mock("@repo/database", () => ({
	recordAudit: f.audit,
	db: {
		weaveExecution: {
			findMany: async () => [
				{
					id: "example-weave",
					sandboxSessionId: null,
					userId: "example-user",
					organizationId: "example-org",
					workflowId: "example-weave-workflow",
					startedAt: new Date(0),
				},
			],
			findUnique: f.find,
			updateMany: f.updateWeave,
		},
		codingRun: {
			findMany: async () => [
				{
					id: "example-coding",
					provider: "BACKGROUND_AGENTS",
					providerSessionId: null,
					providerMetadata: {
						executionRuntime: "fabric-agent-server",
					},
					userId: "example-user",
					organizationId: "example-org",
					workflowId: "example-coding-workflow",
					startedAt: new Date(0),
				},
			],
			updateMany: f.updateCoding,
		},
		weavePlan: {
			updateMany: async () => {
				f.plan.status = "APPROVED";
				return { count: 1 };
			},
		},
	},
}));
vi.mock("@temporalio/activity", () => ({
	log: { info: vi.fn(), warn: vi.fn() },
}));
vi.mock("../src/client", () => ({ getTemporalClient: vi.fn() }));
vi.mock("../src/lib/coding-execution/registry", () => ({
	getCodingExecutionProvider: f.provider,
}));
vi.mock("@temporalio/workflow", () => ({
	patched: () => true,
	log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
	proxyActivities: () => ({
		findStaleWeaveSessions: (input: any) => f.findStale(input),
		findStaleWeaveSessionsWithRuntime: (input: any) => f.findStale(input),
		cleanupWeaveResourcesActivity: (input: any) => f.cleanup(input),
		markWeaveExecutionStale: (input: any) => f.mark(input),
		cancelWeaveExecutionViaSignal: async () => true,
	}),
}));

import { cleanupWeaveResourcesActivity } from "../src/activities/weave/cleanup-resources";
import {
	findStaleWeaveSessions,
	markWeaveExecutionStale,
} from "../src/activities/weave/watchdog-activities";
import { weaveExecutionWatchdogWorkflow } from "../src/workflows/weave-execution-watchdog";

beforeEach(() => {
	vi.clearAllMocks();
	f.weave.status = "RUNNING";
	f.coding.status = "RUNNING";
	f.plan.status = "RUNNING";
	f.cleanup = cleanupWeaveResourcesActivity;
	f.findStale = findStaleWeaveSessions;
	f.mark = markWeaveExecutionStale;
	f.updateWeave.mockImplementation(async ({ data }) => {
		Object.assign(f.weave, data);
		return { count: 1 };
	});
	f.updateCoding.mockImplementation(async ({ data }) => {
		Object.assign(f.coding, data);
		return { count: 1 };
	});
	f.find.mockImplementation(async () => ({
		status: f.weave.status,
		planId: "example-plan",
	}));
});
it("bridge-on watchdog closes both no-session kinds through actual find, cleanup and stale-mark activities", async () => {
	vi.stubEnv("FABRIC_AGENTS_EXECUTION_BRIDGE_ENABLED", "true");
	try {
		const stale = await findStaleWeaveSessions({
			staleAfterMinutes: 1,
			batchSize: 10,
		});
		expect(stale.rows).toHaveLength(2);
		for (const row of stale.rows) {
			expect(row.requiresConfirmedCleanup).not.toBe(true);
		}
		expect(await weaveExecutionWatchdogWorkflow()).toEqual({
			killedWeave: 1,
			killedCodingRun: 1,
			scanned: 2,
		});
		expect(f.weave.status).toBe("TERMINATED_STALE");
		expect(f.coding.status).toBe("TERMINATED_STALE");
		expect(f.plan.status).toBe("APPROVED");
		expect(f.provider).not.toHaveBeenCalled();
	} finally {
		vi.unstubAllEnvs();
	}
});
it("reconciles legacy rows with sessions from recorded metadata even with bridge on", async () => {
	vi.stubEnv("FABRIC_AGENTS_EXECUTION_BRIDGE_ENABLED", "true");
	f.provider.mockReturnValue({
		cancelSession: async () => {
			throw new Error("Not found: 404");
		},
	});
	try {
		const result = await cleanupWeaveResourcesActivity({
			sessionId: "example-session",
			provider: "BACKGROUND_AGENTS",
			providerMetadata: { executionRuntime: "legacy-background-agents" },
			weaveExecutionId: "example-weave",
			userId: "example-user",
			organizationId: "example-org",
			exitReason: "failure",
			workflowId: "example-workflow",
			runDurationMs: 1,
		});
		expect(result.destroyed).toBe(true);
		expect(f.weave.status).toBe("FAILED");
		expect(f.plan.status).toBe("APPROVED");
	} finally {
		vi.unstubAllEnvs();
	}
});

it("still closes legacy Weave sessions when cleanup cannot reach the server", async () => {
	f.provider.mockReturnValue({
		cancelSession: async () => {
			throw new Error("HTTP 503");
		},
	});
	f.findStale = async () => ({
		rows: [
			{
				kind: "weave",
				id: "example-weave",
				sessionId: "example-legacy-session",
				provider: "BACKGROUND_AGENTS",
				userId: "example-user",
				organizationId: "example-org",
				workflowId: "example-workflow",
				startedAtMs: 0,
			},
		],
	});
	expect(await weaveExecutionWatchdogWorkflow()).toMatchObject({
		killedWeave: 1,
	});
	expect(f.weave.status).toBe("TERMINATED_STALE");
});
