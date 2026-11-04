import { describe, expect, it } from "vitest";
import {
	renderSummary,
	Summary,
	supportsUnicodeMarks,
} from "../src/lib/summary.js";

const LOGIN =
	"npx -y https://fabric.example.com/cli/fabric-0.4.0.tgz auth login --project example-project";

function plugin(summary: Summary): void {
	summary.add("ok", "Plugin installed", "example@example (local)", [
		"Registered the example plugin in .claude/settings.local.json.",
	]);
	summary.add("ok", "Project rules", "5 written → .claude/rules/example/");
	summary.add("ok", "Hooks", "memory pull at start, push at turn end");
	summary.add("ok", "MCP sign-in", "signed in (connects next session)");
}

describe("renderSummary", () => {
	it("says all set when every step is done", () => {
		const summary = new Summary();
		plugin(summary);
		summary.add("ok", "Memory access", "memory folders ready");
		summary.add("ok", "Repositories", "example-org/app → repos/app");

		expect(
			renderSummary(summary, {
				finally: "Start a new Claude Code session.",
			}),
		).toBe(
			[
				"✓ Plugin installed  example@example (local)",
				"✓ Project rules     5 written → .claude/rules/example/",
				"✓ Hooks             memory pull at start, push at turn end",
				"✓ MCP sign-in       signed in (connects next session)",
				"✓ Memory access     memory folders ready",
				"✓ Repositories      example-org/app → repos/app",
				"",
				"All set. Start a new Claude Code session.",
			].join("\n"),
		);
		expect(summary.failed).toBe(0);
	});

	it("lists an action only under the numbered next steps, its command on its own line", () => {
		const summary = new Summary();
		plugin(summary);
		summary.add(
			"action",
			"Memory access",
			"needs one more sign-in (see below)",
		);
		summary.todo("Sign in again and approve the memory permission:", [
			LOGIN,
		]);

		expect(
			renderSummary(summary, {
				finally: "Start a new Claude Code session.",
			}),
		).toBe(
			[
				"✓ Plugin installed  example@example (local)",
				"✓ Project rules     5 written → .claude/rules/example/",
				"✓ Hooks             memory pull at start, push at turn end",
				"✓ MCP sign-in       signed in (connects next session)",
				"! Memory access     needs one more sign-in (see below)",
				"",
				"Next steps:",
				"  1. Sign in again and approve the memory permission:",
				`       ${LOGIN}`,
				"  2. Start a new Claude Code session.",
			].join("\n"),
		);
		expect(summary.failed).toBe(0);
	});

	it("marks a failed step and counts it", () => {
		const summary = new Summary();
		plugin(summary);
		summary.add(
			"failed",
			"Repositories",
			"1 of 1 not cloned: example-org/app",
		);
		summary.todo(
			"example-org/app: sign git in to GitHub and run `fabric repos sync` again.",
		);
		summary.add("skipped", "Tool detection", "none found");

		const text = renderSummary(summary);

		expect(text).toContain(
			"✗ Repositories      1 of 1 not cloned: example-org/app",
		);
		expect(text).toContain("– Tool detection    none found");
		expect(text).toContain(
			"Next steps:\n  1. example-org/app: sign git in to GitHub and run `fabric repos sync` again.",
		);
		expect(summary.failed).toBe(1);
	});

	it("falls back to plain marks and arrows", () => {
		const summary = new Summary();
		summary.add(
			"ok",
			"Project rules",
			"5 written → .claude/rules/example/",
		);
		summary.add("action", "Memory access", "needs one more sign-in");
		summary.add("failed", "Repositories", "not cloned");
		summary.add("skipped", "Tool detection", "none found – Claude Code");

		expect(renderSummary(summary, { ascii: true })).toBe(
			[
				"[ok] Project rules   5 written -> .claude/rules/example/",
				"[!]  Memory access   needs one more sign-in",
				"[x]  Repositories    not cloned",
				"[-]  Tool detection  none found - Claude Code",
			].join("\n"),
		);
	});

	it("prints each step's full sentences under it only when verbose", () => {
		const summary = new Summary();
		plugin(summary);

		expect(renderSummary(summary)).not.toContain("Registered the example");
		expect(renderSummary(summary, { verbose: true })).toContain(
			"✓ Plugin installed  example@example (local)\n    Registered the example plugin in .claude/settings.local.json.\n",
		);
	});
});

describe("supportsUnicodeMarks", () => {
	it("is true off Windows and in the Windows terminals that render them", () => {
		expect(supportsUnicodeMarks({}, "linux")).toBe(true);
		expect(supportsUnicodeMarks({}, "darwin")).toBe(true);
		expect(supportsUnicodeMarks({ WT_SESSION: "1" }, "win32")).toBe(true);
		expect(supportsUnicodeMarks({ TERM_PROGRAM: "vscode" }, "win32")).toBe(
			true,
		);
	});

	it("is false in the plain Windows console, the Linux console, and when asked", () => {
		expect(supportsUnicodeMarks({}, "win32")).toBe(false);
		expect(supportsUnicodeMarks({ TERM: "linux" }, "linux")).toBe(false);
		expect(supportsUnicodeMarks({ FABRIC_ASCII: "1" }, "darwin")).toBe(
			false,
		);
	});
});
