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
import { AGENT_TASK_PROMPT_AGENT_KEY } from "../lib/agent-task-prompt";
import {
	COMPLETION_CLAIM_CORRECTION_AGENT_KEY,
	COMPLETION_CLAIM_JUDGE_AGENT_KEY,
} from "../lib/completion-claim-prompts";
import { DIRECT_CHAT_MEMORY_PROMPT_AGENT_KEY } from "../lib/direct-chat-memory-prompt";
import { ORCHESTRATOR_MEMORY_PROMPT_AGENT_KEY } from "../lib/orchestrator-memory-prompt";
import { PAGE_ASK_PROMPT_AGENT_KEY } from "../lib/page-ask-prompt";
import {
	bindableDocumentTypes,
	findPromptAgentTarget,
	isSupersededPromptAction,
	listOfferedPromptActions,
	listPromptActions,
	offeredDocumentTypes,
	PROMPT_AGENT_TARGETS,
	PROMPT_FEATURE_TYPES,
	PROPOSAL_CLIENT_MAIN_AGENT_KEY,
	PROPOSAL_CLIENT_REVISION_AGENT_KEY,
	PROPOSAL_INTERNAL_ANALYSIS_AGENT_KEY,
	promptActionFeatureType,
	promptActionId,
} from "../lib/prompt-action-catalog";
import { PUBLISHING_BLOG_POST_AGENT_KEY } from "../lib/publishing-blog-post-prompt";
import { PUBLISHING_CASE_STUDY_AGENT_KEY } from "../lib/publishing-case-study-prompt";
import { PUBLISHING_LINKEDIN_POST_AGENT_KEY } from "../lib/publishing-linkedin-post-prompt";
import { PUBLISHING_NEWSLETTER_BLURB_AGENT_KEY } from "../lib/publishing-newsletter-blurb-prompt";
import { PUBLISHING_PLANNING_ANALYSIS_AGENT_KEY } from "../lib/publishing-planning-prompt";
import { PUBLISHING_SHORT_POST_AGENT_KEY } from "../lib/publishing-short-post-prompt";
import { PUBLISHING_STAKEHOLDER_EMAIL_AGENT_KEY } from "../lib/publishing-stakeholder-email-prompt";
import { PUBLISHING_TOPIC_SUGGESTION_AGENT_KEY } from "../lib/publishing-suggestion-prompt";
import { PUBLISHING_WEBINAR_SCRIPT_AGENT_KEY } from "../lib/publishing-webinar-script-prompt";

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

	// The webinar / demo script prompt (2D slice 1) is the sixth member and
	// carries the identical three-site hazard: seed SYSTEM prompt, seed
	// binding, catalog entry and the Temporal activity must all name one key.
	it("exposes the webinar script prompt as an editable PUBLISHING target", () => {
		const target = PROMPT_AGENT_TARGETS.find(
			(t) => t.key === PUBLISHING_WEBINAR_SCRIPT_AGENT_KEY,
		);
		expect(target).toBeDefined();
		expect(target?.featureType).toBe("PUBLISHING");
		// Assert the SHAPE, not `nonStage(...)` — that helper is a bare `const` at
		// prompt-action-catalog.ts:163 and is not exported, so calling it here is a
		// ReferenceError that would masquerade as the expected TDD red.
		expect(target?.actions).toEqual([
			{ documentType: "GENERAL", storyKind: null },
		]);
	});

	// The newsletter blurb prompt (2D slice 2) is the seventh member and
	// carries the identical three-site hazard: seed SYSTEM prompt, seed
	// binding, catalog entry and the Temporal activity must all name one key.
	it("exposes the newsletter blurb prompt as an editable PUBLISHING target", () => {
		const target = PROMPT_AGENT_TARGETS.find(
			(t) => t.key === PUBLISHING_NEWSLETTER_BLURB_AGENT_KEY,
		);
		expect(target).toBeDefined();
		expect(target?.featureType).toBe("PUBLISHING");
		// Assert the SHAPE, not `nonStage(...)` — that helper is a bare `const` at
		// prompt-action-catalog.ts:163 and is not exported, so calling it here is a
		// ReferenceError that would masquerade as the expected TDD red.
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
			PUBLISHING_WEBINAR_SCRIPT_AGENT_KEY,
			PUBLISHING_NEWSLETTER_BLURB_AGENT_KEY,
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

describe("coordinated Proposal prompt actions (Fizzy #2801)", () => {
	it.each([
		[PROPOSAL_CLIENT_MAIN_AGENT_KEY, "Client proposal (Main)"],
		[PROPOSAL_CLIENT_REVISION_AGENT_KEY, "Client proposal (revision)"],
		[PROPOSAL_INTERNAL_ANALYSIS_AGENT_KEY, "Proposal internal analysis"],
	])(
		"lists %s under Project Documents, bindable for PROPOSAL only",
		(key, label) => {
			const target = findPromptAgentTarget(key);
			expect(target?.label).toBe(label);
			expect(target?.featureType).toBe("PROJECT_DOCUMENTS");
			expect(target?.actions).toEqual([
				{ documentType: "PROPOSAL", storyKind: null },
			]);
			expect(byId(promptActionId(key, "PROPOSAL", null))).toMatchObject({
				targetKey: key,
				featureType: "PROJECT_DOCUMENTS",
			});
		},
	);

	it("keeps the Proposal actions apart from each other and from the Draft flow's PROPOSAL action", () => {
		// All resolve at (PROPOSAL, null); only the agent key tells the client
		// document, its revision, its analysis and the Draft prompt apart.
		const keys = [
			PROPOSAL_CLIENT_MAIN_AGENT_KEY,
			PROPOSAL_CLIENT_REVISION_AGENT_KEY,
			PROPOSAL_INTERNAL_ANALYSIS_AGENT_KEY,
			"project_document_generator",
		];
		expect(new Set(keys).size).toBe(keys.length);
		const draftAgent = findPromptAgentTarget("project_document_generator");
		expect(
			draftAgent ? bindableDocumentTypes(draftAgent, null) : [],
		).toContain("PROPOSAL");
	});
});

describe("Workflow Agent Task prompt", () => {
	// An agent the seed binds and the catalog omits is a prompt nobody can find
	// or re-bind from the UI, so the unattended agent's instructions would be
	// editable in the database and nowhere else.
	it("is bindable from the prompt library under Workflows & Automation", () => {
		const target = findPromptAgentTarget(AGENT_TASK_PROMPT_AGENT_KEY);

		expect(target?.label).toBe("Workflow Agent Task");
		expect(target?.featureType).toBe("AUTOMATION");
		expect(PROMPT_FEATURE_TYPES.AUTOMATION).toBeDefined();
	});

	it("is bound for GENERAL with no story kind, where the step resolves it", () => {
		// The step resolves (documentType GENERAL, storyKind null) exactly; any
		// other slot would be one it never reads.
		expect(
			findPromptAgentTarget(AGENT_TASK_PROMPT_AGENT_KEY)?.actions,
		).toEqual([{ documentType: "GENERAL", storyKind: null }]);
		expect(
			byId(promptActionId(AGENT_TASK_PROMPT_AGENT_KEY, "GENERAL", null)),
		).toBeDefined();
	});
});

describe("Workspace Page Ask prompt", () => {
	// A prompt the seed binds and the catalog omits is one nobody can find or
	// re-bind from the UI.
	it("is bindable from the prompt library under Workspaces", () => {
		const target = findPromptAgentTarget(PAGE_ASK_PROMPT_AGENT_KEY);

		expect(target?.label).toBe("Workspace Page Ask");
		expect(target?.featureType).toBe("WORKSPACES");
		expect(PROMPT_FEATURE_TYPES.WORKSPACES).toBeDefined();
	});

	it("is bound for GENERAL with no story kind, where the service resolves it", () => {
		expect(
			findPromptAgentTarget(PAGE_ASK_PROMPT_AGENT_KEY)?.actions,
		).toEqual([{ documentType: "GENERAL", storyKind: null }]);
		expect(
			byId(promptActionId(PAGE_ASK_PROMPT_AGENT_KEY, "GENERAL", null)),
		).toMatchObject({ featureType: "WORKSPACES" });
	});
});

describe("Assistant prompts", () => {
	// The memory rules and the completion-claim check must be findable and
	// re-bindable from the UI, at the one slot each activity resolves.
	for (const [key, label] of [
		[
			ORCHESTRATOR_MEMORY_PROMPT_AGENT_KEY,
			"Assistant Memory (Orchestrator)",
		],
		[DIRECT_CHAT_MEMORY_PROMPT_AGENT_KEY, "Assistant Memory (Direct)"],
		[COMPLETION_CLAIM_JUDGE_AGENT_KEY, "Assistant Completion Claim Check"],
		[
			COMPLETION_CLAIM_CORRECTION_AGENT_KEY,
			"Assistant Completion Claim Correction",
		],
	] as const) {
		it(`${key} is bindable under Assistant for GENERAL with no story kind`, () => {
			const target = findPromptAgentTarget(key);

			expect(target?.label).toBe(label);
			expect(target?.featureType).toBe("ASSISTANT");
			expect(PROMPT_FEATURE_TYPES.ASSISTANT).toBeDefined();
			expect(target?.actions).toEqual([
				{ documentType: "GENERAL", storyKind: null },
			]);
		});
	}
});

describe("actions the Proposal artifact supersedes (Fizzy #2946)", () => {
	const LEGACY_DRAFT = promptActionId(
		"project_document_generator",
		"PROPOSAL",
		null,
	);
	const LEGACY_GENERATOR = promptActionId(
		"document_generator",
		"PROPOSAL",
		null,
	);
	const MAIN = promptActionId(
		PROPOSAL_CLIENT_MAIN_AGENT_KEY,
		"PROPOSAL",
		null,
	);
	const ANALYSIS = promptActionId(
		PROPOSAL_INTERNAL_ANALYSIS_AGENT_KEY,
		"PROPOSAL",
		null,
	);
	const REVISION = promptActionId(
		PROPOSAL_CLIENT_REVISION_AGENT_KEY,
		"PROPOSAL",
		null,
	);
	const PRD = promptActionId("project_document_generator", "PRD", null);
	const agentFor = (key: string) => {
		const agent = findPromptAgentTarget(key);
		if (!agent) {
			throw new Error(`No catalog agent ${key}`);
		}
		return agent;
	};

	it("supersedes exactly the two legacy Proposal actions with the gate on", () => {
		const offered = listOfferedPromptActions(true).map((a) => a.id);
		const removed = actions
			.map((a) => a.id)
			.filter((id) => !offered.includes(id));
		expect(removed.sort()).toEqual([LEGACY_GENERATOR, LEGACY_DRAFT].sort());
	});

	it("keeps Client proposal (Main), its revision, the internal analysis and every other document offered", () => {
		const offered = listOfferedPromptActions(true).map((a) => a.id);

		expect(offered).toContain(MAIN);
		expect(offered).toContain(REVISION);
		expect(offered).toContain(ANALYSIS);
		expect(offered).toContain(PRD);
		expect(
			isSupersededPromptAction(
				PROPOSAL_CLIENT_MAIN_AGENT_KEY,
				"PROPOSAL",
				true,
			),
		).toBe(false);
		expect(
			isSupersededPromptAction(
				PROPOSAL_CLIENT_REVISION_AGENT_KEY,
				"PROPOSAL",
				true,
			),
		).toBe(false);
		expect(
			isSupersededPromptAction("project_document_generator", "PRD", true),
		).toBe(false);
	});

	it("labels an offered action exactly as the full list does", () => {
		for (const action of listOfferedPromptActions(true)) {
			expect(action).toEqual(byId(action.id));
		}
	});

	it("supersedes nothing with the gate off", () => {
		expect(listOfferedPromptActions(false)).toEqual(listPromptActions());
		expect(
			isSupersededPromptAction(
				"project_document_generator",
				"PROPOSAL",
				false,
			),
		).toBe(false);
	});

	it("drops Proposal from the legacy agents' document types only with the gate on", () => {
		const draftAgent = agentFor("project_document_generator");
		const generator = agentFor("document_generator");
		const main = agentFor(PROPOSAL_CLIENT_MAIN_AGENT_KEY);

		expect(offeredDocumentTypes(draftAgent, null, true)).not.toContain(
			"PROPOSAL",
		);
		expect(offeredDocumentTypes(draftAgent, null, true)).toContain("PRD");
		expect(offeredDocumentTypes(generator, null, true)).toEqual([
			"GENERAL",
			"PRD",
			"ARCHITECTURE",
		]);
		expect(offeredDocumentTypes(main, null, true)).toEqual(["PROPOSAL"]);
		expect(
			offeredDocumentTypes(
				agentFor(PROPOSAL_CLIENT_REVISION_AGENT_KEY),
				null,
				true,
			),
		).toEqual(["PROPOSAL"]);
		expect(offeredDocumentTypes(draftAgent, null, false)).toEqual(
			bindableDocumentTypes(draftAgent, null),
		);
	});

	it("leaves the complete list and the agent table untouched", () => {
		// The rule shapes what is offered; the catalog itself, which the seeds
		// coverage test and the binding readers lean on, keeps every slot.
		expect(actions.map((a) => a.id)).toContain(LEGACY_DRAFT);
		expect(actions.map((a) => a.id)).toContain(LEGACY_GENERATOR);
		expect(
			bindableDocumentTypes(agentFor("project_document_generator"), null),
		).toContain("PROPOSAL");
		expect(
			PROMPT_AGENT_TARGETS.find((a) => a.key === "document_generator")
				?.actions,
		).toContainEqual({ documentType: "PROPOSAL", storyKind: null });
	});
});
