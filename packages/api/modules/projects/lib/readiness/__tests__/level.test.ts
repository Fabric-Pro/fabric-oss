/**
 * Readiness level calculation (Fizzy #2165).
 *
 * These tests are the specification for the four decisions the requirements left
 * open. If the PO rules differently on any of them, the change lands here and in
 * `level.ts` and nowhere else — which is the entire reason the calculation is a
 * pure function with no I/O.
 */

import { describe, expect, it } from "vitest";
import { type ManualStateInput, resolveReadiness } from "../level";
import { READINESS_RULES } from "../registry";
import type { ReadinessEvidence } from "../types";
import {
	emptyEvidence,
	evidenceWithRepositoryIntegration,
} from "./evidence-fixture";

const NOW = new Date("2026-08-20T12:00:00Z");
const VIEWER = "user-1";
const TEAMMATE = "user-2";

/** Evidence for a Development project where every rule detects complete. */
function fullySetUp(): ReadinessEvidence {
	const e = emptyEvidence();
	e.phase = "DEVELOPMENT_EXECUTION";
	e.featureCount = 3;
	e.techStackCount = 4;
	e.indexedContext = {
		total: 5,
		meetingTranscripts: 2,
		knowledgeBaseLinks: 1,
		notionSources: 1,
	};
	e.chat = {
		linkedChannelCount: 1,
		slackChannelMonitorEnabled: true,
		teamsChannelMonitorEnabled: true,
		teamsChatMonitorEnabled: true,
		transcriptAutoAnalyzeEnabled: true,
	};
	e.pm = {
		connected: true,
		autoPushEnabled: true,
		readOnlyMode: false,
		autoCloseEnabled: true,
		terminalStatusCount: 2,
	};
	e.code = {
		repositoryConnected: true,
		analysisCompleted: true,
		atlasAnalysisExists: true,
	};
	e.completeDocumentTypes = new Set([
		"BUSINESS_CASE",
		"PROPOSAL",
		"PRD",
		"ARCHITECTURE",
		"API_SPEC",
		"TECHNICAL_SPEC",
		"QA_STRATEGY",
	]);
	e.descriptionLength = 120;
	e.acceptedMemberCount = 4;
	e.roadmapItemCount = 12;
	e.successfulScanExists = true;
	e.newsletterEnabled = true;
	return e;
}

function resolve(
	evidence: ReadinessEvidence,
	manualStates: ManualStateInput[] = [],
	viewerUserId = VIEWER,
) {
	return resolveReadiness({ evidence, manualStates, viewerUserId, now: NOW });
}

const notApplicable = (itemKey: string): ManualStateInput => ({
	itemKey,
	state: "NOT_APPLICABLE",
	snoozeUntil: null,
	personalForUserId: null,
});

const snoozedBy = (
	itemKey: string,
	userId: string,
	until: Date | null = new Date("2026-09-01T00:00:00Z"),
): ManualStateInput => ({
	itemKey,
	state: "SNOOZED",
	snoozeUntil: until,
	personalForUserId: userId,
});

