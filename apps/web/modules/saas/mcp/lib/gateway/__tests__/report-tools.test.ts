/**
 * Which report runs may use the starting member's own ChatGPT plan: one a
 * person started (a browser session, or Fabric Agent in their chat, which asks
 * them on every call), never one a key or OAuth token started.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	generate: vi.fn(),
}));

vi.mock("@repo/api/modules/reports/lib/report-agent-commands", () => ({
	generateReportForAgent: m.generate,
	listProjectReportsForAgent: vi.fn(),
}));
vi.mock("@repo/api/modules/reports/lib/report-generation", () => ({
	ReportGenerationError: class ReportGenerationError extends Error {},
}));
vi.mock("../project-binding", () => ({
	sessionMayReachProject: async () => true,
}));

import { createReportTools } from "../tools/report-tools";
import type { GatewayCredential, GatewaySession } from "../types";

function session(credential: GatewayCredential): GatewaySession {
	return {
		sessionId: "session-1",
		userId: "user-1",
		organizationId: "org-example-alpha",
		projectId: null,
		userName: "Dev",
		email: "dev@example.com",
		role: "user",
		credential,
		scopes: ["workflows:run"],
		createdAt: new Date("2026-10-04T12:00:00Z"),
		expiresAt: new Date("2026-10-05T12:00:00Z"),
	};
}

const tools = createReportTools(async () => ({
	organizationId: "org-example-alpha",
}));

async function generate(credential: GatewayCredential) {
	const handler = tools.handlers.get("fabric_generate_report");
	if (!handler) {
		throw new Error("tool not registered");
	}
	return handler({ instanceId: "report-1" }, session(credential));
}

beforeEach(() => {
	vi.clearAllMocks();
	m.generate.mockResolvedValue({
		executionId: "execution-1",
		workflowId: "workflow-1",
		status: "PENDING",
		startConfirmed: true,
		message: "started",
	});
});

describe("fabric_generate_report", () => {
	it.each([
		["session", true],
		["service", true],
		["organization-key", false],
		["personal-key", false],
		["oauth", false],
	] as const)(
		"starts a %s caller's run with planEligible %s",
		async (credential, planEligible) => {
			await generate(credential);

			expect(m.generate).toHaveBeenCalledWith(
				{
					userId: "user-1",
					organizationId: "org-example-alpha",
					planEligible,
				},
				{ instanceId: "report-1" },
				expect.any(Function),
			);
		},
	);

	it("tells the caller how to follow the run it started", async () => {
		const result = await generate("session");
		const text = result.content.map((part) => part.text).join("");

		expect(text).toContain("Poll fabric_list_project_reports");
	});
});
