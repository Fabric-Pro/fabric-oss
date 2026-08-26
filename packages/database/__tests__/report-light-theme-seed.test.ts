/**
 * Regression guard for the "report preview renders dark in Fabric light mode" fix
 * (spec: 2026-06-08-report-preview-theme-light-mode).
 *
 * The board report is a self-contained, LLM-generated HTML document that previously
 * keyed its theme off the OS via `@media (prefers-color-scheme: dark)` — so it
 * rendered dark on a dark-OS machine even while Fabric was in light mode. The fix
 * makes the report a fixed light theme. These tests pin the seed CONTENT so the
 * OS-keyed dark trigger can't be silently reintroduced into the prompt/template.
 *
 * Only the static exported arrays are read here — no DB call is made — so the
 * Prisma client (and the report-templates logger) are mocked to avoid pulling the
 * generated client into the test runtime, matching `seed-enterprise-mcp.test.ts`.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../prisma/client", () => ({
	db: {
		$disconnect: vi.fn(),
	},
}));

vi.mock("@repo/logs", () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

import { SYSTEM_TEMPLATES } from "../prisma/seed-report-templates";
import { systemSkills } from "../prisma/seed-skills";

describe("task-board-visual-report skill is light-only", () => {
	const skill = systemSkills.find(
		(s) => s.slug === "task-board-visual-report",
	);

	it("exists in the seed data", () => {
		expect(skill).toBeDefined();
	});

	it("no longer contains a prefers-color-scheme: dark media query", () => {
		// The literal at-rule must not appear (the only allowed occurrence is the
		// negative instruction telling the model NOT to emit it). Assert the actual
		// CSS at-rule form `@media (prefers-color-scheme: dark) {` is absent.
		expect(skill?.content).not.toMatch(
			/@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)\s*\{/i,
		);
	});

	it("no longer contains a dark logo swap (.logo-dark)", () => {
		expect(skill?.content).not.toContain(".logo-dark");
		expect(skill?.content).not.toContain('class="logo-dark"');
	});

	it("keeps the light :root tokens (warm-stone palette)", () => {
		expect(skill?.content).toContain("--bg-primary: #fafaf9;");
		expect(skill?.content).toContain("--text-primary: #1c1917;");
	});

	it("declares a color-scheme: light signal", () => {
		expect(skill?.content).toContain("color-scheme: light;");
	});
});

describe("task-board-project-report template AI task is light-only", () => {
	const template = SYSTEM_TEMPLATES.find(
		(t) => t.key === "task-board-project-report",
	);

	const aiTask = (
		template?.definition as
			| { aiAgents?: Array<{ task?: string }> }
			| undefined
	)?.aiAgents?.[0]?.task;

	it("exists in the seed data with an AI task", () => {
		expect(template).toBeDefined();
		expect(aiTask).toBeTypeOf("string");
	});

	it('no longer asks for "dark/light theme support"', () => {
		expect(aiTask).not.toContain("dark/light theme support");
	});

	it("instructs a light-only self-contained theme", () => {
		expect(aiTask).toContain("light-only self-contained theme");
	});
});