describe("readiness level", () => {
	describe("decision 3 — a phase is inferred, never withheld", () => {
		// The card's migration plan says a missing phase defaults to Discovery /
		// Planning. An earlier cut refused to grade at all, which made the whole
		// feature invisible on every project that predates it.
		it("still grades a project that has no phase set", () => {
			const e = emptyEvidence();
			e.phase = null;
			const result = resolve(e);
			// Graded, not withheld: a bare project owes work and is told so.
			expect(result.level).toBe("NOT_READY");
			expect(result.items.length).toBeGreaterThan(0);
			expect(result.totalCount).toBeGreaterThan(0);
			expect(result.activeGaps.length).toBeGreaterThan(0);
		});

		it("can reach READY on an inferred phase — inference grades, it does not penalise", () => {
			const e = fullySetUp();
			e.phase = null;
			const result = resolve(e);
			expect(result.phaseSource).toBe("inferred");
			expect(result.level).toBe("READY");
		});

		it("reports the phase as inferred so the UI can say so", () => {
			const e = emptyEvidence();
			e.phase = null;
			expect(resolve(e).phaseSource).toBe("inferred");
		});

		it("reports a chosen phase as set", () => {
			expect(resolve(fullySetUp()).phaseSource).toBe("set");
			expect(resolve(fullySetUp()).phase).toBe("DEVELOPMENT_EXECUTION");
		});

		it("infers Development from a connected codebase", () => {
			const e = emptyEvidence();
			e.phase = null;
			e.code.repositoryConnected = true;
			expect(resolve(e).phase).toBe("DEVELOPMENT_EXECUTION");
		});

		it("infers Development from work on the roadmap", () => {
			const e = emptyEvidence();
			e.phase = null;
			e.roadmapItemCount = 3;
			expect(resolve(e).phase).toBe("DEVELOPMENT_EXECUTION");
		});

		it("falls back to Discovery when there is no signal — the card's default", () => {
			const e = emptyEvidence();
			e.phase = null;
			expect(resolve(e).phase).toBe("DISCOVERY_PLANNING");
		});

		it("never invents a gap out of the signal it inferred from", () => {
			// Inferring Development *because* a codebase is connected must not then
			// report "codebase not connected" as a Must gap.
			const e = emptyEvidence();
			e.phase = null;
			e.code.repositoryConnected = true;
			e.code.analysisCompleted = true;
			const result = resolve(e);
			expect(result.phase).toBe("DEVELOPMENT_EXECUTION");
			expect(result.activeGaps.map((i) => i.key)).not.toContain(
				"codebase-connected",
			);
		});
	});

	describe("base levels", () => {
		it("is READY when every Must and Should is detected complete", () => {
			expect(resolve(fullySetUp()).level).toBe("READY");
		});

		it("is NOT_READY when a Must is missing", () => {
			const e = fullySetUp();
			e.completeDocumentTypes.delete("PRD");
			const result = resolve(e);
			expect(result.level).toBe("NOT_READY");
			expect(result.activeGaps.map((i) => i.key)).toContain("prd");
		});

		it("is PARTIALLY_READY when only a Should is missing", () => {
			const e = fullySetUp();
			e.techStackCount = 0;
			const result = resolve(e);
			expect(result.level).toBe("PARTIALLY_READY");
			expect(result.activeGaps.map((i) => i.key)).toEqual(["tech-stack"]);
		});
	});

	/**
	 * UI Draft, Phase transition: "When all Discovery / Planning Must and Should
	 * items are complete, not applicable, or superseded, and no Must or Should
	 * items are snoozed, suggest switching to Development / Execution."
	 *
	 * The snooze clause is why these assert against a snoozed project too — a
	 * project held below Ready by a snooze must not be told it has finished.
	 */
	describe("suggesting the next phase", () => {
		it("offers Development once Discovery has nothing left owed", () => {
			const e = fullySetUp();
			e.phase = "DISCOVERY_PLANNING";
			const result = resolve(e);
			expect(result.level).toBe("READY");
			expect(result.suggestPhaseTransition).toBe(true);
		});

		it("stays quiet while a Should is still owed", () => {
			const e = fullySetUp();
			e.phase = "DISCOVERY_PLANNING";
			e.techStackCount = 0;
			expect(resolve(e).suggestPhaseTransition).toBe(false);
		});

		it("stays quiet when a Must or Should is merely snoozed", () => {
			const e = fullySetUp();
			e.phase = "DISCOVERY_PLANNING";
			e.techStackCount = 0;
			const result = resolve(e, [snoozedBy("tech-stack", VIEWER)]);
			expect(result.suggestPhaseTransition).toBe(false);
		});

		it("never offers a phase the project is already in", () => {
			const e = fullySetUp();
			e.phase = "DEVELOPMENT_EXECUTION";
			const result = resolve(e);
			expect(result.level).toBe("READY");
			expect(result.suggestPhaseTransition).toBe(false);
		});
	});

	/**
	 * The sheet's stated reason for collecting Expected Development Start Date:
	 * "so codebase-related readiness items can be snoozed or de-emphasized until
	 * development is expected to begin."
	 */
	describe("codebase items while development is still ahead", () => {
		function discoveryWithStartDate(date: Date | null) {
			const e = fullySetUp();
			e.phase = "DISCOVERY_PLANNING";
			e.expectedDevelopmentStartDate = date;
			e.code.analysisCompleted = false;
			e.code.atlasAnalysisExists = false;
			return e;
		}

		it("stops nagging for a codebase that is not due yet", () => {
			const result = resolve(
				discoveryWithStartDate(new Date("2026-12-01T00:00:00Z")),
			);
			expect(result.activeGaps.map((i) => i.key)).not.toContain(
				"codebase-connected",
			);
		});

		it("asks again once the start date has arrived", () => {
			const result = resolve(
				discoveryWithStartDate(new Date("2026-01-01T00:00:00Z")),
			);
			expect(
				result.items.find((i) => i.key === "codebase-connected")
					?.needLevel,
			).toBe("SHOULD");
		});

		it("asks when no start date was ever given", () => {
			const result = resolve(discoveryWithStartDate(null));
			expect(
				result.items.find((i) => i.key === "codebase-connected")
					?.needLevel,
			).toBe("SHOULD");
		});

		it("leaves Development / Execution alone", () => {
			const e = fullySetUp();
			e.phase = "DEVELOPMENT_EXECUTION";
			e.expectedDevelopmentStartDate = new Date("2026-12-01T00:00:00Z");
			expect(
				resolve(e).items.find((i) => i.key === "codebase-connected")
					?.needLevel,
			).toBe("MUST");
		});
	});

	describe("decision 1 — Not Applicable cascades to dependent items", () => {
		/**
		 * The case the decision exists for. A project with no PM tool, no chat
		 * app and no transcripts has four Development-phase Must items whose only
		 * prerequisites are Should items the spreadsheet itself calls often
		 * unavailable. Before the cascade, marking those prerequisites not
		 * applicable left the four Musts stranded and the project permanently
		 * NOT_READY with nothing the user could do about it.
		 */
		it("lets a project with no PM tool, chat app or transcripts reach READY", () => {
			const e = fullySetUp();
			e.pm = {
				connected: false,
				autoPushEnabled: false,
				readOnlyMode: false,
				autoCloseEnabled: false,
				terminalStatusCount: 0,
			};
			e.chat = {
				linkedChannelCount: 0,
				slackChannelMonitorEnabled: false,
				teamsChannelMonitorEnabled: false,
				teamsChatMonitorEnabled: false,
				transcriptAutoAnalyzeEnabled: false,
			};
			e.indexedContext.meetingTranscripts = 0;

			const result = resolve(e, [
				notApplicable("pm-system-connected"),
				notApplicable("chat-app-connected"),
				notApplicable("meeting-transcripts"),
			]);

			expect(result.level).toBe("READY");
			expect(result.activeGaps).toHaveLength(0);
		});

		it("resolves the Must items that hang off a not-applicable prerequisite", () => {
			const e = fullySetUp();
			e.pm.connected = false;
			e.pm.autoPushEnabled = false;
			e.pm.autoCloseEnabled = false;
			e.pm.terminalStatusCount = 0;

			const result = resolve(e, [notApplicable("pm-system-connected")]);
			const byKey = new Map(result.items.map((i) => [i.key, i]));

			expect(byKey.get("pm-sync-enabled")?.isComplete).toBe(true);
			expect(byKey.get("terminal-statuses")?.isComplete).toBe(true);
			expect(result.activeGaps.map((i) => i.key)).not.toContain(
				"pm-sync-enabled",
			);
		});

		it("cascades through a chain of dependencies", () => {
			const e = fullySetUp();
			e.chat.linkedChannelCount = 0;
			e.chat.slackChannelMonitorEnabled = false;
			e.chat.teamsChannelMonitorEnabled = false;
			e.chat.teamsChatMonitorEnabled = false;
			e.indexedContext.meetingTranscripts = 0;
			e.chat.transcriptAutoAnalyzeEnabled = false;

			// Chat app → meeting transcripts → work capture from transcripts, and
			// chat app → work capture from chat. One mark, four items resolved.
			const result = resolve(e, [notApplicable("chat-app-connected")]);
			const byKey = new Map(result.items.map((i) => [i.key, i]));

			expect(byKey.get("meeting-transcripts")?.isComplete).toBe(true);
			expect(byKey.get("work-capture-chat")?.isComplete).toBe(true);
			expect(byKey.get("work-capture-transcripts")?.isComplete).toBe(
				true,
			);
			expect(result.level).toBe("READY");
		});

		it("does not cascade when another route to satisfying the item survives", () => {
			// `architecture` depends on any of PRD, proposal, business case or a
			// connected codebase. Marking one of them not applicable must not
			// resolve it while the others are live.
			const e = fullySetUp();
			e.completeDocumentTypes.delete("ARCHITECTURE");

			const result = resolve(e, [notApplicable("business-case")]);
			const architecture = result.items.find(
				(i) => i.key === "architecture",
			);

			expect(architecture?.isComplete).toBe(false);
			expect(result.level).toBe("NOT_READY");
		});

		it("caps an item's need level at its dependency's", () => {
			// `release-notes` is a Should that depends on `codebase-connected`,
			// itself a Must in Development, so the cap leaves it a Should.
			// `work-capture-chat` is a Must depending on `chat-app-connected`, a
			// Should — so it is capped down to Should.
			const result = resolve(fullySetUp());
			const byKey = new Map(result.items.map((i) => [i.key, i]));

			expect(byKey.get("work-capture-chat")?.needLevel).toBe("SHOULD");
			expect(byKey.get("release-notes")?.needLevel).toBe("SHOULD");
		});
	});

	describe("decision 2 — snooze is personal, not applicable is project-wide", () => {
		it("hides a snoozed item from the person who snoozed it", () => {
			const e = fullySetUp();
			e.techStackCount = 0;

			const result = resolve(e, [snoozedBy("tech-stack", VIEWER)]);
			expect(result.activeGaps.map((i) => i.key)).not.toContain(
				"tech-stack",
			);
		});

		it("leaves it an active gap for everyone else", () => {
			const e = fullySetUp();
			e.techStackCount = 0;

			const result = resolve(e, [snoozedBy("tech-stack", TEAMMATE)]);
			expect(result.activeGaps.map((i) => i.key)).toContain("tech-stack");
		});

		it("stops applying a snooze once it has expired", () => {
			const e = fullySetUp();
			e.techStackCount = 0;
			const expired = new Date("2026-08-01T00:00:00Z");

			const result = resolve(e, [
				snoozedBy("tech-stack", VIEWER, expired),
			]);
			expect(result.activeGaps.map((i) => i.key)).toContain("tech-stack");
		});

		it("applies a not-applicable mark to every viewer", () => {
			const e = fullySetUp();
			e.techStackCount = 0;

			for (const viewer of [VIEWER, TEAMMATE]) {
				const result = resolve(
					e,
					[notApplicable("tech-stack")],
					viewer,
				);
				expect(result.level).toBe("READY");
			}
		});
	});

	describe("a snoozed Must or Should holds the project below Ready", () => {
		it("is PARTIALLY_READY rather than READY", () => {
			const e = fullySetUp();
			e.techStackCount = 0;

			const result = resolve(e, [snoozedBy("tech-stack", VIEWER)]);
			// Not an active gap for this viewer, but still not resolved.
			expect(result.activeGaps).toHaveLength(0);
			expect(result.level).toBe("PARTIALLY_READY");
		});

		it("does not let a project reach Ready with a Must snoozed", () => {
			const e = fullySetUp();
			e.completeDocumentTypes.delete("PRD");

			const result = resolve(e, [snoozedBy("prd", VIEWER)]);
			expect(result.level).toBe("PARTIALLY_READY");
		});
	});

	describe("decision 4 — the calculation only sees what the panel can show", () => {
		it("does not count an item hidden by an unmet dependency", () => {
			const e = emptyEvidence();
			e.phase = "DEVELOPMENT_EXECUTION";

			const result = resolve(e);
			const byKey = new Map(result.items.map((i) => [i.key, i]));

			// Nothing is set up, so Atlas and security are hidden behind an
			// unconnected codebase and must not be reported as gaps.
			expect(byKey.get("atlas-explored")?.isVisible).toBe(false);
			expect(byKey.get("security-scan")?.isVisible).toBe(false);
			expect(result.activeGaps.map((i) => i.key)).not.toContain(
				"atlas-explored",
			);
		});

		it("excludes not-applicable items from the denominator", () => {
			const e = fullySetUp();
			const before = resolve(e).totalCount;
			const after = resolve(e, [notApplicable("tech-stack")]).totalCount;
			expect(after).toBe(before - 1);
		});
	});

	describe("supersession", () => {
		it("completes the proposal once a PRD exists", () => {
			const e = fullySetUp();
			e.completeDocumentTypes.delete("PROPOSAL");

			const result = resolve(e);
			const proposal = result.items.find((i) => i.key === "proposal");

			expect(proposal?.isComplete).toBe(true);
			expect(proposal?.supersededBy).toBe("prd");
		});
	});

	describe("phase awareness", () => {
		it("grades the same project differently in each phase", () => {
			const discovery = fullySetUp();
			discovery.phase = "DISCOVERY_PLANNING";
			discovery.code = {
				repositoryConnected: false,
				analysisCompleted: false,
				atlasAnalysisExists: false,
			};

			const development = {
				...discovery,
				phase: "DEVELOPMENT_EXECUTION",
			};

			// A missing codebase is only a Should in Discovery, but a Must in
			// Development, so the same project lands on different levels.
			expect(resolve(discovery).level).toBe("PARTIALLY_READY");
			expect(resolve(development as ReadinessEvidence).level).toBe(
				"NOT_READY",
			);
		});

		it("never reports an item that is not applicable to the active phase", () => {
			const discovery = fullySetUp();
			discovery.phase = "DISCOVERY_PLANNING";

			const keys = resolve(discovery)
				.activeGaps.map((i) => i.key)
				.concat(
					READINESS_RULES.filter(
						(r) =>
							r.needLevel.DISCOVERY_PLANNING === "NOT_APPLICABLE",
					).length > 0
						? []
						: ["sentinel"],
				);

			expect(keys).not.toContain("release-notes");
			expect(keys).not.toContain("atlas-explored");
		});
	});
});

