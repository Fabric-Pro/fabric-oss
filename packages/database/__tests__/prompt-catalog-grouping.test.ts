/**
 * What the catalog says is in force for an action.
 *
 * The winner must be the highest-precedence tier that is BOTH present and
 * marked default — the same two conditions `getBoundPromptVersion` applies at
 * runtime. If the catalog resolved it any other way it would confidently show a
 * prompt that is not the one the agent runs, which is worse than showing
 * nothing.
 *
 * Run with:
 *   pnpm --filter @repo/database test __tests__/prompt-catalog-grouping.test.ts
 */

import { describe, expect, it } from "vitest";
import { groupPromptCatalogBindings } from "../prisma/queries/prompts";

let seq = 0;
const row = (
	scope: "SYSTEM" | "ORG" | "USER",
	isDefault: boolean,
	overrides: Partial<{
		targetKey: string;
		documentType: string;
		storyKind: "FEATURE" | "BUG" | null;
		promptName: string;
	}> = {},
) => {
	seq += 1;
	return {
		targetKey: overrides.targetKey ?? "test_case_drafter",
		documentType: overrides.documentType ?? "GENERAL",
		storyKind: (overrides.storyKind ?? null) as any,
		scope,
		isDefault,
		promptVersionId: `pv-${seq}`,
		version: 1,
		promptId: `p-${scope}-${seq}`,
		promptName: overrides.promptName ?? `${scope} prompt`,
	};
};

describe("groupPromptCatalogBindings", () => {
	it("groups bindings into one entry per action", () => {
		const entries = groupPromptCatalogBindings([
			row("SYSTEM", true, { documentType: "GENERAL" }),
			row("SYSTEM", true, { documentType: "PRD" }),
		]);

		expect(entries).toHaveLength(2);
	});

	it("treats the same stage at different kinds as different actions", () => {
		const entries = groupPromptCatalogBindings([
			row("SYSTEM", true, {
				documentType: "DRAFT",
				storyKind: "FEATURE",
			}),
			row("SYSTEM", true, { documentType: "DRAFT", storyKind: "BUG" }),
		]);

		expect(entries).toHaveLength(2);
	});

	it("marks the personal override as the one in force", () => {
		const entries = groupPromptCatalogBindings([
			row("SYSTEM", true),
			row("USER", true),
		]);

		expect(entries[0].effectiveScope).toBe("USER");
		expect(entries[0].prompts.filter((p) => p.isEffective)).toHaveLength(1);
		expect(entries[0].prompts.find((p) => p.isEffective)?.scope).toBe(
			"USER",
		);
	});

	it("skips a tier whose binding is not marked default", () => {
		// This is what a cleared override looks like: the row is still listed,
		// but the tier below it is what actually runs.
		const entries = groupPromptCatalogBindings([
			row("ORG", false),
			row("SYSTEM", true),
		]);

		expect(entries[0].effectiveScope).toBe("SYSTEM");
		const org = entries[0].prompts.find((p) => p.scope === "ORG");
		expect(org).toBeDefined();
		expect(org?.isEffective).toBe(false);
	});

	it("reports no effective tier when nothing is marked default", () => {
		const entries = groupPromptCatalogBindings([
			row("ORG", false),
			row("SYSTEM", false),
		]);

		expect(entries[0].effectiveScope).toBeNull();
		expect(entries[0].prompts.every((p) => !p.isEffective)).toBe(true);
	});

	it("lists the strongest tier first", () => {
		const entries = groupPromptCatalogBindings([
			row("SYSTEM", true),
			row("USER", true),
			row("ORG", true),
		]);

		expect(entries[0].prompts.map((p) => p.scope)).toEqual([
			"USER",
			"ORG",
			"SYSTEM",
		]);
	});

	it("keeps every available prompt, not only the winner", () => {
		// FR5's question — what else could I pick — is answered from this list.
		const entries = groupPromptCatalogBindings([
			row("SYSTEM", true),
			row("SYSTEM", false),
			row("SYSTEM", false),
		]);

		expect(entries[0].prompts).toHaveLength(3);
	});

	it("returns nothing for no bindings", () => {
		expect(groupPromptCatalogBindings([])).toEqual([]);
	});
});
