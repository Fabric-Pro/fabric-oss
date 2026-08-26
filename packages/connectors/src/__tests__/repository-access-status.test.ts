import { describe, expect, it } from "vitest";
import { integrationStatusForRepoAccess } from "../repository-access-status";

/**
 * The one mapping from a repository-access probe outcome to the status the
 * badge shows. Both the OAuth connect callbacks and the scheduled health check
 * consume it, so a change here changes both lanes at once.
 */
describe("integrationStatusForRepoAccess", () => {
	it("maps accessible and unreachable to ACTIVE with no error", () => {
		expect(integrationStatusForRepoAccess("accessible", "GITHUB")).toEqual({
			status: "ACTIVE",
			lastError: null,
		});
		// Inconclusive is deliberately NOT a verdict: today's behaviour stands
		// and the next sweep re-classifies.
		expect(integrationStatusForRepoAccess("unreachable", "GITLAB")).toEqual(
			{
				status: "ACTIVE",
				lastError: null,
			},
		);
	});

	it("maps unauthorized to TOKEN_EXPIRED whose message says reconnect and names the status", () => {
		const verdict = integrationStatusForRepoAccess(
			"unauthorized",
			"GITHUB",
		);
		expect(verdict.status).toBe("TOKEN_EXPIRED");
		expect(verdict.lastError).toMatch(/rejected/);
		expect(verdict.lastError).toMatch(/reconnect/);
		expect(verdict.lastError).toContain("(HTTP 401)");
	});

	it("maps forbidden to REPO_UNAVAILABLE with the cause, not a repeated remedy", () => {
		const verdict = integrationStatusForRepoAccess("forbidden", "GITHUB");
		expect(verdict.status).toBe("REPO_UNAVAILABLE");
		expect(verdict.lastError).toContain("GitHub");
		// Cause only: the row's status hint already carries the install-app/PAT
		// remedy — repeating it here is noise.
		expect(verdict.lastError).toMatch(/refused this repository/);
		expect(verdict.lastError).not.toMatch(/personal access token/i);
	});

	it("maps not-found to REPO_UNAVAILABLE and explains GitHub's 404 ambiguity", () => {
		const verdict = integrationStatusForRepoAccess("not-found", "GITLAB");
		expect(verdict.status).toBe("REPO_UNAVAILABLE");
		expect(verdict.lastError).toContain("GitLab");
		expect(verdict.lastError).toMatch(/not visible/);
	});
});
