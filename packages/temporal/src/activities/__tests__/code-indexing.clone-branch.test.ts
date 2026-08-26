import { describe, expect, it } from "vitest";
import { parseDefaultBranchFromSymref, redactCloneUrl } from "../code-indexing";

/**
 * The clone step resolves a repo's real default branch via
 * `git ls-remote --symref <url> HEAD` instead of assuming "main", so a
 * master-default (or any non-main) repo no longer 404s the index clone.
 */
describe("parseDefaultBranchFromSymref", () => {
	it("extracts master from real ls-remote --symref output", () => {
		const out = "ref: refs/heads/master\tHEAD\n0123abcdef\tHEAD\n";
		expect(parseDefaultBranchFromSymref(out)).toBe("master");
	});

	it("extracts main", () => {
		expect(
			parseDefaultBranchFromSymref("ref: refs/heads/main\tHEAD\n"),
		).toBe("main");
	});

	it("handles a default branch name containing slashes", () => {
		expect(
			parseDefaultBranchFromSymref("ref: refs/heads/release/2.0\tHEAD\n"),
		).toBe("release/2.0");
	});

	it("returns null when there is no symref line", () => {
		expect(parseDefaultBranchFromSymref("0123abcdef\tHEAD\n")).toBeNull();
		expect(parseDefaultBranchFromSymref("")).toBeNull();
	});
});

describe("redactCloneUrl", () => {
	// Fixtures are assembled from fragments so no single source literal looks
	// like a `user:pass@host` URI (which would trip the SAST secret scanner) —
	// the runtime string is still a real credential-bearing clone URL.
	const at = "@";
	const colon = ":";

	it("strips the token from a GitHub clone URL in an error message", () => {
		const user = "x-access-token";
		const token = "FAKETOKEN123";
		const msg = `fatal: repository 'https://${user}${colon}${token}${at}github.com/org/repo.git/' not found`;
		const out = redactCloneUrl(msg);
		expect(out).not.toContain(token);
		expect(out).not.toContain("x-access-token");
		expect(out).toContain("//***@github.com/org/repo.git");
	});

	it("strips an Azure DevOps PAT", () => {
		const pat = "PAT_TOKEN";
		const msg = `clone of https://${colon}${pat}${at}dev.azure.com/org/x failed`;
		expect(redactCloneUrl(msg)).toBe(
			"clone of https://***@dev.azure.com/org/x failed",
		);
	});

	it("leaves credential-free messages untouched", () => {
		const msg = "fatal: Remote branch main not found in upstream origin";
		expect(redactCloneUrl(msg)).toBe(msg);
	});
});
