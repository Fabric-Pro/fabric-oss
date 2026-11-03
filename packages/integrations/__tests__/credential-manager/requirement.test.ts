import { describe, expect, it } from "vitest";
import {
	checkCredentialRequirement,
	normalizeOrigin,
	rankCredentials,
} from "../../src/credential-manager/requirement";

const githubOAuth = {
	provider: "GITHUB" as const,
	kind: "GITHUB_APP_USER" as const,
	origin: "https://github.com",
	principal: "USER" as const,
	scopes: ["repo", "read:user"],
	status: "ACTIVE" as const,
};

describe("checkCredentialRequirement", () => {
	it("accepts a grant whose scopes cover the requirement, including implied ones", () => {
		expect(
			checkCredentialRequirement(githubOAuth, {
				provider: "GITHUB",
				kinds: ["OAUTH", "GITHUB_APP_USER", "PAT"],
				scopes: ["repo", "repo:status"],
			}),
		).toEqual([]);
	});

	it("names the missing scope: the GitHub Projects board list needs `project`", () => {
		expect(
			checkCredentialRequirement(githubOAuth, {
				provider: "GITHUB",
				kinds: ["GITHUB_APP_USER"],
				scopes: ["project", "repo"],
			}),
		).toEqual([{ code: "insufficient-scope", missing: ["project"] }]);
	});

	it("treats `project` as covering `read:project`", () => {
		expect(
			checkCredentialRequirement(
				{ ...githubOAuth, scopes: ["project"] },
				{
					provider: "GITHUB",
					kinds: ["GITHUB_APP_USER"],
					scopes: ["read:project"],
				},
			),
		).toEqual([]);
	});

	it("does not fail a token whose scopes are unknown (empty list)", () => {
		expect(
			checkCredentialRequirement(
				{ ...githubOAuth, kind: "PAT", scopes: [] },
				{ provider: "GITHUB", kinds: ["PAT"], scopes: ["project"] },
			),
		).toEqual([]);
	});

	it("rejects another provider outright", () => {
		expect(
			checkCredentialRequirement(githubOAuth, {
				provider: "GITLAB",
				kinds: ["OAUTH"],
			}),
		).toEqual([{ code: "provider-mismatch" }]);
	});

	it("reports kind, origin, principal and status failures together", () => {
		const failures = checkCredentialRequirement(
			{ ...githubOAuth, status: "NEEDS_REAUTH" },
			{
				provider: "GITHUB",
				kinds: ["APP_INSTALLATION"],
				origin: "https://ghes.example.com",
				principal: "APP",
			},
		);
		expect(failures.map((f) => f.code)).toEqual([
			"needs-reauth",
			"kind-not-accepted",
			"origin-mismatch",
			"principal-mismatch",
		]);
	});

	it("never accepts a revoked credential", () => {
		expect(
			checkCredentialRequirement(
				{ ...githubOAuth, status: "REVOKED" },
				{ provider: "GITHUB", kinds: ["GITHUB_APP_USER"] },
			),
		).toEqual([{ code: "revoked" }]);
	});
});

describe("normalizeOrigin", () => {
	it("ignores case, trailing slash and path", () => {
		expect(normalizeOrigin("https://GitHub.com/")).toBe(
			"https://github.com",
		);
		expect(normalizeOrigin("https://gitlab.example.com/group")).toBe(
			"https://gitlab.example.com",
		);
	});
});

describe("rankCredentials", () => {
	it("puts app installations first, then service accounts, then a person's grant, then tokens", () => {
		const ranked = rankCredentials([
			{ kind: "PAT" as const, label: "a token" },
			{ kind: "GITHUB_APP_USER" as const, label: "me" },
			{ kind: "APP_INSTALLATION" as const, label: "example-org" },
			{ kind: "SERVICE_ACCOUNT" as const, label: "sp" },
		]);
		expect(ranked.map((r) => r.kind)).toEqual([
			"APP_INSTALLATION",
			"SERVICE_ACCOUNT",
			"GITHUB_APP_USER",
			"PAT",
		]);
	});
});
