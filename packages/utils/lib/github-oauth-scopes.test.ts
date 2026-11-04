import { describe, expect, it } from "vitest";
import { GITHUB_OAUTH_SCOPES } from "./github-oauth-scopes";

describe("GITHUB_OAUTH_SCOPES", () => {
	it("asks once for everything Fabric does on GitHub", () => {
		expect([...GITHUB_OAUTH_SCOPES]).toEqual([
			"repo",
			"workflow",
			"admin:org",
			"project",
			"read:user",
			"user:email",
		]);
	});
});
