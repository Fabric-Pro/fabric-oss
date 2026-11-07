import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	instance: vi.fn(),
	runs: vi.fn(),
	execution: vi.fn(),
	artifacts: vi.fn(),
	read: vi.fn(),
	bindings: vi.fn(),
}));
vi.mock("../prisma/client", () => ({
	db: {
		templateInstance: { findFirst: m.instance },
		templateInstanceExecution: { findMany: m.runs, findFirst: m.execution },
		templateInstanceArtifact: { findMany: m.artifacts },
	},
}));
vi.mock("../prisma/queries/lib/report-access", () => ({
	createReportAccessChecker: async () => m.read,
	readReportProjectBindings: m.bindings,
}));

import {
	listNativeReportArtifacts,
	listNativeReportExecutions,
} from "../prisma/queries/report-native-history";

const actor = { userId: "example-reader", organizationId: "example-org" };
const when = new Date("2026-11-06T00:00:00.000Z");
const instance = {
	userId: "example-author",
	organizationId: actor.organizationId,
	fabricConfig: {},
};
let runs: Array<any>;
const filtered = (rows: any[], query: any) =>
	rows
		.filter(
			(row) =>
				(!query.where.status || row.status === query.where.status) &&
				(!query.where.OR ||
					query.where.OR.some((part: any) =>
						part.createdAt?.lt
							? row.createdAt < part.createdAt.lt
							: row.createdAt.getTime() ===
									part.createdAt.getTime() &&
								row.id < part.id.lt,
					)),
		)
		.sort(
			(a, b) =>
				b.createdAt.getTime() - a.createdAt.getTime() ||
				b.id.localeCompare(a.id),
		)
		.slice(0, query.take);
