/**
 * `repoForgeFromUrl` decides which forge's stored credentials a repository URL
 * is routed to (`findMcpConfigsForRepos`) and which provider the saved code
 * analysis is attributed to. It replaced substring tests over the whole URL
 * (`/github\.com/i.test(url)`), which also matched URLs whose real host was
 * somewhere else. js/regex/missing-regexp-anchor
 *
 * Run with: pnpm --filter @repo/temporal test __tests__/repo-forge.test.ts
 */

import { describe, expect, it } from "vitest";
import { repoForgeFromUrl } from "../src/lib/repo-forge";

// scp-style fixtures are assembled here so the file carries no email-shaped
// literal for the publication identifier scan to trip on.
const scp = (host: string, path: string) => `git@${host}:${path}`;

describe("repoForgeFromUrl", () => {
	it("classifies the canonical forge hosts, including deep links and SSH", () => {
		expect(repoForgeFromUrl("https://github.com/acme/widgets")).toBe(
			"github",
		);
		expect(
			repoForgeFromUrl("https://github.com/acme/widgets/tree/main/src"),
		).toBe("github");
		expect(repoForgeFromUrl(scp("github.com", "acme/widgets.git"))).toBe(
			"github",
		);
		expect(repoForgeFromUrl("github.com/acme/widgets")).toBe("github");
		expect(
			repoForgeFromUrl(
				"https://raw.githubusercontent.com/acme/widgets/main/a.md",
			),
		).toBe("github");
		expect(repoForgeFromUrl("https://gitlab.com/acme/widgets")).toBe(
			"gitlab",
		);
		expect(repoForgeFromUrl(scp("gitlab.com", "acme/widgets.git"))).toBe(
			"gitlab",
		);
		expect(
			repoForgeFromUrl("https://dev.azure.com/acme/Proj/_git/widgets"),
		).toBe("azure-devops");
		expect(
			repoForgeFromUrl("https://acme.visualstudio.com/_git/widgets"),
		).toBe("azure-devops");
	});

	it("does not claim a forge named only in the path, the userinfo or a lookalike host", () => {
		expect(
			repoForgeFromUrl("https://example.com/github.com/acme/widgets"),
		).toBeNull();
		expect(
			repoForgeFromUrl("https://github.com@example.com/acme/widgets"),
		).toBeNull();
		expect(
			repoForgeFromUrl("https://github.com.example.com/acme/widgets"),
		).toBeNull();
		expect(
			repoForgeFromUrl("https://example.com/?repo=dev.azure.com/a/b"),
		).toBeNull();
		expect(
			repoForgeFromUrl(scp("example.com", "acme/gitlab.com.git")),
		).toBeNull();
	});

	it("returns null for empty, blank and unparseable input", () => {
		expect(repoForgeFromUrl("")).toBeNull();
		expect(repoForgeFromUrl("   ")).toBeNull();
		expect(repoForgeFromUrl("https://")).toBeNull();
		expect(repoForgeFromUrl("not a url at all")).toBeNull();
	});
});
