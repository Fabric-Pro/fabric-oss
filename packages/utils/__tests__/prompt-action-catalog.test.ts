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
import { PUBLISHING_BLOG_POST_AGENT_KEY } from "../lib/publishing-blog-post-prompt";
import { PUBLISHING_CASE_STUDY_AGENT_KEY } from "../lib/publishing-case-study-prompt";
import { PUBLISHING_LINKEDIN_POST_AGENT_KEY } from "../lib/publishing-linkedin-post-prompt";
import { PUBLISHING_PLANNING_ANALYSIS_AGENT_KEY } from "../lib/publishing-planning-prompt";
import { PUBLISHING_SHORT_POST_AGENT_KEY } from "../lib/publishing-short-post-prompt";
import { PUBLISHING_STAKEHOLDER_EMAIL_AGENT_KEY } from "../lib/publishing-stakeholder-email-prompt";
import { PUBLISHING_TOPIC_SUGGESTION_AGENT_KEY } from "../lib/publishing-suggestion-prompt";

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

describe("Publishing Suite prompts (#1851, #1853, #1854)", () => {
	// The agent key must be the SAME string in the seed's SYSTEM prompt, the
	// seed's binding, this catalog, and the Temporal activity that resolves the
	// binding. A mismatch resolves no binding and silently falls back to the
	// default body forever — the hazard `meeting_agenda_generator` documents but
	// does not close, since it repeats its literal in every one of those places.
	//
	// Here all four import one constant, so drift is impossible rather than
	// detectable, and this test guards the remaining hole: someone re-hardcoding
	// the string in the catalog.
	it("files the planning prompt under Publishing Suite by the shared key", () => {
		const target = findPromptAgentTarget(
			PUBLISHING_PLANNING_ANALYSIS_AGENT_KEY,
		);
		expect(target).toBeDefined();
		expect(target?.featureType).toBe("PUBLISHING");
	});

	it("is bound for GENERAL with no story kind", () => {
		// One prompt per tenant covers every project and topic. A stage-scoped or
		// kind-scoped binding would make the activity's exact-match resolution
		// (documentType GENERAL, storyKind null) find nothing.
		const target = findPromptAgentTarget(
			PUBLISHING_PLANNING_ANALYSIS_AGENT_KEY,
		);
		expect(target?.actions).toEqual([
			{ documentType: "GENERAL", storyKind: null },
		]);
	});

	// The topic suggestion prompt (FR7) is the sixth member and the last of the
	// suite's AI steps to become editable at all. Same three-site hazard, same
	// silence when it bites: a key that does not match resolves no binding, and
	// every daily cycle then runs the default body forever while looking normal.
	it("files the topic suggestion prompt under Publishing Suite by the shared key", () => {
		const target = findPromptAgentTarget(
			PUBLISHING_TOPIC_SUGGESTION_AGENT_KEY,
		);
		expect(target).toBeDefined();
		expect(target?.featureType).toBe("PUBLISHING");
	});

	it("binds the topic suggestion prompt for GENERAL with no story kind", () => {
		// `summarizeTopicSuggestions` resolves by exact match on (documentType
		// GENERAL, storyKind null) — and a cycle has no story kind to scope by.
		const target = findPromptAgentTarget(
			PUBLISHING_TOPIC_SUGGESTION_AGENT_KEY,
		);
		expect(target?.actions).toEqual([
			{ documentType: "GENERAL", storyKind: null },
		]);
	});

	// The short post prompt (2B-2) carries the SAME three-site hazard the
	// planning prompt does — seed, catalog and the Temporal activity that
	// resolves the binding — and it is a silent one: a key that does not match
	// resolves no binding, so every run falls back to the default body forever
	// and the output looks entirely normal. All three import one constant, which
	// makes drift impossible rather than detectable; these two cases guard the
	// remaining hole, which is someone re-hardcoding the string in the catalog.
	it("files the short post prompt under Publishing Suite by the shared key", () => {
		const target = findPromptAgentTarget(PUBLISHING_SHORT_POST_AGENT_KEY);
		expect(target).toBeDefined();
		expect(target?.featureType).toBe("PUBLISHING");
	});

	it("binds the short post prompt for GENERAL with no story kind", () => {
		// The activity resolves by exact match on (documentType GENERAL,
		// storyKind null). A stage-scoped or kind-scoped binding would find
		// nothing, and finding nothing is the fallback path, not an error.
		const target = findPromptAgentTarget(PUBLISHING_SHORT_POST_AGENT_KEY);
		expect(target?.actions).toEqual([
			{ documentType: "GENERAL", storyKind: null },
		]);
	});

	// The LinkedIn prompt is a SEPARATE key from the short post's on purpose:
	// the two platforms impose opposite constraints (LinkedIn folds behind
	// "see more" and caps nothing, X caps hard and folds nothing), so they are
	// two prompts rather than one behind a label. That makes the copy-paste
	// hazard sharper here than anywhere else in the family — the two bodies are
	// structurally near-identical — and the uniqueness case at the bottom of
	// this file is what actually catches it.
	it("files the LinkedIn post prompt under Publishing Suite by the shared key", () => {
		const target = findPromptAgentTarget(
			PUBLISHING_LINKEDIN_POST_AGENT_KEY,
		);
		expect(target).toBeDefined();
		expect(target?.featureType).toBe("PUBLISHING");
	});

	it("binds the LinkedIn post prompt for GENERAL with no story kind", () => {
		const target = findPromptAgentTarget(
			PUBLISHING_LINKEDIN_POST_AGENT_KEY,
		);
		expect(target?.actions).toEqual([
			{ documentType: "GENERAL", storyKind: null },
		]);
	});

	// The blog post prompt (2B-3) carries the same hazard as the two above, and
	// shipped with no case of its own at all — the two below are that backfill.
	it("files the blog post prompt under Publishing Suite by the shared key", () => {
		const target = findPromptAgentTarget(PUBLISHING_BLOG_POST_AGENT_KEY);
		expect(target).toBeDefined();
		expect(target?.featureType).toBe("PUBLISHING");
	});

	it("binds the blog post prompt for GENERAL with no story kind", () => {
		// Same exact-match resolution as its siblings: (documentType GENERAL,
		// storyKind null). Anything narrower resolves nothing, and resolving
		// nothing is the silent fallback path rather than an error.
		const target = findPromptAgentTarget(PUBLISHING_BLOG_POST_AGENT_KEY);
		expect(target?.actions).toEqual([
			{ documentType: "GENERAL", storyKind: null },
		]);
	});

	// The case study prompt (2C) is the fourth member of the family and carries
	// the identical three-site hazard: seed SYSTEM prompt, seed binding, catalog
	// entry and the Temporal activity must all name one key.
	it("files the case study prompt under Publishing Suite by the shared key", () => {
		const target = findPromptAgentTarget(PUBLISHING_CASE_STUDY_AGENT_KEY);
		expect(target).toBeDefined();
		expect(target?.featureType).toBe("PUBLISHING");
	});

	it("binds the case study prompt for GENERAL with no story kind", () => {
		// One prompt per tenant covers every project and topic, and the activity
		// resolves by exact match on (documentType GENERAL, storyKind null).
		const target = findPromptAgentTarget(PUBLISHING_CASE_STUDY_AGENT_KEY);
		expect(target?.actions).toEqual([
			{ documentType: "GENERAL", storyKind: null },
		]);
	});

	// The stakeholder email prompt (2C slice 2) is the fifth member, with the
	// identical three-site hazard: seed SYSTEM prompt, seed binding, catalog
	// entry and the Temporal activity must all name one key.
	it("files the stakeholder email prompt under Publishing Suite by the shared key", () => {
		const target = findPromptAgentTarget(
			PUBLISHING_STAKEHOLDER_EMAIL_AGENT_KEY,
		);
		expect(target).toBeDefined();
		expect(target?.featureType).toBe("PUBLISHING");
	});

	it("binds the stakeholder email prompt for GENERAL with no story kind", () => {
		const target = findPromptAgentTarget(
			PUBLISHING_STAKEHOLDER_EMAIL_AGENT_KEY,
		);
		expect(target?.actions).toEqual([
			{ documentType: "GENERAL", storyKind: null },
		]);
	});

	it("keeps every publishing prompt under a DIFFERENT key", () => {
		// Every one of them is PUBLISHING/GENERAL/null, so a copy-paste that
		// left a sibling's key on another entry would satisfy every other case
		// in this file — and would silently route one content type's generation
		// to another's prompt. Uniqueness across the whole set is the only check
		// that catches it whichever pair was duplicated.
		//
		// A new member of the family must be added to this array. Leaving it out
		// keeps the case green while it stops covering the key that was just
		// added, which is the failure this whole file exists to prevent.
		const keys = [
			PUBLISHING_TOPIC_SUGGESTION_AGENT_KEY,
			PUBLISHING_PLANNING_ANALYSIS_AGENT_KEY,
			PUBLISHING_SHORT_POST_AGENT_KEY,
			PUBLISHING_LINKEDIN_POST_AGENT_KEY,
			PUBLISHING_BLOG_POST_AGENT_KEY,
			PUBLISHING_CASE_STUDY_AGENT_KEY,
			PUBLISHING_STAKEHOLDER_EMAIL_AGENT_KEY,
		];
		expect(new Set(keys).size).toBe(keys.length);
	});

	it("gives Publishing Suite a tier-1 area of its own", () => {
		// It is a nav area in the product, so filing its prompt under Meetings or
		// Project Documents would be the invention the catalog's own rule warns
		// against: tier 1 follows the areas the app already has.
		expect(PROMPT_FEATURE_TYPES.PUBLISHING).toBeDefined();
	});
});
