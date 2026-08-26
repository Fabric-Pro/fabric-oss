import { describe, expect, it } from "vitest";
import {
	CONDITIONAL_ACCOUNTS,
	GITLAB_ACCOUNT,
	getConditionalAccount,
} from "../src/conditional-accounts";

describe("GITLAB_ACCOUNT", () => {
	it("identifies as the official GitLab account", () => {
		expect(GITLAB_ACCOUNT.id).toBe("gitlab");
		expect(GITLAB_ACCOUNT.credentialType).toBe("gitlab_oauth");
		expect(GITLAB_ACCOUNT.authType).toBe("oauth");
		expect(GITLAB_ACCOUNT.alwaysEnabled).toBe(false);
	});

	it("registers exactly one MCP entry pointing at the official server", () => {
		expect(GITLAB_ACCOUNT.mcps).toHaveLength(1);
		expect(GITLAB_ACCOUNT.mcps[0]?.id).toBe("gitlab-official");
		expect(GITLAB_ACCOUNT.mcps[0]?.serverName).toBe("GitLab");
	});

	it("does not declare a static tool catalog (tools are discovered at runtime)", () => {
		expect(GITLAB_ACCOUNT.mcps[0]?.tools).toEqual([]);
	});

	it("includes workflow guidance describing the official server", () => {
		const guidance = GITLAB_ACCOUNT.mcps[0]?.workflowGuidance ?? "";
		expect(guidance).toContain("official remote MCP server");
		expect(guidance).toContain("merge request");
	});

	it("is registered in CONDITIONAL_ACCOUNTS and queryable by id", () => {
		expect(CONDITIONAL_ACCOUNTS).toContain(GITLAB_ACCOUNT);
		expect(getConditionalAccount("gitlab")).toBe(GITLAB_ACCOUNT);
	});
});