describe("a codebase attached through an integration is a connected codebase", () => {
	// Regression guard for the staging bug: `Project.repositoryUrl` is the legacy
	// column and is null on projects connected through ProjectRepositoryIntegration,
	// so reading only that reported "codebase not connected" on a project that
	// obviously had one — and took Atlas, security and release notes down with it,
	// since all three depend on this item.
	it("does not report codebase-connected as a gap", () => {
		const e = evidenceWithRepositoryIntegration();
		e.phase = "DEVELOPMENT_EXECUTION";
		const result = resolve(e);
		expect(result.activeGaps.map((i) => i.key)).not.toContain(
			"codebase-connected",
		);
	});

	it("stops hiding the three items that depend on it", () => {
		const e = evidenceWithRepositoryIntegration();
		e.phase = "DEVELOPMENT_EXECUTION";
		const byKey = new Map(resolve(e).items.map((i) => [i.key, i]));
		for (const key of [
			"atlas-explored",
			"security-scan",
			"release-notes",
		]) {
			expect(byKey.get(key)?.isVisible).toBe(true);
		}
	});

	it("infers Development from it, not Discovery", () => {
		const e = evidenceWithRepositoryIntegration();
		e.phase = null;
		expect(resolve(e).phase).toBe("DEVELOPMENT_EXECUTION");
	});
});

