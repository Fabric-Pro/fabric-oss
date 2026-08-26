/**
 * Which prompt the library should badge as "Default", and at which tier.
 *
 * The rule the product states is Personal > Org > Universal, and the part that
 * is easy to get wrong is what happens to the *losers*. If a personal override
 * exists, the system default it shadows must stop reporting itself as the
 * default — otherwise the library shows two prompts both badged "Default" and
 * tells the user nothing about which one actually runs.
 *
 * Equally easy to get wrong in the other direction: precedence is resolved per
 * TARGET. Two different agents having different defaults for the same document
 * type is normal, and collapsing to one winner overall would hide one of them.
 *
 * Run with:
 *   pnpm --filter @repo/database test __tests__/prompt-binding-status.test.ts
 */

import { describe, expect, it } from "vitest";
import { resolvePromptBindingStatus } from "../prisma/queries/prompts";

const binding = (
	promptId: string,
	scope: "SYSTEM" | "ORG" | "USER",
	isDefault: boolean,
	targetKey = "test_case_drafter",
) => ({ promptId, targetKey, scope, isDefault });

describe("resolvePromptBindingStatus", () => {
	it("reports the tier the default came from", () => {
		const status = resolvePromptBindingStatus([
			binding("p-system", "SYSTEM", true),
		]);

		expect(status.get("p-system")).toEqual({
			isDefault: true,
			isBound: true,
			defaultScope: "SYSTEM",
		});
	});

	it("lets a personal override shadow the system default", () => {
		// This is the case the library got wrong: both prompts carried the
		// "Default" badge, so the user could not tell which one ran.
		const status = resolvePromptBindingStatus([
			binding("p-system", "SYSTEM", true),
			binding("p-mine", "USER", true),
		]);

		expect(status.get("p-mine")?.isDefault).toBe(true);
		expect(status.get("p-mine")?.defaultScope).toBe("USER");

		expect(status.get("p-system")?.isDefault).toBe(false);
		expect(status.get("p-system")?.defaultScope).toBeNull();
		// It is still bound and still selectable — just not the default.
		expect(status.get("p-system")?.isBound).toBe(true);
	});

	it("lets an org default shadow the system default", () => {
		const status = resolvePromptBindingStatus([
			binding("p-system", "SYSTEM", true),
			binding("p-org", "ORG", true),
		]);

		expect(status.get("p-org")?.defaultScope).toBe("ORG");
		expect(status.get("p-system")?.isDefault).toBe(false);
	});

	it("applies personal over org over universal all at once", () => {
		const status = resolvePromptBindingStatus([
			binding("p-system", "SYSTEM", true),
			binding("p-org", "ORG", true),
			binding("p-mine", "USER", true),
		]);

		expect(status.get("p-mine")?.defaultScope).toBe("USER");
		expect(status.get("p-org")?.isDefault).toBe(false);
		expect(status.get("p-system")?.isDefault).toBe(false);
	});

	it("keeps a separate winner per target", () => {
		// Two agents, each with its own default. Collapsing to a single winner
		// would wrongly un-default one of them.
		const status = resolvePromptBindingStatus([
			binding("p-a", "SYSTEM", true, "test_case_drafter"),
			binding("p-b", "SYSTEM", true, "work_item_classifier"),
		]);

		expect(status.get("p-a")?.isDefault).toBe(true);
		expect(status.get("p-b")?.isDefault).toBe(true);
	});

	it("shadows only within the target that was overridden", () => {
		const status = resolvePromptBindingStatus([
			binding("p-a", "SYSTEM", true, "test_case_drafter"),
			binding("p-mine", "USER", true, "test_case_drafter"),
			binding("p-b", "SYSTEM", true, "work_item_classifier"),
		]);

		expect(status.get("p-mine")?.isDefault).toBe(true);
		expect(status.get("p-a")?.isDefault).toBe(false);
		// Untouched target keeps its system default.
		expect(status.get("p-b")?.isDefault).toBe(true);
		expect(status.get("p-b")?.defaultScope).toBe("SYSTEM");
	});

	it("marks a bound non-default prompt as available, not default", () => {
		const status = resolvePromptBindingStatus([
			binding("p-system", "SYSTEM", true),
			binding("p-extra", "SYSTEM", false),
		]);

		expect(status.get("p-extra")).toEqual({
			isDefault: false,
			isBound: true,
			defaultScope: null,
		});
	});

	it("returns nothing for a prompt with no bindings", () => {
		const status = resolvePromptBindingStatus([]);
		expect(status.get("p-unbound")).toBeUndefined();
	});

	it("keeps the best tier when one prompt wins several targets", () => {
		const status = resolvePromptBindingStatus([
			binding("p-shared", "SYSTEM", true, "test_case_drafter"),
			binding("p-shared", "USER", true, "work_item_classifier"),
		]);

		// The strongest claim it holds is the personal one.
		expect(status.get("p-shared")?.defaultScope).toBe("USER");
	});
});

/**
 * `storyKind` is a real dimension of a binding, not decoration: the runtime
 * resolver matches it exactly and will NOT fall back from BUG to FEATURE. Two
 * bindings for the same agent and document type but different kinds are
 * therefore two separate slots, each with its own winner.
 *
 * Ranking them against each other produces a badge that contradicts what runs:
 * the loser is reported as not-default even though it is the only prompt bound
 * for its own kind.
 */
describe("resolvePromptBindingStatus — per story kind", () => {
	const kindBinding = (
		promptId: string,
		scope: "SYSTEM" | "ORG" | "USER",
		storyKind: "FEATURE" | "BUG" | null,
	) => ({
		promptId,
		targetKey: "project_document_generator",
		documentType: "DRAFT",
		storyKind,
		scope,
		isDefault: true,
	});

	it("keeps a separate winner for each story kind", () => {
		// The org's FEATURE prompt and a personal BUG prompt do not compete:
		// neither can ever be resolved for the other's kind.
		const status = resolvePromptBindingStatus([
			kindBinding("p-feature", "ORG", "FEATURE"),
			kindBinding("p-bug", "USER", "BUG"),
		]);

		expect(status.get("p-feature")?.isDefault).toBe(true);
		expect(status.get("p-feature")?.defaultScope).toBe("ORG");
		expect(status.get("p-bug")?.isDefault).toBe(true);
		expect(status.get("p-bug")?.defaultScope).toBe("USER");
	});

	it("still shadows within one story kind", () => {
		const status = resolvePromptBindingStatus([
			kindBinding("p-system", "SYSTEM", "BUG"),
			kindBinding("p-personal", "USER", "BUG"),
		]);

		expect(status.get("p-personal")?.isDefault).toBe(true);
		expect(status.get("p-system")?.isDefault).toBe(false);
	});

	it("treats a non-stage binding as its own slot", () => {
		// storyKind null is not "any kind" — it is the non-stage binding, and
		// the resolver matches it exactly like the others.
		const status = resolvePromptBindingStatus([
			kindBinding("p-null", "SYSTEM", null),
			kindBinding("p-feature", "USER", "FEATURE"),
		]);

		expect(status.get("p-null")?.isDefault).toBe(true);
		expect(status.get("p-feature")?.isDefault).toBe(true);
	});
});
