/**
 * One test per readiness rule (Fizzy #2165).
 *
 * Each case is named after its row in the approved spreadsheet and asserts both
 * directions: the evidence that satisfies the rule, and evidence that does not.
 * The pairing is deliberate — a rule that returns `true` unconditionally passes a
 * one-sided test, and that is exactly the failure mode the 19 August revision was
 * fixing across the sheet ("started" being mistaken for "worked").
 */

import { describe, expect, it } from "vitest";
import { READINESS_RULES, READINESS_RULES_BY_KEY } from "../registry";
import type { ReadinessEvidence } from "../types";
import { emptyEvidence } from "./evidence-fixture";

function withDocument(type: string): ReadinessEvidence {
	const e = emptyEvidence();
	e.completeDocumentTypes = new Set([type]);
	return e;
}

/** [rule key, evidence that satisfies it, evidence that must NOT satisfy it] */
const CASES: Array<[string, () => ReadinessEvidence, () => ReadinessEvidence]> =
	[
		[
			"feature-snapshot",
			() => ({ ...emptyEvidence(), featureCount: 1 }),
			emptyEvidence,
		],
		[
			"tech-stack",
			() => ({ ...emptyEvidence(), techStackCount: 3 }),
			emptyEvidence,
		],
		[
			"context-source",
			() => {
				const e = emptyEvidence();
				e.indexedContext.total = 1;
				return e;
			},
			emptyEvidence,
		],
		[
			"additional-context-sources",
			() => {
				const e = emptyEvidence();
				e.indexedContext.total = 2;
				return e;
			},
			// One indexed source is not "additional".
			() => {
				const e = emptyEvidence();
				e.indexedContext.total = 1;
				return e;
			},
		],
		[
			"chat-app-connected",
			() => {
				const e = emptyEvidence();
				e.chat.linkedChannelCount = 1;
				return e;
			},
			// A monitor switched on over zero linked channels is not a
			// connected chat app — it watches nothing.
			() => {
				const e = emptyEvidence();
				e.chat.slackChannelMonitorEnabled = true;
				return e;
			},
		],
		[
			"meeting-transcripts",
			() => {
				const e = emptyEvidence();
				e.indexedContext.meetingTranscripts = 1;
				return e;
			},
			emptyEvidence,
		],
		[
			"pm-system-connected",
			() => {
				const e = emptyEvidence();
				e.pm.connected = true;
				return e;
			},
			emptyEvidence,
		],
		[
			"codebase-connected",
			() => {
				const e = emptyEvidence();
				// `repositoryConnected` is now true for EITHER an active
				// repository integration or the legacy project column. Reading
				// only the legacy column reported "not connected" on projects
				// that plainly had a codebase, and silently hid Atlas, security
				// and release notes, which all depend on this item.
				e.code.repositoryConnected = true;
				e.code.analysisCompleted = true;
				return e;
			},
			// Connected but the analysis never finished — the whole point of the
			// 19 August tightening.
			() => {
				const e = emptyEvidence();
				e.code.repositoryConnected = true;
				return e;
			},
		],
		[
			"wiki-connected",
			() => {
				const e = emptyEvidence();
				e.indexedContext.notionSources = 1;
				return e;
			},
			emptyEvidence,
		],
		[
			"knowledge-base",
			() => {
				const e = emptyEvidence();
				e.indexedContext.knowledgeBaseLinks = 1;
				return e;
			},
			// A link exists but carries no Knowledge Base category.
			() => {
				const e = emptyEvidence();
				e.indexedContext.total = 1;
				return e;
			},
		],
		["business-case", () => withDocument("BUSINESS_CASE"), emptyEvidence],
		["proposal", () => withDocument("PROPOSAL"), emptyEvidence],
		["prd", () => withDocument("PRD"), emptyEvidence],
		["architecture", () => withDocument("ARCHITECTURE"), emptyEvidence],
		["api-spec", () => withDocument("API_SPEC"), emptyEvidence],
		["technical-spec", () => withDocument("TECHNICAL_SPEC"), emptyEvidence],
		["qa-strategy", () => withDocument("QA_STRATEGY"), emptyEvidence],
		[
			"roadmap-populated",
			() => ({ ...emptyEvidence(), roadmapItemCount: 1 }),
			emptyEvidence,
		],
		[
			"pm-sync-enabled",
			() => {
				const e = emptyEvidence();
				e.pm.connected = true;
				e.pm.autoPushEnabled = true;
				return e;
			},
			// Connected, auto-push on, but read-only mode blocks every write.
			() => {
				const e = emptyEvidence();
				e.pm.connected = true;
				e.pm.autoPushEnabled = true;
				e.pm.readOnlyMode = true;
				return e;
			},
		],
		[
			"terminal-statuses",
			// Statuses named, auto-close deliberately OFF — the item is
			// "terminal statuses DEFINED", and the list classifies linked items
			// whether or not closed ones are hidden from the Roadmap.
			() => {
				const e = emptyEvidence();
				e.pm.terminalStatusCount = 2;
				return e;
			},
			// Auto-close on but no statuses named.
			() => {
				const e = emptyEvidence();
				e.pm.autoCloseEnabled = true;
				return e;
			},
		],
		[
			"team-members",
			() => ({ ...emptyEvidence(), acceptedMemberCount: 2 }),
			// One accepted member is the owner alone.
			() => ({ ...emptyEvidence(), acceptedMemberCount: 1 }),
		],
		[
			"work-capture-transcripts",
			() => {
				const e = emptyEvidence();
				e.indexedContext.meetingTranscripts = 1;
				e.chat.transcriptAutoAnalyzeEnabled = true;
				return e;
			},
			// Transcripts exist but capture is switched off.
			() => {
				const e = emptyEvidence();
				e.indexedContext.meetingTranscripts = 1;
				return e;
			},
		],
		[
			"work-capture-chat",
			// Slack alone must satisfy this — the original rule named only the
			// Teams monitor, which made this Must unreachable on Slack projects.
			() => {
				const e = emptyEvidence();
				e.chat.linkedChannelCount = 1;
				e.chat.slackChannelMonitorEnabled = true;
				return e;
			},
			// Linked but not watched: the connection satisfies
			// `chat-app-connected`, never work capture.
			() => {
				const e = emptyEvidence();
				e.chat.linkedChannelCount = 1;
				return e;
			},
		],
		[
			"release-notes",
			() => ({ ...emptyEvidence(), newsletterEnabled: true }),
			emptyEvidence,
		],
		[
			"atlas-explored",
			() => {
				const e = emptyEvidence();
				e.code.analysisCompleted = true;
				e.code.atlasAnalysisExists = true;
				return e;
			},
			// Indexed, but nobody ever opened Atlas.
			() => {
				const e = emptyEvidence();
				e.code.analysisCompleted = true;
				return e;
			},
		],
		[
			"security-scan",
			() => ({ ...emptyEvidence(), successfulScanExists: true }),
			// A scan that ran and failed is not a completed scan.
			emptyEvidence,
		],
	];

