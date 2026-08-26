/**
 * Every agent the seeds bind must exist in the prompt action catalog.
 *
 * The seeds are what actually create system prompt bindings; the catalog is what
 * the UI can show and re-bind. When they drift, the prompt an agent really uses
 * becomes invisible — not broken, which would be noticed, but unfindable, which
 * is not. That is exactly the state this test was written to end: the catalog
 * listed 13 agents while the seeds bound 30.
 *
 * The seed file is read as text rather than imported, because importing a seed
 * module runs a script that expects a database. The parse is therefore checked
 * before it is trusted: if the regex stops matching, this fails loudly instead
 * of passing with an empty set, which is the failure mode that would let the
 * drift back in.
 *
 * Run with:
 *   pnpm --filter @repo/database test __tests__/prompt-catalog-covers-seeds.test.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	listPromptActions,
	PROMPT_AGENT_TARGETS,
	promptActionId,
} from "@repo/utils/prompt-action-catalog";
import { describe, expect, it } from "vitest";

const SEED = readFileSync(
	join(__dirname, "..", "prisma", "seed-prompts-only.ts"),
	"utf8",
);

/**
 * Agents the seeds still bind but no code resolves any more. Each was checked
 * by grepping the whole repository for its key: zero runtime references, so
 * nothing reads a prompt for them and there is nothing for a user to configure.
 * Delete the seed rows and this list together; do not add to it to silence a
 * failure.
 */
const RETIRED_AGENTS = new Set([
	"code_reviewer_agent",
	"story_breakdown_agent",
	"task_planner_agent",
]);

/** Explicit `targetKey: "..."` plus the legacy `bindingTargetKey: "..."` form. */
function seededTargetKeys(): Set<string> {
	const keys = new Set<string>();
	for (const m of SEED.matchAll(/targetKey:\s*"([a-z0-9_]+)"/g)) {
		keys.add(m[1]);
	}
	for (const m of SEED.matchAll(/bindingTargetKey:\s*"([a-z0-9_]+)"/g)) {
		keys.add(m[1]);
	}
	// Entries with no explicit targetKey fall back to this one — see the
	// `bindingSpec.targetKey ?? "project_document_generator"` line in the seed.
	keys.add("project_document_generator");
	return keys;
}

type SeededSlot = {
	promptKey: string;
	targetKey: string;
	documentType: string;
	storyKind: "FEATURE" | "BUG" | null;
};

/**
 * Every `(targetKey, documentType, storyKind)` slot the seed binds, parsed from
 * the same text the agent-level parse reads.
 *
 * Agent-level coverage is not enough: a catalog entry that names the right
 * agent but declares the wrong document type or kind still strands every
 * binding written through the UI at the declared slot — nothing reads it, and
 * the runtime keeps resolving whatever sits at the seeded slot. That is how a
 * Feature Clean Spec default could be set from the UI and never take effect
 * (the catalog said DRAFT; the seed and every resolver say CLEAN_SPEC).
 */
