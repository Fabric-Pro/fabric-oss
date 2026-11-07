import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	member: vi.fn(),
	privateMcpMetadata: vi.fn(),
	instance: vi.fn(),
	artifact: vi.fn(),
	execution: vi.fn(),
	bindings: vi.fn(),
	create: vi.fn(),
	update: vi.fn(),
	execute: vi.fn(),
	get: vi.fn(),
	list: vi.fn(),
	cancel: vi.fn(),
	download: vi.fn(),
	distribute: vi.fn(),
}));
vi.mock("@repo/database/prisma/client", () => ({
	db: { mCPConfig: { findMany: mocks.privateMcpMetadata } },
}));

vi.mock("@repo/database", () => ({
	db: { user: { findUnique: vi.fn() } },
	getOrganizationMembership: mocks.member,
	getTemplateInstance: mocks.instance,
	getTemplateInstanceArtifact: mocks.artifact,
	getTemplateInstanceExecution: mocks.execution,
	readReportProjectBindings: mocks.bindings,
}));
vi.mock("@repo/database/prisma/queries/report-distribution", async () => {
	const { z } = await import("zod");
	return {
		distributeReportArtifact: mocks.distribute,
		reportDistributionSchema: z.object({
			artifactId: z.string(),
			requestId: z.string(),
			expectedArtifactHash: z.string(),
			recipientUserIds: z.array(z.string()),
		}),
		reportArtifactHash: () => "a".repeat(64),
		ReportDistributionError: class extends Error {},
	};
});
vi.mock("../../procedures/instances/create", async () => {
	const { z } = await import("zod");
	return {
		createInstanceInputSchema: z.object({
			name: z.string(),
			reporting: z.object({ projectId: z.string() }).optional(),
		}),
		handleCreateReportInstance: mocks.create,
	};
});
vi.mock("../../procedures/instances/update", async () => {
	const { z } = await import("zod");
	return {
		updateInstanceInputSchema: z.object({
			id: z.string(),
			name: z.string().optional(),
		}),
		handleUpdateReportInstance: mocks.update,
	};
});
vi.mock("../../procedures/instances/execute", async () => {
	const { z } = await import("zod");
	return {
		executeInstanceInputSchema: z.object({
			instanceId: z.string(),
			idempotencyKey: z.string().uuid(),
		}),
		handleExecuteReportInstance: mocks.execute,
	};
});
vi.mock("../../procedures/instances/get", async () => {
	const { z } = await import("zod");
	return {
		getInstanceInputSchema: z.object({ id: z.string() }),
		handleGetReportInstance: mocks.get,
	};
});
vi.mock("../../procedures/instances/list", async () => {
	const { z } = await import("zod");
	return {
		listInstancesInputSchema: z.object({
			projectId: z.string().optional(),
		}),
		handleListReportInstances: mocks.list,
	};
});
vi.mock("../../procedures/instances/cancel-execution", async () => {
	const { z } = await import("zod");
	return {
		cancelExecutionInputSchema: z.object({ executionId: z.string() }),
		handleCancelReportExecution: mocks.cancel,
	};
});
vi.mock("../../procedures/artifacts/download", async () => {
	const { z } = await import("zod");
	return {
		downloadInputSchema: z.object({ id: z.string() }),
		handleDownloadReportArtifact: mocks.download,
	};
});
vi.mock("../../procedures/artifacts/send-email", async () => {
	const { z } = await import("zod");
	return {
		sendEmailInputSchema: z.object({ artifactId: z.string() }),
		handleSendReportArtifact: vi.fn(),
	};
});
vi.mock("../../procedures/artifacts/list-deliveries", async () => {
	const { z } = await import("zod");
	return {
		listDeliveriesInputSchema: z.object({ artifactId: z.string() }),
		handleListReportDeliveries: vi.fn(),
	};
});

import { runReportCommand } from "../report-commands";

