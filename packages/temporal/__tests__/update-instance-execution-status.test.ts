/**
 * Unit tests for updateInstanceExecutionStatus activity
 *
 * Asserts that status/error/mcpDiagnostics are forwarded to the DB layer, that
 * the write goes through the guarded `finalizeTemplateInstanceExecutionStatus`
 * (the "CANCELLED wins once set" guard — the activity must not clobber a row a
 * user already cancelled), and that the activity returns whether the write
 * landed / only bumps lastRunAt when it did.
 *
 * The workflow itself (templateInstanceExecutionWorkflow) is covered by
 * `src/workflows/__tests__/template-instance-execution.test.ts`. These unit
 * tests cover the activity boundary — the atomic unit that performs the write.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the DB module before importing the activity.
// setAiUsageRecorder + provider constants are required by @repo/payments
// which is pulled in transitively at module load time.
vi.mock("@repo/database", () => ({
	// Guarded status write the activity now routes through (CANCELLED wins).
	finalizeTemplateInstanceExecutionStatus: vi.fn().mockResolvedValue(true),
	updateTemplateInstanceLastRunAt: vi.fn().mockResolvedValue({}),
	// Imported by template-instance/index.ts to register the report-notification
	// activity; stubbed so the module loads under this mock.
	emitReportExecutionNotification: vi.fn().mockResolvedValue(undefined),
	// Imported transitively by template-instance/index.ts for the report EMAIL
	// activity; stubbed so the module loads under this mock.
	claimReportExecutionEmail: vi.fn().mockResolvedValue(null),
	// Registry hook called by @repo/payments at module init.
	setAiUsageRecorder: vi.fn(),
	// Provider constants needed by @repo/ai gateway-config.ts at import time.
	GATEWAY_PROVIDERS: [
		"VERCEL_GATEWAY",
		"OPENROUTER",
		"CLOUDFLARE_AI",
	] as const,
	DIRECT_PROVIDERS: ["OPENAI_DIRECT", "ANTHROPIC_DIRECT", "GROQ"] as const,
	AI_PROVIDER_METADATA: {},
	isGatewayProvider: () => false,
	isDirectProvider: () => false,
	getProviderDisplayName: (p: string) => p,
	getProviderMetadata: () => undefined,
}));

import {
	finalizeTemplateInstanceExecutionStatus,
	updateTemplateInstanceLastRunAt,
} from "@repo/database";
import { updateInstanceExecutionStatus } from "../src/activities/template-instance/index";

const mockFinalize = vi.mocked(finalizeTemplateInstanceExecutionStatus);
const mockLastRunAt = vi.mocked(updateTemplateInstanceLastRunAt);

beforeEach(() => {
	vi.clearAllMocks();
	mockFinalize.mockResolvedValue(true);
	mockLastRunAt.mockResolvedValue({} as any);
});

const sampleDiagnostics = [
	{
		configId: "cfg-1",
		serverName: "GitHub",
		provider: "github",
		outcome: "auth_failed",
		toolCount: 0,
		readOnlyToolCount: 0,
		errorMessage: "401 Unauthorized",
	},
];

describe("updateInstanceExecutionStatus — guarded write forwarding", () => {
	it("forwards mcpDiagnostics/status through the guarded write on the COMPLETED path", async () => {
		await updateInstanceExecutionStatus({
			executionId: "exec-1",
			status: "COMPLETED",
			completedAt: new Date("2026-01-01T00:00:00Z"),
			duration: 5000,
			mcpDiagnostics: sampleDiagnostics,
		});

		expect(mockFinalize).toHaveBeenCalledOnce();
		const [id, data] = mockFinalize.mock.calls[0];
		expect(id).toBe("exec-1");
		expect(data.mcpDiagnostics).toEqual(sampleDiagnostics);
		expect(data.status).toBe("COMPLETED");
	});

	it("forwards mcpDiagnostics/error through the guarded write on the FAILED path", async () => {
		await updateInstanceExecutionStatus({
			executionId: "exec-2",
			status: "FAILED",
			completedAt: new Date("2026-01-01T00:00:00Z"),
			duration: 1000,
			error: "All 1 report data sources are unavailable: GitHub — authentication expired",
			mcpDiagnostics: sampleDiagnostics,
		});

		expect(mockFinalize).toHaveBeenCalledOnce();
		const [, data] = mockFinalize.mock.calls[0];
		expect(data.mcpDiagnostics).toEqual(sampleDiagnostics);
		expect(data.status).toBe("FAILED");
		expect(data.error).toContain("authentication expired");
	});

	it("passes undefined mcpDiagnostics when not provided (backward compat)", async () => {
		await updateInstanceExecutionStatus({
			executionId: "exec-3",
			status: "RUNNING",
			startedAt: new Date("2026-01-01T00:00:00Z"),
		});

		expect(mockFinalize).toHaveBeenCalledOnce();
		const [, data] = mockFinalize.mock.calls[0];
		expect(data.mcpDiagnostics).toBeUndefined();
	});
});

describe("updateInstanceExecutionStatus — guard result drives lastRunAt + return", () => {
	it("on a landed RUNNING write: returns true and bumps lastRunAt", async () => {
		mockFinalize.mockResolvedValue(true);

		const written = await updateInstanceExecutionStatus({
			executionId: "exec-4",
			instanceId: "inst-4",
			status: "RUNNING",
			startedAt: new Date("2026-01-01T00:00:00Z"),
		});

		expect(written).toBe(true);
		expect(mockLastRunAt).toHaveBeenCalledTimes(1);
	});

	it("on a guard-blocked RUNNING write (already CANCELLED): returns false and does NOT bump lastRunAt", async () => {
		mockFinalize.mockResolvedValue(false);

		const written = await updateInstanceExecutionStatus({
			executionId: "exec-5",
			instanceId: "inst-5",
			status: "RUNNING",
			startedAt: new Date("2026-01-01T00:00:00Z"),
		});

		expect(written).toBe(false);
		expect(mockLastRunAt).not.toHaveBeenCalled();
	});
});
