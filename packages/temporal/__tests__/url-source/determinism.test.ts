/**
 * Determinism smoke test for `url-source-crawl.ts`.
 *
 * Replay validation (CI) is the real safety net, but a static grep over the
 * workflow source catches the obvious mistakes (`Math.random()`, raw
 * `setTimeout`, node:fs imports) on every local run — long before a fresh
 * dev history needs to be fetched.
 *
 * Note: in the Temporal TypeScript SDK, `Date.now()` and `new Date()` are
 * patched to return the workflow's logical time, so they're deterministic
 * inside the workflow sandbox. We funnel both through a single `workflowNow()`
 * helper for readability + so any future migration to `Temporal.now()` is
 * one-line.
 *
 * Per `fabric/standards/backend/temporal.md`:
 *   - Workflow code MUST be deterministic.
 *   - Side-effects/IO are activity concerns, not workflow concerns.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const WORKFLOW_PATH = resolve(
	__dirname,
	"..",
	"..",
	"src",
	"workflows",
	"url-source-crawl.ts",
);

describe("url-source-crawl determinism", () => {
	const source = readFileSync(WORKFLOW_PATH, "utf8");

	// Strip the line-comments + block-comments so doc references to forbidden
	// APIs don't trip the scan. Keeps the assertion strict on actual code.
	const codeOnly = source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\/\/[^\n]*/g, "");

	it("has no Math.random() calls", () => {
		expect(codeOnly).not.toMatch(/\bMath\.random\s*\(/);
	});

	it("has no raw setTimeout / setInterval (use workflow.sleep instead)", () => {
		expect(codeOnly).not.toMatch(/\bsetTimeout\s*\(/);
		expect(codeOnly).not.toMatch(/\bsetInterval\s*\(/);
	});

	it("does not import node:fs / network modules", () => {
		const forbidden = [
			/from\s+["']node:fs["']/,
			/from\s+["']fs["']/,
			/from\s+["']node:https?["']/,
			/from\s+["']https?["']/,
			/from\s+["']node:net["']/,
			// Prisma client and HTTP libs must live in activities, not the workflow.
			/from\s+["']@repo\/database\/prisma\/client["']/,
		];
		for (const pattern of forbidden) {
			expect(source).not.toMatch(pattern);
		}
	});

	it("funnels time access through the single workflowNow() helper", () => {
		// Wall-clock reads happen only inside `workflowNow()`. Outside that
		// helper the workflow should consume `workflowNow()` exclusively so
		// the time-source is grep-able + swappable in one place.
		const dateNowCalls = codeOnly.match(/\bDate\.now\s*\(\s*\)/g) ?? [];
		// Exactly one Date.now() reference — the body of the workflowNow helper.
		expect(dateNowCalls.length).toBeLessThanOrEqual(1);
	});
});
