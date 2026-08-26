/**
 * Integration authority classification.
 *
 * The naming heuristic and the Read-only classifier disagree about verbs like
 * `decode_*`, so a registered provider's declared access must win — otherwise a
 * pure read prompts the user for authority mid-chat. Scoped grants must also
 * actually scope: the database only enforces `toolScope` when a toolName is
 * supplied.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	checkAuthority: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	checkAuthority: h.checkAuthority,
	resolveCanonicalProviderKey: (key: string) =>
		`custom:${key.toLowerCase().replace(/_/g, "-")}`,
}));

const { checkIntegrationAuthority, classifyIntegrationAccessLevel } =
	await import("../authority-gate");

beforeEach(() => {
	h.checkAuthority.mockReset();
	h.checkAuthority.mockResolvedValue({
		authorized: true,
		grant: { id: "g1" },
	});
});

// Test 13
describe("registry-declared access", () => {
	it("classifies every registered NHTSA and Databricks operation as READ", () => {
		for (const operation of [
			"decode_vin",
			"decode_vin_batch",
			"decode_wmi",
			"get_all_manufacturers",
		]) {
			expect(
				classifyIntegrationAccessLevel(operation, "NHTSA_VPIC"),
			).toBe("READ");
		}
		for (const operation of ["query_index", "list_indexes"]) {
			expect(
				classifyIntegrationAccessLevel(
					operation,
					"DATABRICKS_VECTOR_SEARCH",
				),
			).toBe("READ");
		}
	});

	it("still classifies decode_vin as WRITE when the registry has no entry", () => {
		// Documents WHY the registry hint is needed: the prefix heuristic has no
		// `decode` verb, so a provider the registry does not cover is treated
		// conservatively and would prompt.
		expect(
			classifyIntegrationAccessLevel(
				"decode_vin",
				"UNREGISTERED_PROVIDER",
			),
		).toBe("WRITE");
	});

	it("keeps the conservative heuristic for unregistered providers", () => {
		expect(classifyIntegrationAccessLevel("send_message", "SLACK")).toBe(
			"WRITE",
		);
		expect(classifyIntegrationAccessLevel("list_issues", "GITHUB")).toBe(
			"READ",
		);
	});

	it("authorizes a registered read without consulting the grant tables", async () => {
		const result = await checkIntegrationAuthority({
			userId: "u1",
			organizationId: "org-1",
			provider: "NHTSA_VPIC",
			operation: "decode_vin",
			runType: "ORCHESTRATOR",
			runId: "exec-1",
		});

		expect(result.authorized).toBe(true);
		expect(h.checkAuthority).not.toHaveBeenCalled();
	});

	it("authorizes Databricks reads without prompting", async () => {
		for (const operation of ["query_index", "list_indexes"]) {
			const result = await checkIntegrationAuthority({
				userId: "u1",
				provider: "DATABRICKS_VECTOR_SEARCH",
				operation,
			});
			expect(result.authorized).toBe(true);
		}
		expect(h.checkAuthority).not.toHaveBeenCalled();
	});
});

// Test 14
describe("scoped grants", () => {
	it("passes the operation as toolName so toolScope is enforced", async () => {
		await checkIntegrationAuthority({
			userId: "u1",
			organizationId: "org-1",
			provider: "SLACK",
			operation: "send_message",
			runType: "ORCHESTRATOR",
			runId: "exec-1",
		});

		expect(h.checkAuthority).toHaveBeenCalledWith({
			userId: "u1",
			organizationId: "org-1",
			providerKey: "custom:slack",
			accessLevel: "WRITE",
			toolName: "send_message",
			boundRunType: "ORCHESTRATOR",
			boundRunId: "exec-1",
		});
	});

	it("reports the denial reason and required access level", async () => {
		h.checkAuthority.mockResolvedValue({
			authorized: false,
			reason: "No active authority grant.",
		});

		const result = await checkIntegrationAuthority({
			userId: "u1",
			provider: "SLACK",
			operation: "send_message",
		});

		expect(result).toEqual({
			authorized: false,
			reason: "No active authority grant.",
			providerKey: "custom:slack",
			requiredAccessLevel: "WRITE",
		});
	});
});