describe("a document whose re-run is still going", () => {
	/**
	 * Regeneration puts a document in both sets at once: it is still the
	 * project's PRD (`completeDocumentTypes`) and a run is working on it
	 * (`inFlight.documentTypes`). Complete has to win, or the fix for the
	 * vanishing PRD just returns the same row as "In progress" instead of done —
	 * which is no more true and no more use to the person reading it.
	 */
	function regeneratingPrd(): ReadinessEvidence {
		const e = fullySetUp();
		e.inFlight.documentTypes = new Set(["PRD"]);
		return e;
	}

	it("reads as complete, not as in progress", () => {
		const prd = resolve(regeneratingPrd()).items.find(
			(item) => item.key === "prd",
		);

		expect(prd?.isComplete).toBe(true);
		expect(prd?.isInProgress).toBe(false);
	});

	it("keeps the items that hang off it satisfied", () => {
		// `architecture` depends on `prd`, and the two context items are
		// superseded by it. One document flickering used to take them with it.
		const items = resolve(regeneratingPrd()).items;

		expect(items.find((i) => i.key === "architecture")?.isComplete).toBe(
			true,
		);
		expect(items.find((i) => i.key === "context-source")?.isComplete).toBe(
			true,
		);
	});

	it("still reads as in progress when there is no document yet", () => {
		const e = fullySetUp();
		e.completeDocumentTypes.delete("PRD");
		e.inFlight.documentTypes = new Set(["PRD"]);

		const prd = resolve(e).items.find((item) => item.key === "prd");

		expect(prd?.isComplete).toBe(false);
		expect(prd?.isInProgress).toBe(true);
	});
});
