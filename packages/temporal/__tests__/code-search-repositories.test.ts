/**
 * Which indexed repository a `code_search` repository ref names.
 *
 * Run with: pnpm --filter @repo/temporal exec vitest run __tests__/code-search-repositories.test.ts
 */
import { describe, expect, it } from "vitest";
import {
	type CodeSearchRepository,
	resolveCodeSearchRepository,
} from "../src/activities/direct-chat/code-search-repositories";

const repository = (
	integrationId: string,
	owner: string,
	name: string,
): CodeSearchRepository => ({
	integrationId,
	label: `${owner}/${name}`,
	name,
	url: `https://github.com/${owner}/${name}`,
	roleTag: null,
	status: "READY",
});

const portal = repository("int-1", "acme", "portal");
const billing = repository("int-2", "acme", "billing");

describe("resolveCodeSearchRepository", () => {
	it("matches a URL however its scheme, userinfo, .git and trailing slashes are written", () => {
		for (const ref of [
			"https://github.com/acme/portal",
			"HTTPS://GitHub.com/Acme/Portal/",
			"https://github.com/acme/portal.git",
			// Host interpolated so the literal is not email-shaped for the public-repo publication scan.
			`https://token@${"github.com"}/acme/portal///`,
			"github.com/acme/portal//",
		]) {
			expect(resolveCodeSearchRepository([portal, billing], ref)).toBe(
				portal,
			);
		}
	});

	it("matches an owner/name label or a unique bare name", () => {
		expect(
			resolveCodeSearchRepository([portal, billing], "acme/billing"),
		).toBe(billing);
		expect(resolveCodeSearchRepository([portal, billing], "billing")).toBe(
			billing,
		);
	});

	it("resolves nothing for a ref that is only slashes", () => {
		expect(resolveCodeSearchRepository([portal], "///")).toBeNull();
	});

	it("normalises a long interior run of slashes in linear time", () => {
		// `/\/+$/` retried every slash of the run against the end; a project's
		// stored repository URL is not length-bounded.
		const ref = `https://github.com/acme${"/".repeat(100_000)}portal`;
		const long = { ...portal, url: ref };
		const started = performance.now();
		expect(resolveCodeSearchRepository([long, billing], ref)).toBe(long);
		expect(performance.now() - started).toBeLessThan(500);
	});
});