beforeEach(() => {
	vi.clearAllMocks();
	runs = Array.from({ length: 65 }, (_, i) => ({
		id: `example-run-${String(i).padStart(3, "0")}`,
		instanceId: "example-report",
		userId: "example-author",
		status: i % 2 ? "COMPLETED" : "FAILED",
		startedAt: when,
		completedAt: when,
		duration: 10,
		error: null,
		createdAt: when,
		parameters: {},
		artifacts: [],
	}));
	m.instance.mockResolvedValue(instance);
	m.read.mockResolvedValue(true);
	m.bindings.mockReturnValue(["example-project"]);
	m.runs.mockImplementation(async (query) => filtered(runs, query));
	m.execution.mockResolvedValue({
		status: "COMPLETED",
		parameters: {},
		instance,
	});
	m.artifacts.mockResolvedValue([]);
});
describe("native report keyset history", () => {
	it("pages beyond ten with stable timestamp ties and no duplicate after a newer run arrives", async () => {
		const first = await listNativeReportExecutions(actor, {
			instanceId: "example-report",
			limit: 10,
		});
		expect(first.executions).toHaveLength(10);
		expect(first.hasMore).toBe(true);
		runs.push({
			...runs[0],
			id: "example-new-run",
			createdAt: new Date("2026-11-06T00:01:00Z"),
		});
		const second = await listNativeReportExecutions(actor, {
			instanceId: "example-report",
			limit: 10,
			cursor: first.nextCursor!,
		});
		expect(second.executions).toHaveLength(10);
		expect(
			new Set(
				[...first.executions, ...second.executions].map(
					(row) => row.id,
				),
			).size,
		).toBe(20);
		expect(
			second.executions.some((row) => row.id === "example-new-run"),
		).toBe(false);
		expect(m.runs.mock.calls[0][0].where).toMatchObject({
			organizationId: "example-org",
			instanceId: "example-report",
		});
		expect(m.runs.mock.calls[0][0].where).not.toHaveProperty("userId");
	});
	it("exhausts every authorized run instead of imposing an organization-wide 5000-row ceiling", async () => {
		let cursor: string | undefined;
		const ids: string[] = [];
		do {
			const page = await listNativeReportExecutions(actor, {
				instanceId: "example-report",
				limit: 10,
				cursor,
			});
			ids.push(...page.executions.map((row) => row.id));
			cursor = page.nextCursor ?? undefined;
		} while (cursor);
		expect(ids).toHaveLength(65);
		expect(new Set(ids).size).toBe(65);
	});
	it("filters each run's admitted audience before pagination and refuses revoked current access", async () => {
		runs[64].parameters = { restricted: true };
		m.read.mockImplementation(
			async (_: unknown, parameters: any) => !parameters?.restricted,
		);
		const page = await listNativeReportExecutions(actor, {
			instanceId: "example-report",
			limit: 10,
		});
		expect(page.executions).toHaveLength(10);
		expect(page.executions[0]?.id).toBe("example-run-063");
		m.read.mockResolvedValue(false);
		await expect(
			listNativeReportExecutions(actor, { instanceId: "example-report" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
	it("pins cursor to report and status filter, rejects malformed positions and bounds page size", async () => {
		const page = await listNativeReportExecutions(actor, {
			instanceId: "example-report",
			limit: 10,
		});
		await expect(
			listNativeReportExecutions(actor, {
				instanceId: "example-other",
				cursor: page.nextCursor!,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			listNativeReportExecutions(actor, {
				instanceId: "example-report",
				cursor: page.nextCursor!,
				status: "FAILED",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			listNativeReportExecutions(actor, {
				instanceId: "example-report",
				cursor: "bad-json",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			listNativeReportExecutions(actor, {
				instanceId: "example-report",
				limit: 51,
			}),
		).rejects.toThrow();
	});
	it("returns empty authorized pages with continuation after a bounded hidden-row scan", async () => {
		runs = Array.from({ length: 600 }, (_, i) => ({
			...runs[0],
			id: `example-run-${String(i).padStart(4, "0")}`,
			parameters: { restricted: true },
		}));
		m.read.mockImplementation(
			async (_: unknown, parameters: any) => !parameters?.restricted,
		);
		const page = await listNativeReportExecutions(actor, {
			instanceId: "example-report",
		});
		expect(page.executions).toEqual([]);
		expect(page.hasMore).toBe(true);
		expect(page.nextCursor).toBeTruthy();
		expect(m.runs).toHaveBeenCalledTimes(10);
	});
	it("lists exact run artifact references and hides cancelled or unauthorized runs before loading files", async () => {
		m.execution.mockResolvedValue({
			status: "CANCELLED",
			parameters: {},
			instance,
		});
		expect(
			await listNativeReportArtifacts(actor, {
				executionId: "example-run",
			}),
		).toEqual({ artifacts: [], hasMore: false, nextCursor: null });
		expect(m.artifacts).not.toHaveBeenCalled();
		m.read.mockResolvedValue(false);
		await expect(
			listNativeReportArtifacts(actor, { executionId: "example-run" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.artifacts).not.toHaveBeenCalled();
	});
	it("pages artifacts independently without content bytes or raw storage credentials", async () => {
		const rows = Array.from({ length: 25 }, (_, i) => ({
			id: `example-artifact-${String(i).padStart(3, "0")}`,
			executionId: "example-run",
			name: `Example ${i}.pdf`,
			artifactType: "PDF",
			mimeType: "application/pdf",
			size: 100,
			createdAt: when,
			metadata: {
				sha256: "a".repeat(64),
				linkedFrameId: "example-frame",
			},
		}));
		m.artifacts.mockImplementation(async (query) => filtered(rows, query));
		const first = await listNativeReportArtifacts(actor, {
			executionId: "example-run",
			limit: 20,
		});
		const second = await listNativeReportArtifacts(actor, {
			executionId: "example-run",
			limit: 20,
			cursor: first.nextCursor!,
		});
		expect(first.artifacts).toHaveLength(20);
		expect(second.artifacts).toHaveLength(5);
		expect(second.hasMore).toBe(false);
		expect(first.artifacts[0]).not.toHaveProperty("content");
		expect(first.artifacts[0]).not.toHaveProperty("metadata");
	});
});

it("can page through more than five thousand native runs without dropping the entire history", async () => {
	runs = Array.from({ length: 5101 }, (_, i) => ({
		...runs[0],
		id: `example-run-${String(i).padStart(5, "0")}`,
	}));
	let cursor: string | undefined;
	let count = 0;
	do {
		const page = await listNativeReportExecutions(actor, {
			instanceId: "example-report",
			limit: 50,
			cursor,
		});
		count += page.executions.length;
		cursor = page.nextCursor ?? undefined;
	} while (cursor);
	expect(count).toBe(5101);
	expect(m.runs.mock.calls.every(([query]) => query.take === 51)).toBe(true);
});

it("never returns retained provider messages or internal host data through native history", async () => {
	runs[64].mcpDiagnostics = [
		{
			provider: "github",
			outcome: "error",
			toolCount: 2,
			readOnlyToolCount: 1,
			configId: "example-private",
			serverName: "https://private.example.com",
			errorMessage: "Bearer example-private-token",
		},
	];
	const page = await listNativeReportExecutions(actor, {
		instanceId: "example-report",
		limit: 1,
	});
	expect(page.executions[0]?.mcpDiagnostics).toEqual([
		{
			providerType: "github",
			displayLabel: "Source 1",
			status: "error",
			reasonCode: "CONNECTION_FAILED",
			toolCount: 2,
			readOnlyToolCount: 1,
		},
	]);
	expect(JSON.stringify(page)).not.toMatch(/private|Bearer|https/);
});

it("preserves shared report-source labels in native history without accessing private MCP metadata", async () => {
	m.instance.mockResolvedValue({
		...instance,
		connections: {
			mcpConfigs: ["example-issues-config", "example-docs-config"],
			mcpBindings: {
				issues: "example-issues-config",
				docs: "example-docs-config",
			},
		},
		template: {
			definition: {
				dataSources: [
					{ id: "issues", provider: "github" },
					{ id: "docs", provider: "notion" },
				],
			},
			connections: {
				mcpServers: [
					{ key: "github", name: "Delivery board" },
					{ key: "notion", name: "Team documentation" },
				],
			},
		},
	});
	runs[64].mcpDiagnostics = [
		{
			configId: "example-issues-config",
			serverName: "https://private.example.com",
			outcome: "auth_failed",
			toolCount: 0,
			readOnlyToolCount: 0,
		},
		{
			configId: "example-docs-config",
			serverName: "https://private.example.com",
			outcome: "unreachable",
			toolCount: 0,
			readOnlyToolCount: 0,
		},
	];
	const page = await listNativeReportExecutions(actor, {
		instanceId: "example-report",
		limit: 1,
	});
	expect(
		page.executions[0]?.mcpDiagnostics?.map((row) => row.displayLabel),
	).toEqual(["Delivery board", "Team documentation"]);
	expect(JSON.stringify(page)).not.toMatch(
		/private|https|configId|example-issues-config/,
	);
});
