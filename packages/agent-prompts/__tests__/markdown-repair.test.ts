/**
 * Tests for repairDegradedMarkdown — the deterministic structure-repair pass
 * for AI-edited specs. It repairs only the two markdown breakages that defeat a
 * parser and that clean content can never produce: a bold marker split across a
 * bullet boundary, and an Open Question split across two bullets. Everything
 * else — including cosmetic degradations and any well-formed content — must pass
 * through byte-for-byte, on documents of every type.
 *
 * Run with: pnpm --filter @repo/agent-prompts test
 */

import { describe, expect, it } from "vitest";
import { repairDegradedMarkdown } from "../src/core/markdown-repair";

describe("repairDegradedMarkdown", () => {
	// ── The two parser-breaking repairs ────────────────────────────────────────

	it("rejoins a bold marker split across a bullet boundary", () => {
		const input = [
			"-   **Dependency*",
			"",
			"-   *: Release notes review/approval step (Ticket 1869)",
		].join("\n");
		expect(repairDegradedMarkdown(input)).toBe(
			"-   **Dependency**: Release notes review/approval step (Ticket 1869)",
		);
	});

	it("joins a split Open Question into a single parser-safe bullet", () => {
		const input = [
			"-   Q: What",
			"",
			"-   icon asset should be used to distinguish org-synced subscribers?",
		].join("\n");
		expect(repairDegradedMarkdown(input)).toBe(
			"-   Q: What icon asset should be used to distinguish org-synced subscribers?",
		);
	});

	it("is idempotent — repairing twice equals repairing once", () => {
		const degraded = [
			"-   Q: What",
			"",
			"-   icon asset should be used to distinguish org-synced subscribers?",
			"",
			"-   **Dependency*",
			"",
			"-   *: Release notes review/approval step (Ticket 1869)",
		].join("\n");
		const once = repairDegradedMarkdown(degraded);
		expect(repairDegradedMarkdown(once)).toBe(once);
	});

	// ── False positives the guards must reject (separate items, not a split) ────

	it("does not merge a Q: bullet with a separate, unrelated item", () => {
		const clean = [
			"-   Q: Whether we should migrate",
			"-   Will be decided next quarter",
		].join("\n");
		expect(repairDegradedMarkdown(clean)).toBe(clean);
	});

	it("does not merge a Q: bullet with a separate uppercase question", () => {
		const clean = ["-   Q: What", "-   Another question entirely"].join(
			"\n",
		);
		expect(repairDegradedMarkdown(clean)).toBe(clean);
	});

	it("does not fold a lowercase list item into the preceding bullet", () => {
		// A plain list of lowercase, unpunctuated items must survive intact — the
		// pass no longer guesses at sentence continuations.
		const clean = ["-   frontend", "-   backend", "-   infra"].join("\n");
		expect(repairDegradedMarkdown(clean)).toBe(clean);
	});

	it("does not merge a nested Q: with a differently-indented following item", () => {
		// The continuation must be at the SAME indent level to count as a split;
		// a shallower lowercase question is a separate item, not a broken tail.
		const clean = [
			"    -   Q: should we migrate",
			"-   is this urgent?",
		].join("\n");
		expect(repairDegradedMarkdown(clean)).toBe(clean);
	});

	// ── Negative cases: clean markdown must pass through untouched ──────────────

	it("leaves a clean nested list (incl. structural labels) unchanged", () => {
		const clean = [
			"-   **Dependency**: Existing release notes job",
			"",
			"    -   Why needed: Sync is inserted into this job.",
			"",
			"    -   Owner/team: Alice Anderson / backend",
			"",
			"    -   Risk if delayed: Cannot build until confirmed.",
		].join("\n");
		expect(repairDegradedMarkdown(clean)).toBe(clean);
	});

	it("leaves a clean Open Question unchanged", () => {
		const clean = [
			"-   Q: What icon asset should be used to distinguish org-synced subscribers?",
			"",
			"    -   Why it matters: The placeholder icon must be approved first.",
			"    -   Owner/decider: Sam Salima / Avery Diaz",
		].join("\n");
		expect(repairDegradedMarkdown(clean)).toBe(clean);
	});

	it("does not merge two legitimately separate top-level bullets", () => {
		const clean = [
			"-   Bulk add input method — paste only.",
			"-   Batch size soft cap — 500 emails.",
		].join("\n");
		expect(repairDegradedMarkdown(clean)).toBe(clean);
	});

	it("does not touch prose, headings, or fenced code", () => {
		const clean = [
			"## Overview",
			"",
			"This feature does a thing. It is good.",
			"",
			"```ts",
			"const x = 1;",
			"```",
		].join("\n");
		expect(repairDegradedMarkdown(clean)).toBe(clean);
	});

	it("returns empty/whitespace input unchanged", () => {
		expect(repairDegradedMarkdown("")).toBe("");
		expect(repairDegradedMarkdown("   \n  ")).toBe("   \n  ");
	});
});