function seededSlots(): SeededSlot[] {
	const sectionStart = SEED.indexOf(
		"const PROMPT_DOCUMENT_TYPE_BINDINGS: Record<string, SeedBindingSpec> = {",
	);
	expect(sectionStart).toBeGreaterThan(0);
	const sectionEnd = SEED.indexOf("\n};", sectionStart);
	const section = SEED.slice(sectionStart, sectionEnd);

	// Entries come in two shapes — one-line (`prd_template: { ... }`) and
	// multi-line with their own closing brace — so split on entry boundaries
	// rather than trying to match a whole entry with one regexp. A chunk is one
	// entry plus, possibly, the comment lines that follow it; every field below
	// is therefore read from its OWN declaration slice, never from the chunk as
	// a whole, because a neighbour's comment may quote words like CLEAN_SPEC.
	const slots: SeededSlot[] = [];
	const chunks = section.split(/\n\t(?=[A-Za-z0-9_]+: \{)/).slice(1);

	for (const chunk of chunks) {
		const keyMatch = chunk.match(/^([A-Za-z0-9_]+): \{/);
		if (!keyMatch) {
			continue;
		}

		const docSlice = chunk.match(/documentTypes:\s*\[([^\]]*)\]/);
		const kindMatch = chunk.match(
			/storyKind:\s*("FEATURE"|"BUG"|null)(?:\s+as\s+null)?/,
		);
		if (!docSlice || !kindMatch) {
			continue;
		}
		const docTypes = [...docSlice[1].matchAll(/"([A-Z_]+)"/g)].map(
			(d) => d[1],
		);
		if (docTypes.length === 0) {
			continue;
		}
		const targetMatch = chunk.match(/targetKey:\s*"([a-z0-9_]+)"/);

		const kind = kindMatch[1].replaceAll('"', "");
		for (const documentType of docTypes) {
			slots.push({
				promptKey: keyMatch[1],
				targetKey: targetMatch?.[1] ?? "project_document_generator",
				documentType,
				storyKind:
					kind === "FEATURE"
						? "FEATURE"
						: kind === "BUG"
							? "BUG"
							: null,
			});
		}
	}
	return slots;
}

describe("prompt action catalog covers the seeded agents", () => {
	const seeded = seededTargetKeys();
	const catalog = new Set(PROMPT_AGENT_TARGETS.map((a) => a.key));

	it("parsed a plausible number of keys from the seed file", () => {
		// Guards the guard. A regex that silently stops matching would make
		// every assertion below vacuously true.
		expect(seeded.size).toBeGreaterThan(15);
		expect(seeded.has("project_document_generator")).toBe(true);
		expect(seeded.has("test_case_drafter")).toBe(true);
	});

	it("has a catalog entry for every agent the seeds bind", () => {
		const missing = [...seeded]
			.filter((k) => !catalog.has(k))
			.filter((k) => !RETIRED_AGENTS.has(k))
			.sort();

		expect(
			missing,
			`Seeded agents with no entry in PROMPT_AGENT_TARGETS. A prompt bound to one of these cannot be found or re-bound from the UI:\n  ${missing.join("\n  ")}`,
		).toEqual([]);
	});

	it("does not list a retired agent as if it were live", () => {
		const revived = [...RETIRED_AGENTS].filter((k) => catalog.has(k));
		expect(
			revived,
			"These are in RETIRED_AGENTS but also in the catalog — pick one",
		).toEqual([]);
	});

	it("gives every catalog agent at least one action", () => {
		for (const agent of PROMPT_AGENT_TARGETS) {
			expect(agent.actions.length, agent.key).toBeGreaterThan(0);
		}
	});

	it("gives every catalog agent a unique key", () => {
		const keys = PROMPT_AGENT_TARGETS.map((a) => a.key);
		expect(new Set(keys).size).toBe(keys.length);
	});
});

describe("prompt action catalog covers the seeded slots", () => {
	const actions = listPromptActions();
	const actionIds = new Set(actions.map((a) => a.id));
	const slots = seededSlots();

	it("parsed a plausible number of seeded slots", () => {
		// Guards the guard, as above: a parse that silently stopped matching
		// would make the coverage assertion vacuous.
		expect(slots.length).toBeGreaterThan(40);
		const byKey = (k: string) => slots.filter((s) => s.promptKey === k);
		expect(byKey("bug_clean_spec_generator")).toEqual([
			{
				promptKey: "bug_clean_spec_generator",
				targetKey: "bug_clean_spec_generator",
				documentType: "CLEAN_SPEC",
				storyKind: "BUG",
			},
		]);
	});

	it("declares every slot the seeds bind", () => {
		const missing = slots
			.filter(
				(s) =>
					!actionIds.has(
						promptActionId(
							s.targetKey,
							s.documentType,
							s.storyKind,
						),
					),
			)
			.map(
				(s) =>
					`${s.promptKey} binds (${s.targetKey}, ${s.documentType}, ${s.storyKind ?? "null"}) — no such Action in the catalog`,
			)
			.sort();

		expect(
			missing,
			`Seeded binding slots with no catalog entry. A default set from the UI lands at the declared slot, which nothing then reads — the seeded prompt keeps running instead:\n  ${missing.join("\n  ")}`,
		).toEqual([]);
	});
});
