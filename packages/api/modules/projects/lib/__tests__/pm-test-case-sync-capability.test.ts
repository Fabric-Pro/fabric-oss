/**
 * Unit tests for the native-test-case gate that fronts test-case push/pull.
 *
 * The procedure tests (sync-test-cases.test.ts) mock this helper; here we
 * exercise its real logic against a mocked `getPMToolCapabilities` probe:
 *   - sync requires `supportsTestCases` (a native test-case entity/analogue) —
 *     generic work-item CRUD is NOT enough,
 *   - push additionally needs create OR update; pull needs get OR list,
 *   - an unsupported tool throws BAD_REQUEST with a provider-named message,
 *   - a non-MCP (GitLab REST) target is blocked WITHOUT probing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: { getPMToolCapabilities: vi.fn() },
}));

vi.mock("@repo/temporal", () => ({
	getPMToolCapabilities: mocks.getPMToolCapabilities,
}));

vi.mock("@repo/utils", () => ({
	pmDetectedTypeDisplayName: (t: string | null) =>
		t === "jira" ? "Jira" : t === "fizzy" ? "Fizzy" : null,
}));

import {
	assertTestCaseSyncSupported,
	classifyTestCaseSyncSupport,
} from "../pm-test-case-sync-capability";

const actor = { userId: "u1", organizationId: null };

beforeEach(() => {
	mocks.getPMToolCapabilities.mockReset();
});

describe("assertTestCaseSyncSupported", () => {
	it("passes a push when the tool has native test cases and can create, probing the caller's config", async () => {
		mocks.getPMToolCapabilities.mockResolvedValue({
			supportsTestCases: true,
			canCreate: true,
			canUpdate: false,
			canGet: true,
			canList: true,
			detectedType: "azure-devops",
		});

		await expect(
			assertTestCaseSyncSupported(
				{ kind: "mcp", mcpConfigId: "c1" },
				"push",
				actor,
			),
		).resolves.toBeUndefined();
		expect(mocks.getPMToolCapabilities).toHaveBeenCalledWith(
			expect.objectContaining({ mcpConfigId: "c1", userId: "u1" }),
		);
	});

	it("passes a push when the tool has native test cases and can only update", async () => {
		mocks.getPMToolCapabilities.mockResolvedValue({
			supportsTestCases: true,
			canCreate: false,
			canUpdate: true,
			detectedType: "azure-devops",
		});

		await expect(
			assertTestCaseSyncSupported(
				{ kind: "mcp", mcpConfigId: "c1" },
				"push",
				actor,
			),
		).resolves.toBeUndefined();
	});

	it("REJECTS a push to a generic work-item tool that can create but has NO native test cases", async () => {
		mocks.getPMToolCapabilities.mockResolvedValue({
			supportsTestCases: false,
			canCreate: true,
			canUpdate: true,
			canGet: true,
			canList: true,
			detectedType: "fizzy",
		});

		await expect(
			assertTestCaseSyncSupported(
				{ kind: "mcp", mcpConfigId: "c1" },
				"push",
				actor,
			),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringContaining("Fizzy"),
		});
	});

	it("passes a pull when the tool has native test cases and can read", async () => {
		mocks.getPMToolCapabilities.mockResolvedValue({
			supportsTestCases: true,
			canCreate: false,
			canUpdate: false,
			canGet: true,
			canList: false,
			detectedType: "azure-devops",
		});

		await expect(
			assertTestCaseSyncSupported(
				{ kind: "mcp", mcpConfigId: "c1" },
				"pull",
				actor,
			),
		).resolves.toBeUndefined();
	});

	it("REJECTS a pull from a tool that can list but has no native test cases", async () => {
		mocks.getPMToolCapabilities.mockResolvedValue({
			supportsTestCases: false,
			canGet: true,
			canList: true,
			detectedType: "jira",
		});

		await expect(
			assertTestCaseSyncSupported(
				{ kind: "mcp", mcpConfigId: "c1" },
				"pull",
				actor,
			),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringContaining("Jira"),
		});
	});

	it("falls back to a generic label when the provider type is unknown", async () => {
		mocks.getPMToolCapabilities.mockResolvedValue({
			supportsTestCases: false,
			canCreate: false,
			canUpdate: false,
			detectedType: null,
		});

		await expect(
			assertTestCaseSyncSupported(
				{ kind: "mcp", mcpConfigId: "c1" },
				"push",
				actor,
			),
		).rejects.toMatchObject({
			message: expect.stringContaining("Your connected PM tool"),
		});
	});

	it("blocks a non-MCP (GitLab REST) target WITHOUT probing — no native test cases", async () => {
		await expect(
			assertTestCaseSyncSupported(
				{ kind: "rest-gitlab", mcpConfigId: null },
				"push",
				actor,
			),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.getPMToolCapabilities).not.toHaveBeenCalled();
	});

	it("on a probe that can't confirm support, blocks with a 'couldn't reach' message (not 'no native test cases')", async () => {
		mocks.getPMToolCapabilities.mockResolvedValue(null);

		await expect(
			assertTestCaseSyncSupported(
				{ kind: "mcp", mcpConfigId: "c1" },
				"push",
				actor,
			),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringContaining("Couldn't reach"),
		});
	});
});

describe("classifyTestCaseSyncSupport (tri-state)", () => {
	it("supported when the tool has native test cases and can create/update", async () => {
		mocks.getPMToolCapabilities.mockResolvedValue({
			supportsTestCases: true,
			canCreate: true,
			detectedType: "azure-devops",
		});
		expect(
			await classifyTestCaseSyncSupport(
				{ kind: "mcp", mcpConfigId: "c1" },
				"push",
				actor,
			),
		).toMatchObject({ support: "supported" });
	});

	it("unsupported for a generic work-item tool without native test cases", async () => {
		mocks.getPMToolCapabilities.mockResolvedValue({
			supportsTestCases: false,
			canCreate: true,
			canList: true,
			detectedType: "fizzy",
		});
		expect(
			await classifyTestCaseSyncSupport(
				{ kind: "mcp", mcpConfigId: "c1" },
				"push",
				actor,
			),
		).toMatchObject({ support: "unsupported", providerLabel: "Fizzy" });
	});

	it("unsupported for a non-MCP (GitLab REST) target, without probing", async () => {
		expect(
			await classifyTestCaseSyncSupport(
				{ kind: "rest-gitlab", mcpConfigId: null },
				"push",
				actor,
			),
		).toMatchObject({ support: "unsupported" });
		expect(mocks.getPMToolCapabilities).not.toHaveBeenCalled();
	});

	it("UNKNOWN (not unsupported) when the probe returns null — a transiently unreachable connection", async () => {
		mocks.getPMToolCapabilities.mockResolvedValue(null);
		expect(
			await classifyTestCaseSyncSupport(
				{ kind: "mcp", mcpConfigId: "c1" },
				"push",
				actor,
			),
		).toMatchObject({ support: "unknown" });
	});

	it("UNKNOWN (not unsupported) when the probe throws — a transient MCP error", async () => {
		mocks.getPMToolCapabilities.mockRejectedValue(new Error("mcp timeout"));
		expect(
			await classifyTestCaseSyncSupport(
				{ kind: "mcp", mcpConfigId: "c1" },
				"push",
				actor,
			),
		).toMatchObject({ support: "unknown" });
	});
});