describe("readiness rule registry", () => {
	it("carries the 26 items that survive onboarding extraction", () => {
		expect(READINESS_RULES).toHaveLength(26);
	});

	/**
	 * The sheet excludes three Project Basics rows because the creation form
	 * collects them, and since Fizzy #2165 it genuinely does — name, a
	 * description over the threshold, a phase, and a start date on Discovery.
	 * Grading them here as well would ask twice for the same answer.
	 */
	it("leaves the three creation owns to creation", () => {
		for (const key of [
			"project-description",
			"project-phase",
			"expected-development-start-date",
		]) {
			expect(READINESS_RULES_BY_KEY.has(key)).toBe(false);
		}
	});

	it("gives every rule a unique key", () => {
		const keys = READINESS_RULES.map((r) => r.key);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it("only ever references rules that exist", () => {
		for (const rule of READINESS_RULES) {
			for (const key of [
				...(rule.dependsOn ?? []),
				...(rule.supersededBy ?? []),
			]) {
				expect(READINESS_RULES_BY_KEY.has(key)).toBe(true);
			}
		}
	});

	it("has a test case for every registered rule", () => {
		const covered = new Set(CASES.map(([key]) => key));
		for (const rule of READINESS_RULES) {
			expect(covered.has(rule.key)).toBe(true);
		}
	});

	describe.each(CASES)("%s", (key, satisfying, unsatisfying) => {
		const rule = READINESS_RULES_BY_KEY.get(key);

		it("completes on evidence that satisfies it", () => {
			expect(rule).toBeDefined();
			expect(rule?.detect(satisfying())).toBe(true);
		});

		it("stays incomplete on evidence that does not", () => {
			expect(rule?.detect(unsatisfying())).toBe(false);
		});
	});
});
