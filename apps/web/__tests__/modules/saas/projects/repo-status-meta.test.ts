import { getRepoStatusMeta } from "@saas/projects/lib/repo-status-meta";
import { describe, expect, it } from "vitest";

describe("getRepoStatusMeta", () => {
	it("maps ACTIVE to a green/active tone", () => {
		const m = getRepoStatusMeta("ACTIVE");
		expect(m.tone).toBe("active");
		expect(m.label).toBe("Active");
		expect(m.bgColor).toContain("green");
	});

	it("maps TOKEN_EXPIRED to an amber/expired tone", () => {
		const m = getRepoStatusMeta("TOKEN_EXPIRED");
		expect(m.tone).toBe("expired");
		expect(m.bgColor).toContain("amber");
	});

	it("maps ERROR to a red/error tone", () => {
		expect(getRepoStatusMeta("ERROR").tone).toBe("error");
	});

	it("maps an unknown status to a neutral indeterminate tone, never green", () => {
		const m = getRepoStatusMeta("SOMETHING_NEW");
		expect(m.tone).toBe("unknown");
		expect(m.label).toBe("Status unavailable");
		expect(m.bgColor).not.toContain("green");
	});

	it("gives an unknown status a neutral hint, NOT the disconnected recovery action", () => {
		const m = getRepoStatusMeta("SOMETHING_NEW");
		// Codex Finding B: an unknown status must not tell the user to
		// 're-configure' (wrong recovery action for a future/unknown state).
		expect(m.hint).not.toMatch(/re-configure/i);
	});

	it("gives ACTIVE no hint and TOKEN_EXPIRED a re-authenticate hint", () => {
		expect(getRepoStatusMeta("ACTIVE").hint).toBeUndefined();
		expect(getRepoStatusMeta("TOKEN_EXPIRED").hint).toMatch(
			/re-authenticate/i,
		);
	});

	it("maps REPO_UNAVAILABLE to an error tone whose hint names the grant remedy, never re-authenticating", () => {
		const m = getRepoStatusMeta("REPO_UNAVAILABLE");
		expect(m.tone).toBe("error");
		expect(m.label).toBe("No access");
		expect(m.bgColor).not.toContain("green");
		// The credential is FINE here — "re-authenticate" would send the user
		// through an OAuth round trip that fixes nothing.
		expect(m.hint).toMatch(/personal access token/i);
		expect(m.hint).not.toMatch(/re-authenticate/i);
	});
});
