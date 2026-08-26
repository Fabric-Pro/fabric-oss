/**
 * Unit tests for SecurityFindingsHandler — the Fabric Agent's reader for the
 * project Security tab (the fabric_list_security_findings tool).
 *
 * Covers:
 *   - Happy path: completed scan + findings → formatted, severity-ordered list.
 *   - Access control (AC3): no project access → denial, no DB reads of findings.
 *   - No project attached → helpful message, no DB calls.
 *   - No completed scan → "no completed scans" message.
 *   - Filters (category/severity/status) are passed through to listScanFindings.
 *
 * Boundaries mocked: @repo/database (hasProjectAccess, getLatestProjectScan,
 * listScanFindings), which the handler pulls via dynamic import.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecuteStepInput } from "../../../types";
import { SecurityFindingsHandler } from "../security-findings-handler";
import type { HandlerContext } from "../types";

const mocks = vi.hoisted(() => ({
	hasProjectAccess: vi.fn(),
	getLatestProjectScan: vi.fn(),
	listScanFindings: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	hasProjectAccess: (...a: unknown[]) => mocks.hasProjectAccess(...a),
	getLatestProjectScan: (...a: unknown[]) => mocks.getLatestProjectScan(...a),
	listScanFindings: (...a: unknown[]) => mocks.listScanFindings(...a),
}));

function makeContext(
	stepInputs: Record<string, unknown> = {},
	overrides: Partial<ExecuteStepInput> = {},
): HandlerContext {
	const input = {
		step: {
			id: "step-1",
			description: "list security findings",
			type: "tool",
			status: "in_progress",
			order: 1,
			app: "fabric_list_security_findings",
			inputs: stepInputs,
		},
		message: "what security findings are there?",
		systemPrompt: "",
		variables: {},
		userId: "user-1",
		organizationId: "org-1",
		executionMode: "balanced",
		totalSteps: 1,
		stepIndex: 1,
		previousStepResults: [],
		projectId: "proj-1",
		...overrides,
	} as unknown as ExecuteStepInput;
	return { input, variables: {}, toolCalls: [], startTime: Date.now() };
}

const handler = new SecurityFindingsHandler();

beforeEach(() => {
	mocks.hasProjectAccess.mockReset();
	mocks.getLatestProjectScan.mockReset();
	mocks.listScanFindings.mockReset();
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.getLatestProjectScan.mockResolvedValue({
		id: "scan-1",
		completedAt: new Date("2026-06-17T00:00:00Z"),
		securityFindingCount: 40,
		accessibilityFindingCount: 20,
	});
	mocks.listScanFindings.mockResolvedValue([]);
});

describe("SecurityFindingsHandler.canHandle", () => {
	it("matches the fabric_list_security_findings tool by app or executor", () => {
		expect(handler.canHandle(makeContext().input)).toBe(true);
		expect(
			handler.canHandle(
				makeContext(
					{},
					{
						step: {
							app: undefined,
							executor: "fabric_list_security_findings",
						} as never,
					},
				).input,
			),
		).toBe(true);
	});

	it("ignores unrelated tools", () => {
		expect(
			handler.canHandle(
				makeContext({}, { step: { app: "project_rag_query" } as never })
					.input,
			),
		).toBe(false);
	});
});

describe("SecurityFindingsHandler.execute", () => {
	it("returns a formatted, ticket-ready list of findings (happy path)", async () => {
		mocks.listScanFindings.mockResolvedValue([
			{
				severity: "CRITICAL",
				status: "OPEN",
				category: "SECURITY",
				title: "Exposed AWS key in git history",
				description: "An AWS secret was committed.",
				remediation: "Rotate the key and purge it from history.",
				ruleSource: "Git history secret scan",
				location: "commit a1b2c3d — config.ts",
				sourceUrl: "https://repo/commit/a1b2c3d",
				story: { identifier: "F-12" },
			},
		]);

		const result = await handler.execute(makeContext());

		expect(result.handled).toBe(true);
		const response = result.output?.response as string;
		expect(response).toContain(
			"1 finding (latest completed scan, 2026-06-17):",
		);
		expect(response).not.toContain("Showing");
		expect(response).toContain("[CRITICAL · OPEN] Exposed AWS key");
		expect(response).toContain("Remediation: Rotate the key");
		expect(response).toContain("Linked work item: F-12");
		expect(result.output?.outputs?.findingCount).toBe(1);
		// Scoped to the latest completed scan, ordered by severity.
		expect(mocks.listScanFindings).toHaveBeenCalledWith(
			"proj-1",
			expect.objectContaining({
				limit: 51,
				scanId: "scan-1",
				sort: "severity",
			}),
		);
	});

	it("shows 50 findings and explains how to narrow when more exist", async () => {
		mocks.listScanFindings.mockResolvedValue(
			Array.from({ length: 51 }, (_, index) => ({
				severity: "HIGH",
				status: "OPEN",
				category: "SECURITY",
				title: `Finding ${index + 1}`,
				description: "Description",
				remediation: "Remediation",
				ruleSource: "Security review",
				location: null,
				sourceUrl: null,
				story: null,
			})),
		);

		const result = await handler.execute(makeContext());
		const response = result.output?.response as string;

		expect(response).toContain(
			"Showing the first 50 findings (latest completed scan, 2026-06-17).",
		);
		expect(response).toContain(
			"More findings exist; try narrowing by severity or status.",
		);
		expect(response).toContain("[HIGH · OPEN] Finding 50");
		expect(response).not.toContain("[HIGH · OPEN] Finding 51");
		expect(result.output?.outputs?.findingCount).toBe(50);
		expect(mocks.listScanFindings).toHaveBeenCalledWith(
			"proj-1",
			expect.objectContaining({ limit: 51 }),
		);
	});

	it("clips long fields in the bounded result set", async () => {
		const longDescription = "d".repeat(240);
		const longRemediation = "r".repeat(240);
		const longLocation = "l".repeat(240);
		const longSourceUrl = `https://repo.example/${"s".repeat(240)}`;
		mocks.listScanFindings.mockResolvedValue([
			{
				severity: "HIGH",
				status: "OPEN",
				category: "SECURITY",
				title: "Finding with oversized context fields",
				description: longDescription,
				remediation: longRemediation,
				ruleSource: "Security review",
				location: longLocation,
				sourceUrl: longSourceUrl,
				story: null,
			},
		]);

		const result = await handler.execute(makeContext());
		const response = result.output?.response as string;

		expect(response).toContain(`Location: ${"l".repeat(200)}…`);
		expect(response).toContain(`Description: ${"d".repeat(200)}…`);
		expect(response).toContain(`Remediation: ${"r".repeat(200)}…`);
		expect(response).toContain(`Link: ${longSourceUrl.slice(0, 200)}…`);
		expect(response).not.toContain("d".repeat(201));
		expect(response).not.toContain("r".repeat(201));
		expect(response).not.toContain("l".repeat(201));
	});

	it("denies access when the user lacks project access (AC3)", async () => {
		mocks.hasProjectAccess.mockResolvedValue(false);

		const result = await handler.execute(makeContext());

		expect(result.handled).toBe(true);
		expect(result.output?.response).toContain("don't have access");
		// Must not read findings once access is denied.
		expect(mocks.getLatestProjectScan).not.toHaveBeenCalled();
		expect(mocks.listScanFindings).not.toHaveBeenCalled();
	});

	it("reports no findings when there is no completed scan", async () => {
		mocks.getLatestProjectScan.mockResolvedValue(null);

		const result = await handler.execute(makeContext());

		expect(result.output?.response).toContain(
			"no completed security scans",
		);
		expect(mocks.listScanFindings).not.toHaveBeenCalled();
	});

	it("returns a helpful message when no project is attached", async () => {
		const result = await handler.execute(
			makeContext({}, { projectId: undefined }),
		);

		expect(result.output?.response).toContain("No project is attached");
		expect(mocks.hasProjectAccess).not.toHaveBeenCalled();
	});

	it("passes category/severity/status filters through to the query", async () => {
		await handler.execute(
			makeContext({
				category: "SECURITY",
				severity: "HIGH",
				status: "OPEN",
				// Unknown values are ignored, not forwarded.
				bogus: "x",
			}),
		);

		expect(mocks.listScanFindings).toHaveBeenCalledWith(
			"proj-1",
			expect.objectContaining({
				category: "SECURITY",
				limit: 51,
				severity: "HIGH",
				status: "OPEN",
				scanId: "scan-1",
			}),
		);
	});
});
