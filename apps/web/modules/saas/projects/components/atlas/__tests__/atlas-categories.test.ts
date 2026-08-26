/**
 * Unit tests for the Atlas smart-categorisation keystone.
 *
 * `categorizeNode` is a pure, first-match-wins keyword matcher — these assert
 * the representative mappings the rest of the graph relies on (node colour,
 * legend, neighbour chips), plus the priority ordering (security beats a generic
 * experience/ops match) and the "ops" fallback for unknown nodes.
 */
import type { AtlasNodeKind } from "@repo/atlas/types";
import { describe, expect, it } from "vitest";
import {
	type AtlasCategory,
	asAtlasCategory,
	CATEGORY_META,
	CATEGORY_ORDER,
	categorizeNode,
	categoryColorVar,
	CUSTOM_CATEGORY_COLOR_VAR,
	resolveNodeCategory,
} from "../atlas-categories";

function cat(
	label: string,
	extra?: {
		filePath?: string | null;
		description?: string | null;
		kind?: AtlasNodeKind;
	},
): AtlasCategory {
	return categorizeNode({
		label,
		filePath: extra?.filePath ?? null,
		description: extra?.description ?? null,
		kind: extra?.kind ?? "MODULE",
	});
}

describe("categorizeNode", () => {
	it("maps the representative labels from the spec", () => {
		expect(cat("modules/saas/auth", { kind: "DIRECTORY" })).toBe(
			"security",
		);
		expect(cat("AI Agent Orchestration", { kind: "CAPABILITY" })).toBe(
			"ai",
		);
		expect(cat("External Integrations", { kind: "CAPABILITY" })).toBe(
			"integration",
		);
		expect(cat("Data Persistence & Storage", { kind: "CAPABILITY" })).toBe(
			"data",
		);
		expect(cat("packages/temporal", { kind: "DIRECTORY" })).toBe("infra");
		expect(cat("modules/ui", { kind: "MODULE" })).toBe("experience");
		expect(cat("Billing & Payments", { kind: "CAPABILITY" })).toBe("ops");
	});

	it("falls back to ops for an unknown node", () => {
		expect(cat("Zzyzx Frobnicator", { kind: "MODULE" })).toBe("ops");
		expect(cat("", { kind: "FILE" })).toBe("ops");
	});

	it("matches on file path and description, not just the label", () => {
		expect(cat("session.ts", { filePath: "src/auth/session.ts" })).toBe(
			"security",
		);
		expect(
			cat("helper", {
				description: "Builds Prisma migrations for the database schema",
			}),
		).toBe("data");
		expect(
			cat("worker", { filePath: "packages/temporal/src/worker.ts" }),
		).toBe("infra");
	});

	it("resolves word-boundary keywords across path separators", () => {
		// " ai " / " ui" only fire on whole segments, never inside other words.
		expect(cat("modules/saas/ai", { kind: "MODULE" })).toBe("ai");
		expect(cat("domain logic", { kind: "MODULE" })).not.toBe("ai");
		expect(cat("requirements builder", { kind: "MODULE" })).not.toBe(
			"experience",
		);
	});

	it("honours rule priority (security outranks a later category)", () => {
		// "tenant isolation" inside an otherwise app/experience-flavoured label
		// must still classify as security (rule #1), not experience.
		expect(cat("Project tenant isolation guard")).toBe("security");
		// "agent" (AI) outranks "integration" when both could match.
		expect(cat("Agent integration bridge")).toBe("ai");
	});
});

describe("category metadata", () => {
	it("exposes all seven categories in order with token colours + icons", () => {
		expect(CATEGORY_ORDER).toEqual([
			"ai",
			"integration",
			"security",
			"infra",
			"data",
			"experience",
			"ops",
		]);
		for (const category of CATEGORY_ORDER) {
			const meta = CATEGORY_META[category];
			expect(meta.colorVar).toBe(`var(--atlas-cat-${category})`);
			expect(meta.labelKey).toBe(`projects.atlas.category.${category}`);
			expect(typeof meta.Icon).toBe("object");
			expect(categoryColorVar(category)).toBe(meta.colorVar);
		}
	});
});

describe("asAtlasCategory", () => {
	it("narrows the seven presets and rejects custom / empty values", () => {
		for (const category of CATEGORY_ORDER) {
			expect(asAtlasCategory(category)).toBe(category);
		}
		expect(asAtlasCategory("payments-team")).toBeNull();
		expect(asAtlasCategory("AI")).toBeNull(); // case-sensitive: presets are lowercase
		expect(asAtlasCategory(null)).toBeNull();
		expect(asAtlasCategory(undefined)).toBeNull();
		expect(asAtlasCategory("")).toBeNull();
	});
});

describe("resolveNodeCategory", () => {
	it("prefers the persisted category over keyword categorisation", () => {
		// Label keywords as "experience", but the persisted override wins.
		const resolved = resolveNodeCategory({
			label: "modules/ui",
			kind: "MODULE",
			category: "security",
		});
		expect(resolved.known).toBe("security");
		expect(resolved.value).toBe("security");
		expect(resolved.colorVar).toBe(categoryColorVar("security"));
	});

	it("falls back to keyword categorisation when no category is persisted", () => {
		const fromNull = resolveNodeCategory({
			label: "modules/saas/auth",
			kind: "MODULE",
			category: null,
		});
		expect(fromNull.known).toBe("security");

		const fromMissing = resolveNodeCategory({
			label: "AI Agent Orchestration",
			kind: "CAPABILITY",
		});
		expect(fromMissing.known).toBe("ai");
	});

	it("treats an unknown value as a custom category with a neutral token", () => {
		const resolved = resolveNodeCategory({
			label: "Checkout",
			kind: "CAPABILITY",
			category: "payments-team",
		});
		expect(resolved.known).toBeNull();
		expect(resolved.value).toBe("payments-team");
		expect(resolved.colorVar).toBe(CUSTOM_CATEGORY_COLOR_VAR);
		// Never a hardcoded hex — always a design-token reference.
		expect(resolved.colorVar.startsWith("var(--")).toBe(true);
	});

	it("ignores a blank persisted category and falls back to keywords", () => {
		const resolved = resolveNodeCategory({
			label: "packages/temporal",
			kind: "DIRECTORY",
			category: "   ",
		});
		expect(resolved.known).toBe("infra");
	});
});
