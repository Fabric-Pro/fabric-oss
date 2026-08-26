/**
 * Authority Policy Tests
 *
 * Tests for the unified approval precedence model:
 * 1. Authority check (runtime grants)
 * 2. Step risk check
 * 3. Trust optimization
 *
 * These test the pure-logic parts (extractRequiredProviders, precedence rules).
 * Full integration tests with DB-backed authority are in the database package.
 *
 * Run with: pnpm --filter @repo/temporal test -- authority-policy
 */

import { describe, expect, it } from "vitest";
import { extractRequiredProviders } from "../src/activities/orchestrator/approval/authority-policy";

describe("extractRequiredProviders", () => {
	it("should extract providers from MCP tools", () => {
		const step = {
			id: "step-1",
			description: "List GitHub issues",
			type: "api" as const,
			status: "pending" as const,
			order: 1,
			toolsToUse: ["list_issues", "get_repo"],
		};

		const toolToConfig = {
			list_issues: { serverName: "github", configId: "c1" },
			get_repo: { serverName: "github", configId: "c1" },
		};

		const providers = extractRequiredProviders(step, toolToConfig);

		// Should deduplicate by provider key
		expect(providers).toHaveLength(1);
		expect(providers[0]?.providerKey).toBe("github");
		expect(providers[0]?.accessLevel).toBe("READ"); // list_issues → READ
	});

	it("should extract providers from integrations", () => {
		const step = {
			id: "step-1",
			description: "Send Slack message",
			type: "api" as const,
			status: "pending" as const,
			order: 1,
		};

		const integrations = [{ provider: "SLACK" }];

		const providers = extractRequiredProviders(
			step,
			undefined,
			integrations,
		);

		expect(providers).toHaveLength(1);
		expect(providers[0]?.providerKey).toBe("slack");
		expect(providers[0]?.accessLevel).toBe("WRITE");
	});

	it("should combine MCP and integration providers without duplicates", () => {
		const step = {
			id: "step-1",
			description: "Sync",
			type: "api" as const,
			status: "pending" as const,
			order: 1,
			toolsToUse: ["list_repos"],
		};

		const toolToConfig = {
			list_repos: { serverName: "github", configId: "c1" },
		};

		const integrations = [{ provider: "GITHUB" }, { provider: "SLACK" }];

		const providers = extractRequiredProviders(
			step,
			toolToConfig,
			integrations,
		);

		expect(providers).toHaveLength(2);
		const keys = providers.map((p) => p.providerKey);
		expect(keys).toContain("github");
		expect(keys).toContain("slack");
	});

	it("should return empty array when no tools or integrations", () => {
		const step = {
			id: "step-1",
			description: "Think",
			type: "api" as const,
			status: "pending" as const,
			order: 1,
		};

		const providers = extractRequiredProviders(step);
		expect(providers).toHaveLength(0);
	});

	it("should classify read/write correctly for MCP tools", () => {
		const step = {
			id: "step-1",
			description: "Create issue",
			type: "api" as const,
			status: "pending" as const,
			order: 1,
			toolsToUse: ["create_issue", "list_issues"],
		};

		const toolToConfig = {
			create_issue: { serverName: "linear", configId: "c1" },
			list_issues: { serverName: "github", configId: "c2" },
		};

		const providers = extractRequiredProviders(step, toolToConfig);

		expect(providers).toHaveLength(2);
		const linear = providers.find((p) => p.providerKey === "linear");
		const github = providers.find((p) => p.providerKey === "github");
		expect(linear?.accessLevel).toBe("WRITE"); // create_issue → WRITE
		expect(github?.accessLevel).toBe("READ"); // list_issues → READ
	});
});
