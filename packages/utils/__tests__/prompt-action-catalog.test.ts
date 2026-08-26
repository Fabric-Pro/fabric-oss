/**
 * The Action grid the catalog browses and searches.
 *
 * An Action is the identity a PromptBinding row already carries — agent,
 * document type, and for a drafting stage the kind of work item. The two things
 * worth pinning are that the grid matches what can actually be BOUND (an Action
 * nothing can bind to is a dead end in the catalog), and that a stage files
 * under Work Items rather than under whichever agent happens to produce it.
 */

import { describe, expect, it } from "vitest";
import {
	bindableDocumentTypes,
	findPromptAgentTarget,
	listPromptActions,
	PROMPT_AGENT_TARGETS,
	PROMPT_FEATURE_TYPES,
	promptActionFeatureType,
	promptActionId,
} from "../lib/prompt-action-catalog";

const actions = listPromptActions();
const byId = (id: string) => actions.find((a) => a.id === id);

describe("listPromptActions", () => {
	it("gives every Action a unique id", () => {
		const ids = actions.map((a) => a.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("only lists Actions something can actually be bound to", () => {
		// The catalog's Tier 2 must not offer a combination the binding dialog
		// would refuse — that is a dead end for the user.
		for (const action of actions) {
			const agent = findPromptAgentTarget(action.targetKey);
			expect(agent, action.targetKey).toBeDefined();
			expect(
				bindableDocumentTypes(agent!, action.storyKind),
				action.id,
			).toContain(action.documentType);
		}
	});

	it("covers every agent", () => {
		const covered = new Set(actions.map((a) => a.targetKey));
		for (const agent of PROMPT_AGENT_TARGETS) {
			expect(covered.has(agent.key), agent.key).toBe(true);
		}
	});

	it("gives every Action a known feature type", () => {
		for (const action of actions) {
			expect(Object.keys(PROMPT_FEATURE_TYPES), action.id).toContain(
				action.featureType,
			);
		}
	});

	it("files a drafting stage under Work Items, not under its agent's area", () => {
		// project_document_generator is a PROJECT_DOCUMENTS agent, but "draft a
		// feature" belongs with work items or nobody will find it.
		const draft = byId(
			promptActionId("project_document_generator", "DRAFT", "FEATURE"),
		);
		expect(draft).toBeDefined();
		expect(draft?.featureType).toBe("WORK_ITEMS");

		const prd = byId(
			promptActionId("project_document_generator", "PRD", null),
		);
		expect(prd?.featureType).toBe("PROJECT_DOCUMENTS");
	});

	it("files the roadmap re-prioritisation runs under Roadmap, not Work Items", () => {
		// They drive the Priority view's re-ranking; "Work Items" is where
		// someone looks when an item itself is being worked.
		for (const key of [
			"priority_reprioritization",
			"priority_reprioritization_single",
		]) {
			const agent = findPromptAgentTarget(key);
			expect(promptActionFeatureType(agent!, "GENERAL"), key).toBe(
				"ROADMAP",
			);
		}
	});

	it("separates the same stage per work-item kind", () => {
		// Feature-at-DRAFT and Bug-at-DRAFT resolve different bindings, so they
		// are different things to configure.
		expect(
			byId(
				promptActionId(
					"project_document_generator",
					"DRAFT",
					"FEATURE",
				),
			),
		).toBeDefined();
		expect(
			byId(promptActionId("project_document_generator", "DRAFT", "BUG")),
		).toBeDefined();
	});

	it("does not offer a feature-only stage for a bug", () => {
		expect(
			byId(
				promptActionId(
					"project_document_generator",
					"SANITY_CHECK",
					"BUG",
				),
			),
		).toBeUndefined();
	});

	it("names a GENERAL-only agent by the agent alone", () => {
		// "Test Case Drafter — General" reads as though there were another one.
		const action = byId(
			promptActionId("test_case_drafter", "GENERAL", null),
		);
		expect(action?.label).toBe("Test Case Drafter");
	});

	it("distinguishes a multi-document agent's Actions by document type", () => {
		const prd = byId(promptActionId("document_generator", "PRD", null));
		const architecture = byId(
			promptActionId("document_generator", "ARCHITECTURE", null),
		);

		expect(prd?.label).toContain("PRD");
		expect(architecture?.label).toContain("Architecture");
		expect(prd?.label).not.toBe(architecture?.label);
	});

	it("names the kind when a stage Action is kind-scoped", () => {
		const action = byId(
			promptActionId("project_document_generator", "DRAFT", "BUG"),
		);
		expect(action?.label).toMatch(/bug/i);
	});
});

describe("promptActionFeatureType", () => {
	it("uses the agent's area for a non-stage document type", () => {
		const agent = findPromptAgentTarget("pr_review_qa");
		expect(promptActionFeatureType(agent!, "GENERAL")).toBe("QUALITY");
	});

	it("uses Work Items for a stage whatever the agent's area", () => {
		const agent = findPromptAgentTarget("project_document_generator");
		expect(promptActionFeatureType(agent!, "SANITY_CHECK")).toBe(
			"WORK_ITEMS",
		);
	});
});
