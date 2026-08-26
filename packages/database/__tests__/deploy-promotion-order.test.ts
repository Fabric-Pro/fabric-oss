import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The deploy workflow and the migration-runner image both run `promote`. These
 * pin what that script is, so "they share one definition" stays true rather than
 * becoming a comment that outlived the code.
 */
describe("the shared promote script", () => {
	const pkg = JSON.parse(
		readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "../package.json"),
			"utf-8",
		),
	) as { scripts: Record<string, string> };

	it("chains preflight, migrate and RLS in that order", () => {
		const promote = pkg.scripts.promote;
		expect(promote).toBeDefined();
		const preflight = promote.indexOf("preflight");
		const migrate = promote.indexOf("migrate deploy");
		const rls = promote.indexOf("deploy:rls");
		expect(preflight).toBeGreaterThan(-1);
		expect(migrate).toBeGreaterThan(preflight);
		expect(rls).toBeGreaterThan(migrate);
	});

	it("chains with && so a failed step stops the rest", () => {
		// `;` or `&` would let a failed migration fall through to RLS and exit 0,
		// which would defeat the gate the whole change exists to create.
		expect(pkg.scripts.promote).not.toMatch(/;|(?<!&)&(?!&)/);
		expect(pkg.scripts.promote.match(/&&/g) ?? []).toHaveLength(2);
	});

	it("does not seed — seeds run after the rollout", () => {
		expect(pkg.scripts.promote).not.toContain("seed");
	});

	it("is what the migration-runner image runs", () => {
		const dockerfile = readFileSync(
			join(
				dirname(fileURLToPath(import.meta.url)),
				"../Dockerfile.migrate",
			),
			"utf-8",
		);
		expect(dockerfile).toMatch(/CMD \["pnpm", "promote"\]/);
	});
});
