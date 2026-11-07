import { beforeEach, expect, it, vi } from "vitest";
import { scopeSatisfied } from "../tool-scope";
import type { GatewaySession } from "../types";

const command = vi.hoisted(() => vi.fn());
vi.mock("@repo/api/modules/reports/lib/report-commands", () => ({
	runReportCommand: command,
}));

import { createReportTools } from "../tools/report-tools";

const family = createReportTools();
const session = {
	sessionId: "example-session",
	userId: "example-user",
	organizationId: "example-org",
	credential: "organization-key",
	scopes: ["reports:read", "reports:write"],
	role: "user",
	userName: "Example User",
	email: "dev@example.com",
	createdAt: new Date("2026-01-01"),
	expiresAt: new Date("2026-01-02"),
} as GatewaySession;
beforeEach(() => {
	vi.clearAllMocks();
	command.mockResolvedValue({ id: "example-report" });
});
it("registers all twelve canonical operations with exact-consent metadata", () => {
	expect(family.definitions).toHaveLength(12);
	expect(family.handlers.size).toBe(12);
	for (const tool of family.definitions) {
		expect(family.scopes[tool.name].exact).toBe(true);
		expect(
			scopeSatisfied(
				["mcp:read", "mcp:write"],
				family.scopes[tool.name],
				"organization-key",
			),
		).toBe(false);
	}
});
it("resolves actor and report configuration without executing or distributing by accident", async () => {
	await family.handlers.get("fabric_create_report")?.(
		{
			settings: {
				templateId: "example-template",
				name: "Delivery",
				connections: {},
			},
		},
		session,
	);
	expect(command).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: session.userId,
			organizationId: session.organizationId,
			scopes: session.scopes,
		}),
		"create",
		{ templateId: "example-template", name: "Delivery", connections: {} },
	);
});
it("preserves explicit distribution revision/hash and recipient identity", async () => {
	const args = {
		artifactId: "example-artifact",
		recipientUserIds: ["example-recipient"],
		requestId: "7279e1aa-5913-44bf-a9ce-e57358f977dd",
		expectedArtifactHash: "a".repeat(64),
	};
	await family.handlers.get("fabric_distribute_report_artifact")?.(
		args,
		session,
	);
	expect(command).toHaveBeenCalledWith(expect.anything(), "distribute", args);
});
it.each([
	{ projectId: "example-project" },
	{ pinnedProjectId: "example-project" },
	{ pageProjectId: "example-project" },
	{ credential: "service" },
	{ organizationId: null },
])(
	"refuses an unsupported connection before reaching the command",
	async (patch) => {
		const result = await family.handlers.get("fabric_get_report")?.(
			{ reportId: "example-report" },
			{ ...session, ...patch } as GatewaySession,
		);
		expect(result.isError).toBe(true);
		expect(command).not.toHaveBeenCalled();
	},
);

it("preserves native history cursor, filtering and target identities", async () => {
	await family.handlers.get("fabric_list_report_executions")?.(
		{
			reportId: "example-report",
			cursor: "opaque",
			limit: 10,
			status: "COMPLETED",
		},
		session,
	);
	expect(command).toHaveBeenLastCalledWith(expect.anything(), "executions", {
		instanceId: "example-report",
		cursor: "opaque",
		limit: 10,
		status: "COMPLETED",
	});
	await family.handlers.get("fabric_list_report_artifacts")?.(
		{
			executionId: "example-execution",
			cursor: "opaque",
			limit: 10,
			artifactType: "PDF",
		},
		session,
	);
	expect(command).toHaveBeenLastCalledWith(expect.anything(), "artifacts", {
		executionId: "example-execution",
		cursor: "opaque",
		limit: 10,
		artifactType: "PDF",
	});
});