const actor = {
	userId: "example-actor",
	organizationId: "example-org",
	scopes: ["reports:read", "reports:write"],
};
beforeEach(() => {
	vi.clearAllMocks();
	mocks.member.mockResolvedValue({ role: "owner" });
	mocks.instance.mockResolvedValue({
		id: "example-report",
		fabricConfig: {},
	});
	mocks.bindings.mockReturnValue(["example-project"]);
	mocks.artifact.mockResolvedValue({
		execution: {
			status: "COMPLETED",
			instance: { fabricConfig: {} },
			parameters: {},
		},
	});
	mocks.execution.mockResolvedValue({
		id: "example-run",
		instanceId: "example-report",
		status: "COMPLETED",
		duration: 50,
		error: null,
		artifacts: [],
		instance: { fabricConfig: {} },
		parameters: {},
	});
});
describe("canonical report transport authorization", () => {
	it("distinguishes missing scope from a creator whose current role was revoked, including wildcard keys", async () => {
		await expect(
			runReportCommand(
				{ ...actor, scopes: ["reports:read"] },
				"execute",
				{},
			),
		).rejects.toMatchObject({ data: { reason: "SCOPE_REQUIRED" } });
		expect(mocks.member).not.toHaveBeenCalled();
		mocks.member.mockResolvedValue(null);
		await expect(
			runReportCommand({ ...actor, scopes: ["*"] }, "get", {
				id: "example-report",
			}),
		).rejects.toMatchObject({ data: { reason: "PERMISSION_REQUIRED" } });
		expect(mocks.get).not.toHaveBeenCalled();
	});
	it("rejects forged actors and cross-tenant input", async () => {
		await expect(
			runReportCommand(actor, "get", {
				id: "example-report",
				userId: "example-other",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			runReportCommand(actor, "get", {
				id: "example-report",
				organizationId: "example-other-org",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
	it("enforces pinned project for reads, lists and creation", async () => {
		const bound = { ...actor, boundProjectId: "example-project" };
		mocks.bindings.mockReturnValue(["example-other-project"]);
		await expect(
			runReportCommand(bound, "get", { id: "example-report" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			runReportCommand(bound, "list", {
				projectId: "example-other-project",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			runReportCommand(bound, "create", {
				name: "Weekly",
				reporting: { projectId: "example-other-project" },
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
	it("requires current configuration revision and reuses the Portal handler", async () => {
		await expect(
			runReportCommand(actor, "update", {
				id: "example-report",
				name: "Changed",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await runReportCommand(actor, "update", {
			id: "example-report",
			name: "Changed",
			expectedVersion: 3,
			expectedUpdatedAt: "2026-11-06T00:00:00Z",
		});
		expect(mocks.update).toHaveBeenCalledWith({
			input: expect.objectContaining({
				expectedVersion: 3,
				expectedUpdatedAt: new Date("2026-11-06T00:00:00Z"),
			}),
			context: {
				user: { id: actor.userId },
				session: { activeOrganizationId: actor.organizationId },
			},
		});
	});
	it("returns exact-run status without raw failure text and hides cancelled outputs", async () => {
		mocks.execution.mockResolvedValue({
			id: "example-run",
			instanceId: "example-report",
			status: "CANCELLED",
			duration: null,
			error: "secret provider detail",
			artifacts: [{ id: "example-artifact" }],
			instance: { fabricConfig: {} },
			parameters: {},
		});
		expect(
			await runReportCommand(actor, "status", {
				executionId: "example-run",
			}),
		).toMatchObject({
			artifacts: [],
			error: "The report did not finish. Review its run details before trying again.",
		});
	});
	it("refuses cancelled artifact download before signing a URL", async () => {
		mocks.artifact.mockResolvedValue({
			execution: { status: "CANCELLED" },
		});
		await expect(
			runReportCommand(actor, "download", { id: "example-artifact" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.download).not.toHaveBeenCalled();
	});
});

it("refuses legacy offsets instead of ignoring them on canonical native history commands", async () => {
	await expect(
		runReportCommand(actor, "executions", {
			instanceId: "example-report",
			offset: 20,
		}),
	).rejects.toMatchObject({ code: "BAD_REQUEST" });
	await expect(
		runReportCommand(actor, "artifacts", {
			executionId: "example-run",
			offset: 20,
		}),
	).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

it("checks every supplied execution binding before dispatch for a pinned credential", async () => {
	const parameters = { projectId: "example-other-project" };
	mocks.bindings.mockImplementation((_: unknown, supplied: unknown) =>
		supplied === parameters
			? ["example-project", "example-other-project"]
			: ["example-project"],
	);
	await expect(
		runReportCommand(
			{ ...actor, boundProjectId: "example-project" },
			"execute",
			{
				instanceId: "example-report",
				idempotencyKey: "00000000-0000-4000-8000-000000000001",
				parameters,
			},
		),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
	expect(mocks.bindings).toHaveBeenCalledWith(expect.anything(), parameters);
	expect(mocks.execute).not.toHaveBeenCalled();
});

it("maps malformed bound audience parameters to a safe schema error after checking authority", async () => {
	mocks.bindings.mockImplementation(() => {
		throw new Error(
			"foreign schema parser details https://private.example.com",
		);
	});
	await expect(
		runReportCommand(
			{ ...actor, boundProjectId: "example-project" },
			"execute",
			{
				instanceId: "example-report",
				parameters: { __fabricReportExecution: "malformed" },
			},
		),
	).rejects.toMatchObject({
		code: "BAD_REQUEST",
		message:
			"Report audience or execution parameters are invalid. Review the report settings before trying again.",
	});
	expect(mocks.execute).not.toHaveBeenCalled();
	mocks.member.mockResolvedValue(null);
	await expect(
		runReportCommand(
			{ ...actor, boundProjectId: "example-project" },
			"execute",
			{ instanceId: "example-report", parameters: {} },
		),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
});

it("does not expose a creator's private MCP names through a reports-read-only key", async () => {
	mocks.privateMcpMetadata.mockResolvedValue([
		{
			id: "example-own-config",
			displayName: "Private delivery system",
			mcpServer: { name: "Private server", key: "github" },
		},
	]);
	mocks.execution.mockResolvedValue({
		id: "example-run",
		instanceId: "example-report",
		status: "FAILED",
		duration: 1,
		error: null,
		mcpDiagnostics: [
			{
				configId: "example-own-config",
				serverName: "Private server",
				outcome: "auth_failed",
				toolCount: 0,
				readOnlyToolCount: 0,
			},
		],
		artifacts: [],
		instance: {
			fabricConfig: {},
			connections: { mcpConfigs: ["example-own-config"] },
		},
		parameters: {},
	});
	const result = await runReportCommand(
		{ ...actor, scopes: ["reports:read"] },
		"status",
		{ executionId: "example-run" },
	);
	expect(result).toMatchObject({
		mcpDiagnostics: [
			{
				displayLabel: "Source 1",
				providerType: "other",
				status: "auth_failed",
			},
		],
	});
	expect(JSON.stringify(result)).not.toContain("Private");
	expect(mocks.privateMcpMetadata).not.toHaveBeenCalled();
});
