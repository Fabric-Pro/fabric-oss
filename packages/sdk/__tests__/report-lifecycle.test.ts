import { describe, expect, it, vi } from "vitest";
import { reportConnectionDiagnosticsSchema } from "../../database/prisma/queries/lib/report-public-diagnostics";
import type { FabricHttpClient } from "../src/client";
import type { ReportConnectionDiagnostic } from "../src/resources/reports";
import { ReportsResource } from "../src/resources/reports";

describe("report lifecycle SDK", () => {
	it("uses exact encoded resources and disables automatic mutation retries", async () => {
		const http = { get: vi.fn(), post: vi.fn(), patch: vi.fn() };
		const reports = new ReportsResource(
			http as unknown as FabricHttpClient,
		);
		await reports.getInstance("example/a", { org: "example-org" });
		expect(http.get).toHaveBeenCalledWith(
			"/reports/instances/example%2Fa?org=example-org",
		);
		const update = {
			expectedVersion: 4,
			expectedUpdatedAt: "2026-11-06T00:00:00.000Z",
			scheduleUpdate: { mode: "off" as const },
		};
		await reports.configureInstance("example-report", update);
		expect(http.patch).toHaveBeenCalledWith(
			"/reports/instances/example-report",
			update,
			{ retry: { maxRetries: 0 } },
		);
		const request = {
			idempotencyKey: "00000000-0000-4000-8000-000000000001",
		};
		await reports.executeInstance("example-report", request);
		expect(http.post).toHaveBeenCalledWith(
			"/reports/instances/example-report/executions",
			request,
			{ retry: { maxRetries: 0 } },
		);
		await reports.cancelExecution("example-run");
		expect(http.post).toHaveBeenCalledWith(
			"/reports/executions/example-run/cancel",
			{},
			{ retry: { maxRetries: 0 } },
		);
		await reports.downloadArtifact("example-artifact");
		expect(http.get).toHaveBeenCalledWith(
			"/reports/artifacts/example-artifact/download",
		);
		const distribution = {
			requestId: request.idempotencyKey,
			expectedArtifactHash: "a".repeat(64),
			recipientUserIds: ["example-member"],
		};
		await reports.distributeArtifact("example-artifact", distribution);
		expect(http.post).toHaveBeenCalledWith(
			"/reports/artifacts/example-artifact/distribute",
			distribution,
			{ retry: { maxRetries: 0 } },
		);
	});
});

it("pages native report executions and artifacts without reusing the legacy execution model", async () => {
	const http = { get: vi.fn() };
	const reports = new ReportsResource(http as unknown as FabricHttpClient);
	await reports.listInstanceExecutions("example/report", {
		org: "example-org",
		cursor: "example-cursor",
		limit: 10,
		status: "FAILED",
	});
	expect(http.get).toHaveBeenCalledWith(
		"/reports/instances/example%2Freport/executions?org=example-org&cursor=example-cursor&limit=10&status=FAILED",
	);
	await reports.listArtifacts("example/run", {
		cursor: "example-next",
		artifactType: "PDF",
	});
	expect(http.get).toHaveBeenCalledWith(
		"/reports/executions/example%2Frun/artifacts?cursor=example-next&artifactType=PDF",
	);
});

it("preserves existing legacy SDK listExecutions() and offset URL contract", async () => {
	const http = { get: vi.fn() };
	const reports = new ReportsResource(http as unknown as FabricHttpClient);
	await reports.listExecutions();
	expect(http.get).toHaveBeenCalledWith("/reports/executions");
	await reports.listExecutions({ org: "example-org", limit: 20, offset: 40 });
	expect(http.get).toHaveBeenCalledWith(
		"/reports/executions?org=example-org&limit=20&offset=40",
	);
});

it("documents the same safe diagnostics contract in the standalone public SDK", () => {
	const diagnostic: ReportConnectionDiagnostic = {
		providerType: "github",
		displayLabel: "Source 1",
		status: "auth_failed",
		reasonCode: "AUTH_REQUIRED",
		toolCount: 0,
		readOnlyToolCount: 0,
	};
	expect(reportConnectionDiagnosticsSchema.parse([diagnostic])).toEqual([
		diagnostic,
	]);
	expect(Object.keys(diagnostic).sort()).toEqual([
		"displayLabel",
		"providerType",
		"readOnlyToolCount",
		"reasonCode",
		"status",
		"toolCount",
	]);
});
