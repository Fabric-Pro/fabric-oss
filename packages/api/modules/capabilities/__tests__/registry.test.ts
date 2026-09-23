/**
 * One named test per registry entry, plus the codebase truth table.
 *
 * The pairing is deliberate: the registry is the matrix in code, and a rule
 * that drifts from the matrix should fail a test whose name says which row
 * moved — not a generic "registry" assertion that says only that something is
 * wrong. The coverage test at the bottom is what keeps the pairing honest when
 * a row is added.
 */

import { describe, expect, it } from "vitest";
import { CAPABILITY_RULES, CAPABILITY_RULES_BY_KEY } from "../registry";
import { resolveGate } from "../resolve";
import { MIN_GROUNDING_DESCRIPTION_LENGTH } from "../thresholds";
import type { CapabilityState } from "../types";
import { evidenceWith, IDLE_JOB, runningJob } from "./evidence-fixture";

const NOW = new Date("2026-09-18T12:00:00.000Z");

function stateOf(key: string, evidence = evidenceWith({})): CapabilityState {
	const rule = CAPABILITY_RULES_BY_KEY.get(key);
	if (!rule) {
		throw new Error(`No rule registered for ${key}`);
	}
	return resolveGate(rule, evidence, NOW).state;
}

function gateOf(key: string, evidence = evidenceWith({})) {
	const rule = CAPABILITY_RULES_BY_KEY.get(key);
	if (!rule) {
		throw new Error(`No rule registered for ${key}`);
	}
	return resolveGate(rule, evidence, NOW);
}

describe("codebase predicate — the split that must not collapse", () => {
	it("serves a usable snapshot with a warning when the latest refresh failed", () => {
		// The regression this whole design exists to prevent. The graph is being
		// served right now; a failed refresh must not take it away.
		const gate = gateOf(
			"atlas.codebase-qa",
			evidenceWith({
				codebase: {
					usable: true,
					healthy: false,
					indexing: { ...IDLE_JOB },
				},
			}),
		);
		expect(gate.state).toBe("WARNING");
		expect(gate.blockingDependency).toBe("the most recent indexing run");
	});

	it("hard-blocks when nothing was ever indexed and the last run failed", () => {
		expect(
			stateOf(
				"atlas.codebase-qa",
				evidenceWith({
					codebase: {
						usable: false,
						healthy: false,
						indexing: {
							running: false,
							lastProgressAt: null,
							lastRunFailed: true,
						},
					},
				}),
			),
		).toBe("HARD_BLOCK");
	});

	it("shows processing while a first index is genuinely in flight", () => {
		expect(
			stateOf(
				"atlas.codebase-qa",
				evidenceWith({
					codebase: {
						usable: false,
						healthy: false,
						indexing: runningJob(new Date(NOW.getTime() - 60_000)),
					},
				}),
			),
		).toBe("PROCESSING");
	});

	it("stops calling a job Processing once it has gone quiet past its window", () => {
		const gate = gateOf(
			"atlas.codebase-qa",
			evidenceWith({
				codebase: {
					usable: false,
					healthy: false,
					indexing: runningJob(
						new Date(NOW.getTime() - 60 * 60 * 1000),
					),
				},
			}),
		);
		expect(gate.state).toBe("HARD_BLOCK");
		expect(gate.retry.supported).toBe(true);
	});

	it("hard-blocks an expired credential even over a good snapshot", () => {
		const gate = gateOf(
			"atlas.explore",
			evidenceWith({ codebase: { integrationStatus: "TOKEN_EXPIRED" } }),
		);
		expect(gate.state).toBe("HARD_BLOCK");
		expect(gate.remedy).toBe("RECONNECT_CREDENTIAL");
	});

	it("does not tell an unreachable repository to reconnect", () => {
		// Reconnecting with the same grant changes nothing here, and the schema
		// says so. Sending people to that flow teaches them to distrust the copy.
		const gate = gateOf(
			"atlas.explore",
			evidenceWith({
				codebase: { integrationStatus: "REPO_UNAVAILABLE" },
			}),
		);
		expect(gate.remedy).toBe("INSTALL_REPOSITORY_APP");
		expect(gate.remedy).not.toBe("RECONNECT_CREDENTIAL");
	});

	it("hard-blocks every codebase-dependent capability on the same failure", () => {
		// The requirement is explicit that an unusable source is unusable
		// everywhere. One shared verdict is what makes that true by construction.
		//
		// The realistic case: an expired token over an index that completed
		// and is still on disk. An earlier fixture paired the expired token
		// with "no usable index" — a combination the gather cannot produce —
		// and so hid that release notes let this through as AVAILABLE.
		const broken = evidenceWith({
			codebase: {
				integrationStatus: "TOKEN_EXPIRED",
				usable: true,
				healthy: false,
			},
			scan: { requiresCodebase: true },
		});
		for (const key of [
			"atlas.explore",
			"atlas.codebase-qa",
			"release-notes.generate",
			"security.run-scan",
		]) {
			expect(stateOf(key, broken), key).toBe("HARD_BLOCK");
		}
	});
});

describe("documents", () => {
	it("documents.generate-prd runs with a warning on thin context", () => {
		expect(
			stateOf(
				"documents.generate-prd",
				evidenceWith({
					descriptionLength: 0,
					context: { product: 0, technical: 0, total: 0 },
					documents: { usableTypes: new Set() },
				}),
			),
		).toBe("WARNING");
	});

	it("documents.generate-prd is available once anything grounds it", () => {
		expect(stateOf("documents.generate-prd")).toBe("AVAILABLE");
	});

	it("documents.generate-business-case warns rather than blocks", () => {
		expect(
			stateOf(
				"documents.generate-business-case",
				evidenceWith({
					descriptionLength: 0,
					context: { product: 0, technical: 0, total: 0 },
					documents: { usableTypes: new Set() },
				}),
			),
		).toBe("WARNING");
	});

	it("documents.generate-proposal warns rather than blocks", () => {
		expect(
			stateOf(
				"documents.generate-proposal",
				evidenceWith({
					descriptionLength: 0,
					context: { product: 0, technical: 0, total: 0 },
					documents: { usableTypes: new Set() },
				}),
			),
		).toBe("WARNING");
	});

	/**
	 * The bound that decides this must sit clear of the one project creation
	 * enforces, or the warning can never be seen.
	 *
	 * `SimplifiedProjectForm` refuses a brief of `MIN_DESCRIPTION_LENGTH` (50)
	 * characters or fewer, so 51 is the shortest description any project in the
	 * product can have. While this bound was also 50, every creatable project
	 * cleared it on its description alone and `context.thin` was unreachable —
	 * AC-14's warning existed in the registry and could not be reached in the UI.
	 *
	 * This is the regression test for that. If someone lowers the grounding
	 * bound back towards the creation floor, this fails rather than the warning
	 * quietly disappearing again.
	 */
	it("still warns at the shortest brief the product can create", () => {
		expect(
			stateOf(
				"documents.generate-prd",
				evidenceWith({
					descriptionLength: 51,
					context: { product: 0, technical: 0, total: 0 },
					documents: { usableTypes: new Set() },
				}),
			),
		).toBe("WARNING");
	});

	it("warns just below the grounding bound and not at it", () => {
		const thin = (length: number) =>
			stateOf(
				"documents.generate-prd",
				evidenceWith({
					descriptionLength: length,
					context: { product: 0, technical: 0, total: 0 },
					documents: { usableTypes: new Set() },
				}),
			);
		expect(thin(MIN_GROUNDING_DESCRIPTION_LENGTH - 1)).toBe("WARNING");
		expect(thin(MIN_GROUNDING_DESCRIPTION_LENGTH)).toBe("AVAILABLE");
	});

	/**
	 * A brief is only ever the tiebreaker. Real sources settle it on their own,
	 * however terse the description — warning a project that has documents
	 * would be noise, not honesty.
	 */
	it("does not warn on a terse brief when documents ground it", () => {
		expect(
			stateOf(
				"documents.generate-prd",
				evidenceWith({
					descriptionLength: 1,
					context: { product: 0, technical: 0, total: 0 },
					documents: { usableTypes: new Set(["PRD"]) },
				}),
			),
		).toBe("AVAILABLE");
	});

	it("does not warn on a terse brief when project context grounds it", () => {
		expect(
			stateOf(
				"documents.generate-prd",
				evidenceWith({
					descriptionLength: 1,
					context: { product: 3, technical: 0, total: 3 },
					documents: { usableTypes: new Set() },
				}),
			),
		).toBe("AVAILABLE");
	});

	it("documents.generate-architecture soft-blocks with no product source", () => {
		expect(
			stateOf(
				"documents.generate-architecture",
				evidenceWith({
					codebase: {
						connected: false,
						usable: false,
						integrationStatus: null,
					},
					context: { technical: 0 },
					documents: { usableTypes: new Set() },
				}),
			),
		).toBe("SOFT_BLOCK");
	});

	it("documents.generate-tech-spec soft-blocks with no technical source", () => {
		expect(
			stateOf(
				"documents.generate-tech-spec",
				evidenceWith({
					codebase: {
						connected: false,
						usable: false,
						integrationStatus: null,
					},
					context: { technical: 0 },
					documents: { usableTypes: new Set() },
				}),
			),
		).toBe("SOFT_BLOCK");
	});

	it("documents.generate-api-spec soft-blocks with no API-relevant source", () => {
		expect(
			stateOf(
				"documents.generate-api-spec",
				evidenceWith({
					codebase: {
						connected: false,
						usable: false,
						integrationStatus: null,
					},
					context: { technical: 0 },
					documents: { usableTypes: new Set() },
				}),
			),
		).toBe("SOFT_BLOCK");
	});

	it("documents.generate-qa-strategy soft-blocks without requirements context", () => {
		expect(
			stateOf(
				"documents.generate-qa-strategy",
				evidenceWith({
					context: { product: 0 },
					documents: { usableTypes: new Set(["ARCHITECTURE"]) },
				}),
			),
		).toBe("SOFT_BLOCK");
	});

	it("documents.generate-qa-strategy is available with a usable PRD", () => {
		expect(stateOf("documents.generate-qa-strategy")).toBe("AVAILABLE");
	});
});

describe("living-document refresh", () => {
	const KEY = "documents.auto-refresh";
	const ingesting = (minutesAgo: number) =>
		runningJob(new Date(NOW.getTime() - minutesAgo * 60 * 1000));

	it("documents.auto-refresh is available when the refresh has something to read", () => {
		expect(stateOf(KEY)).toBe("AVAILABLE");
	});

	it("documents.auto-refresh warns, never blocks, when there is nothing to read", () => {
		const gate = gateOf(
			KEY,
			evidenceWith({ refreshSources: { readable: false } }),
		);
		expect(gate.state).toBe("WARNING");
		expect(gate.reasonKey).toBe("documents.refresh-nothing-to-read");
		expect(gate.remedy).toBe("ADD_CONTEXT");
	});

	it("documents.auto-refresh warns while sources are still processing", () => {
		const gate = gateOf(
			KEY,
			evidenceWith({ context: { processing: ingesting(1) } }),
		);
		expect(gate.state).toBe("WARNING");
		expect(gate.reasonKey).toBe("documents.refresh-sources-processing");
		expect(gate.remedy).toBe("WAIT");
	});

	it("says a source is on its way rather than that there is nothing to read", () => {
		// The project's only source is the one being read. "Nothing to read"
		// would tell someone to add what they just added.
		const gate = gateOf(
			KEY,
			evidenceWith({
				context: { processing: ingesting(1) },
				refreshSources: { readable: false },
			}),
		);
		expect(gate.reasonKey).toBe("documents.refresh-sources-processing");
	});

	it("does not keep saying 'still processing' over an ingestion that stalled", () => {
		const gate = gateOf(
			KEY,
			evidenceWith({
				context: { processing: ingesting(60) },
				refreshSources: { readable: false },
			}),
		);
		expect(gate.reasonKey).toBe("documents.refresh-nothing-to-read");
		expect(
			stateOf(
				KEY,
				evidenceWith({ context: { processing: ingesting(60) } }),
			),
		).toBe("AVAILABLE");
	});

	it("ignores the codebase and every other context count — the refresh reads neither", () => {
		// An indexed repository never reaches the refresh's retrieval, so it
		// cannot stand in for a source; a context count the refresh does not
		// read cannot either.
		const gate = gateOf(
			KEY,
			evidenceWith({
				refreshSources: { readable: false },
				context: { total: 9, technical: 5, product: 4 },
			}),
		);
		expect(gate.reasonKey).toBe("documents.refresh-nothing-to-read");
		expect(
			stateOf(
				KEY,
				evidenceWith({
					codebase: {
						connected: false,
						usable: false,
						integrationStatus: null,
					},
					context: { total: 0, technical: 0, product: 0 },
				}),
			),
		).toBe("AVAILABLE");
	});

	it("moves its fingerprint only on the facts it reads", () => {
		const fingerprint = gateOf(
			KEY,
			evidenceWith({ refreshSources: { readable: false } }),
		).fingerprint;

		expect(
			gateOf(
				KEY,
				evidenceWith({
					refreshSources: { readable: false },
					codebase: { usable: false, healthy: false },
					context: { total: 0, product: 0 },
					chat: { linkedChannelCount: 0 },
				}),
			).fingerprint,
		).toBe(fingerprint);
		expect(
			gateOf(
				KEY,
				evidenceWith({
					refreshSources: { readable: false },
					context: { processing: ingesting(1) },
				}),
			).fingerprint,
		).not.toBe(fingerprint);
		expect(gateOf(KEY).fingerprint).not.toBe(fingerprint);
	});
});

describe("context", () => {
	it("context.use-linked-source shows processing while ingestion runs", () => {
		expect(
			stateOf(
				"context.use-linked-source",
				evidenceWith({
					context: {
						processing: runningJob(
							new Date(NOW.getTime() - 30_000),
						),
					},
				}),
			),
		).toBe("PROCESSING");
	});

	it("context.use-linked-source hard-blocks a stalled ingestion", () => {
		expect(
			stateOf(
				"context.use-linked-source",
				evidenceWith({
					context: {
						processing: runningJob(
							new Date(NOW.getTime() - 60 * 60 * 1000),
						),
					},
				}),
			),
		).toBe("HARD_BLOCK");
	});
});

describe("security", () => {
	it("does not block a spec-only scan on a missing repository", () => {
		// The engines that run by default are AI reviewers over documents and
		// features. Requiring a repository for them would take spec review away
		// from precisely the projects that have nothing but specs.
		expect(
			stateOf(
				"security.run-scan",
				evidenceWith({
					codebase: {
						connected: false,
						usable: false,
						healthy: false,
						integrationStatus: null,
					},
					scan: { requiresCodebase: false },
				}),
			),
		).toBe("AVAILABLE");
	});

	it("blocks once a repository scanner is switched on and there is no repository", () => {
		expect(
			stateOf(
				"security.run-scan",
				evidenceWith({
					codebase: {
						connected: false,
						usable: false,
						healthy: false,
						integrationStatus: null,
					},
					scan: { requiresCodebase: true },
				}),
			),
		).toBe("HARD_BLOCK");
	});

	it("security.run-scan shows processing while a scan runs", () => {
		expect(
			stateOf(
				"security.run-scan",
				evidenceWith({
					scan: runningJob(new Date(NOW.getTime() - 60_000)),
				}),
			),
		).toBe("PROCESSING");
	});

	it("lets the stalled scan win over a merely stale codebase", () => {
		// The composite rule earning its keep. Evaluated in order, the codebase
		// verdict (a WARNING, because a usable snapshot survived a failed
		// refresh) would have been returned first and the stalled scan behind it
		// never looked at — the weaker state winning purely because it was
		// checked earlier. Severity decides, not order.
		expect(
			stateOf(
				"security.run-scan",
				evidenceWith({
					codebase: { usable: true, healthy: false },
					scan: {
						requiresCodebase: true,
						...runningJob(
							new Date(NOW.getTime() - 4 * 60 * 60 * 1000),
						),
					},
				}),
			),
		).toBe("HARD_BLOCK");
	});

	it("security.run-scan hard-blocks a scan abandoned past its window", () => {
		// Scans carry no heartbeat, so this clock runs from startedAt and the
		// window is generous on purpose.
		expect(
			stateOf(
				"security.run-scan",
				evidenceWith({
					scan: runningJob(
						new Date(NOW.getTime() - 4 * 60 * 60 * 1000),
					),
				}),
			),
		).toBe("HARD_BLOCK");
	});
});

describe("release notes", () => {
	it("release-notes.generate blocks without a usable codebase", () => {
		expect(
			stateOf(
				"release-notes.generate",
				evidenceWith({
					codebase: {
						connected: false,
						usable: false,
						healthy: false,
					},
				}),
			),
		).toBe("HARD_BLOCK");
	});
});

describe("settings", () => {
	it("settings.repository-connection warns and never blocks", () => {
		// Settings are where the prerequisite gets satisfied. Blocking the page
		// would take away the only route out of the problem it is reporting.
		for (const status of ["TOKEN_EXPIRED", "REPO_UNAVAILABLE"] as const) {
			const gate = gateOf(
				"settings.repository-connection",
				evidenceWith({ codebase: { integrationStatus: status } }),
			);
			expect(gate.state, status).toBe("WARNING");
		}
	});

	it("settings.repository-connection does not report a broken source as fine", () => {
		expect(
			stateOf(
				"settings.repository-connection",
				evidenceWith({ codebase: { healthy: false } }),
			),
		).not.toBe("AVAILABLE");
	});

	it("settings.work-capture is available once a conversation is linked", () => {
		expect(
			stateOf(
				"settings.work-capture",
				evidenceWith({ chat: { linkedChannelCount: 1 } }),
			),
		).toBe("AVAILABLE");
	});

	it("settings.work-capture warns, with no remedy button, when nothing is linked", () => {
		// The link controls sit directly beneath the banner; a button pointing
		// back at them would be the same section twice.
		const gate = gateOf(
			"settings.work-capture",
			evidenceWith({ chat: { linkedChannelCount: 0 } }),
		);
		expect(gate.state).toBe("WARNING");
		expect(gate.reasonKey).toBe("settings.no-linked-channel");
		expect(gate.remedy).toBeNull();
	});

	it("settings.work-capture fingerprints on being linked, and nothing else", () => {
		const none = (over: Parameters<typeof evidenceWith>[0] = {}) =>
			gateOf(
				"settings.work-capture",
				evidenceWith({ ...over, chat: { linkedChannelCount: 0 } }),
			).fingerprint;

		expect(
			none({
				codebase: { usable: false },
				refreshSources: { readable: false },
				context: { total: 0 },
			}),
		).toBe(none());
		expect(
			gateOf(
				"settings.work-capture",
				evidenceWith({ chat: { linkedChannelCount: 3 } }),
			).fingerprint,
		).not.toBe(none());
	});
});

describe("retry permission", () => {
	it("keeps the control offered but unusable for a viewer who cannot re-run", () => {
		// Hiding it would make the block look unfixable, which is the opposite
		// of what this feature is for — so the affordance stays and the copy
		// refers the viewer to someone who can.
		const gate = gateOf(
			"atlas.codebase-qa",
			evidenceWith({
				viewer: { canEditProjectSettings: false },
				codebase: { usable: true, healthy: false },
			}),
		);
		expect(gate.retry.supported).toBe(true);
		expect(gate.retry.permitted).toBe(false);
	});
});

describe("registry coverage", () => {
	it("registers no Roadmap capability", () => {
		// Those rows gate surfaces that Project Suite 3A/3B/3C build. A rule
		// written against UI that does not exist is dead code today and the
		// wrong shape tomorrow.
		const roadmap = CAPABILITY_RULES.filter((r) =>
			r.key.startsWith("roadmap."),
		);
		expect(roadmap).toEqual([]);
	});

	it("gives every rule a unique key and a non-empty label", () => {
		const keys = CAPABILITY_RULES.map((r) => r.key);
		expect(new Set(keys).size).toBe(keys.length);
		for (const rule of CAPABILITY_RULES) {
			expect(rule.label.length, rule.key).toBeGreaterThan(3);
		}
	});

	it("names the blocking dependency whenever it is not available", () => {
		// A message that announces a verdict without naming its cause leaves the
		// reader exactly where they started, and the requirements say so.
		const broken = evidenceWith({
			codebase: {
				connected: false,
				usable: false,
				healthy: false,
				integrationStatus: null,
			},
			context: { total: 0, technical: 0, product: 0 },
			documents: { usableTypes: new Set() },
			descriptionLength: 0,
		});
		for (const rule of CAPABILITY_RULES) {
			const gate = resolveGate(rule, broken, NOW);
			if (gate.state === "AVAILABLE" || gate.state === "HIDDEN") {
				continue;
			}
			expect(gate.reasonKey, rule.key).not.toBeNull();
			expect(gate.blockingDependency, rule.key).not.toBeNull();
		}
	});
});

// ── Fizzy #1930 review round ─────────────────────────────────────────────────

/** A connected repository that nothing has ever indexed. */
function neverIndexed(overrides: { indexingEnabled: boolean }) {
	return evidenceWith({
		codebase: {
			connected: true,
			integrationStatus: "ACTIVE",
			usable: false,
			healthy: true,
			indexingEnabled: overrides.indexingEnabled,
			indexing: { ...IDLE_JOB },
			lastIndexCompletedAt: null,
		},
	});
}

describe("Processing means a job is running — and nothing else", () => {
	it("no rule returns PROCESSING when no job is running", () => {
		// The default outcome of connecting a repository used to be a spinner
		// that never stopped: nothing was indexing, and the gate said wait.
		// Swept across every rule and every codebase shape a project can be in
		// with nothing in flight.
		const idle = [
			neverIndexed({ indexingEnabled: false }),
			neverIndexed({ indexingEnabled: true }),
			evidenceWith({
				codebase: {
					usable: false,
					indexing: { ...IDLE_JOB, lastRunFailed: true },
				},
			}),
			evidenceWith({ codebase: { usable: true, healthy: false } }),
			evidenceWith({
				codebase: { connected: false, integrationStatus: null },
			}),
			evidenceWith({ codebase: { integrationStatus: "TOKEN_EXPIRED" } }),
		].map((e) => ({
			...e,
			documents: { ...e.documents, usableTypes: new Set<string>() },
			context: { ...e.context, technical: 0, product: 0, total: 0 },
			scan: { ...IDLE_JOB, requiresCodebase: true },
		}));
		for (const evidence of idle) {
			for (const rule of CAPABILITY_RULES) {
				expect(
					resolveGate(rule, evidence, NOW).state,
					`${rule.key} / ${evidence.codebase.indexingEnabled}`,
				).not.toBe("PROCESSING");
			}
		}
	});

	it("says code search is off, with the setting as its remedy", () => {
		const gate = gateOf(
			"atlas.codebase-qa",
			neverIndexed({ indexingEnabled: false }),
		);
		expect(gate.state).toBe("HARD_BLOCK");
		expect(gate.reasonKey).toBe("codebase.code-search-off");
		expect(gate.remedy).toBe("ENABLE_CODE_SEARCH");
		expect(gate.retry.supported).toBe(false);
	});

	it("hard-blocks a never-indexed repository with a first run as the retry", () => {
		const gate = gateOf(
			"atlas.codebase-qa",
			neverIndexed({ indexingEnabled: true }),
		);
		expect(gate.state).toBe("HARD_BLOCK");
		expect(gate.reasonKey).toBe("codebase.never-indexed");
		expect(gate.remedy).toBe("RETRY_JOB");
		expect(gate.retry).toMatchObject({
			supported: true,
			available: true,
			targetId: "integration_example",
		});
	});

	it("offers an AVAILABLE retry on a stalled index — a re-index supersedes it", () => {
		const gate = gateOf(
			"atlas.codebase-qa",
			evidenceWith({
				codebase: {
					usable: false,
					indexing: runningJob(
						new Date(NOW.getTime() - 60 * 60 * 1000),
					),
				},
			}),
		);
		expect(gate.reasonKey).toBe("codebase.indexing-stalled");
		expect(gate.retry.available).toBe(true);
	});

	it("names code search, not a retry, when a failed run sits behind code search off", () => {
		// A retry is refused at its own door while code search is off.
		const gate = gateOf(
			"atlas.codebase-qa",
			evidenceWith({
				codebase: {
					usable: false,
					indexingEnabled: false,
					indexing: { ...IDLE_JOB, lastRunFailed: true },
				},
			}),
		);
		expect(gate.reasonKey).toBe("codebase.code-search-off");
	});
});

describe("each capability depends on what it actually reads", () => {
	it("atlas.explore needs the connection, never the code index", () => {
		// Analysis BUILDS the graph; it cannot require it, and it never reads
		// the index. This is also the Reanalyze retry path.
		expect(
			stateOf("atlas.explore", neverIndexed({ indexingEnabled: false })),
		).toBe("AVAILABLE");
		expect(
			stateOf(
				"atlas.explore",
				evidenceWith({
					codebase: { integrationStatus: "TOKEN_EXPIRED" },
				}),
			),
		).toBe("HARD_BLOCK");
	});

	it("atlas.codebase-qa answers from a ready graph without any index", () => {
		const e = neverIndexed({ indexingEnabled: false });
		e.codebase.graphReady = true;
		expect(stateOf("atlas.codebase-qa", e)).toBe("AVAILABLE");
	});

	it("security.run-scan needs the connection only — the scanners clone live", () => {
		const e = neverIndexed({ indexingEnabled: false });
		e.scan = { ...IDLE_JOB, requiresCodebase: true };
		expect(stateOf("security.run-scan", e)).toBe("AVAILABLE");
	});

	it("release-notes.generate needs the connection only — it reads the provider live", () => {
		expect(
			stateOf(
				"release-notes.generate",
				neverIndexed({ indexingEnabled: false }),
			),
		).toBe("AVAILABLE");
	});

	it("release-notes.generate hard-blocks an unreachable repository over a good index", () => {
		expect(
			gateOf(
				"release-notes.generate",
				evidenceWith({
					codebase: {
						integrationStatus: "REPO_UNAVAILABLE",
						usable: true,
					},
				}),
			).remedy,
		).toBe("INSTALL_REPOSITORY_APP");
	});
});

describe("document generators and the repository", () => {
	const onlyTheRepository = (codebase: object) =>
		evidenceWith({
			codebase,
			context: { technical: 0, product: 0, total: 0 },
			documents: { usableTypes: new Set(["PRD"]) },
		});

	it("points a brand-new project at code search when the repository is the only way", () => {
		// PRD present, repository connected, code search off (the default):
		// API Specification has nothing but the repository to draw on.
		const gate = gateOf(
			"documents.generate-api-spec",
			onlyTheRepository({
				usable: false,
				indexingEnabled: false,
				lastIndexCompletedAt: null,
			}),
		);
		// Soft, not hard: pasted source text must be able to lift it, like
		// any other "no source" answer a document generator gives. The
		// reason and its remedy still point at code search.
		expect(gate.state).toBe("SOFT_BLOCK");
		expect(gate.reasonKey).toBe("codebase.code-search-off");
		expect(gate.remedy).toBe("ENABLE_CODE_SEARCH");
	});

	it("keeps the repository's retry on the soft block, so 'Start indexing' still renders", () => {
		const gate = gateOf(
			"documents.generate-api-spec",
			onlyTheRepository({ usable: false, lastIndexCompletedAt: null }),
		);
		expect(gate.state).toBe("SOFT_BLOCK");
		expect(gate.reasonKey).toBe("codebase.never-indexed");
		expect(gate.retry).toMatchObject({ supported: true, available: true });
	});

	it("is AVAILABLE over a usable index even while a PRD is still generating", () => {
		// The index already grounds it; "waiting on a source" would describe a
		// wait that is not happening.
		const e = onlyTheRepository({ usable: true, healthy: true });
		e.documents = {
			...e.documents,
			usableTypes: new Set<string>(),
			inFlightTypes: new Set(["PRD"]),
		};
		expect(gateOf("documents.generate-architecture", e).state).toBe(
			"AVAILABLE",
		);
	});

	it("does not count an index behind an expired credential as a source", () => {
		const gate = gateOf(
			"documents.generate-api-spec",
			onlyTheRepository({
				integrationStatus: "TOKEN_EXPIRED",
				usable: true,
			}),
		);
		expect(gate.reasonKey).toBe("codebase.credentials-expired");
	});

	it("names an index that is genuinely running, still as a soft block", () => {
		const gate = gateOf(
			"documents.generate-api-spec",
			onlyTheRepository({
				usable: false,
				indexing: runningJob(new Date(NOW.getTime() - 60_000)),
			}),
		);
		expect(gate.state).toBe("SOFT_BLOCK");
		expect(gate.reasonKey).toBe("codebase.indexing");
	});

	it("keeps the repository's hard blocks on the capabilities that read it directly", () => {
		const e = onlyTheRepository({ usable: false, indexingEnabled: false });
		expect(stateOf("atlas.codebase-qa", e)).toBe("HARD_BLOCK");
	});

	it("ignores the index entirely when a document grounds the generation", () => {
		// A PRD grounds the tech spec on its own; the repository's state is
		// then nobody's business.
		expect(
			stateOf(
				"documents.generate-tech-spec",
				onlyTheRepository({ usable: false, indexingEnabled: false }),
			),
		).toBe("AVAILABLE");
	});

	it("still says 'add a source' when there is no repository at all", () => {
		expect(
			gateOf(
				"documents.generate-api-spec",
				onlyTheRepository({
					connected: false,
					integrationStatus: null,
					usable: false,
				}),
			).reasonKey,
		).toBe("documents.no-api-source");
	});
});

describe("retry permission follows the door the re-run goes through", () => {
	it("a codebase retry needs settings-edit", () => {
		const gate = gateOf(
			"atlas.codebase-qa",
			evidenceWith({
				viewer: {
					canEditProjectSettings: false,
					canUpdateProject: true,
				},
				codebase: { usable: true, healthy: false },
			}),
		);
		expect(gate.retry.permitted).toBe(false);
	});

	it("a scan retry needs project-update", () => {
		const stalled = {
			scan: {
				requiresCodebase: false,
				...runningJob(new Date(NOW.getTime() - 4 * 60 * 60 * 1000)),
			},
		};
		expect(
			gateOf(
				"security.run-scan",
				evidenceWith({
					...stalled,
					viewer: {
						canEditProjectSettings: false,
						canUpdateProject: true,
					},
				}),
			).retry.permitted,
		).toBe(true);
		expect(
			gateOf(
				"security.run-scan",
				evidenceWith({
					...stalled,
					viewer: {
						canEditProjectSettings: true,
						canUpdateProject: false,
					},
				}),
			).retry.permitted,
		).toBe(false);
	});

	it("a stalled context source offers no retry nobody could perform", () => {
		const gate = gateOf(
			"context.use-linked-source",
			evidenceWith({
				context: {
					processing: runningJob(
						new Date(NOW.getTime() - 60 * 60 * 1000),
					),
				},
			}),
		);
		expect(gate.state).toBe("HARD_BLOCK");
		expect(gate.retry.supported).toBe(false);
		expect(gate.remedy).toBeNull();
	});
});

describe("a source that is on its way is not a missing source", () => {
	const barren = () =>
		evidenceWith({
			codebase: {
				connected: false,
				integrationStatus: null,
				usable: false,
			},
			context: { total: 0, technical: 0, product: 0 },
			documents: { usableTypes: new Set<string>() },
		});

	it("waits on a PRD that is still generating instead of asking for one", () => {
		const e = barren();
		e.documents = { ...e.documents, inFlightTypes: new Set(["PRD"]) };
		const gate = gateOf("documents.generate-architecture", e);
		expect(gate.state).toBe("PROCESSING");
		expect(gate.reasonKey).toBe("documents.source-processing");
	});

	it("waits on a technical source still being ingested", () => {
		const e = barren();
		e.context = { ...e.context, technicalInFlight: 1 };
		expect(gateOf("documents.generate-api-spec", e).reasonKey).toBe(
			"documents.source-processing",
		);
	});

	it("does not promise a wait the queue does not perform — same-tier documents", () => {
		// The dependency queue holds an API specification back for a PRD or
		// proposal only. An architecture document generating runs beside it,
		// so it is not "a source on its way" for the API specification.
		const e = barren();
		e.documents = {
			...e.documents,
			inFlightTypes: new Set(["ARCHITECTURE", "TECHNICAL_SPEC"]),
		};
		expect(gateOf("documents.generate-api-spec", e).reasonKey).toBe(
			"documents.no-api-source",
		);
	});

	it("does not wait on a PRD for a generator the queue does not hold back", () => {
		// QA strategy has no prerequisite in the dependency graph.
		const e = barren();
		e.documents = { ...e.documents, inFlightTypes: new Set(["PRD"]) };
		expect(gateOf("documents.generate-qa-strategy", e).reasonKey).toBe(
			"documents.no-requirements-source",
		);
	});

	it("does not treat a generator's own document, regenerating, as its source", () => {
		const e = barren();
		e.documents = { ...e.documents, inFlightTypes: new Set(["API_SPEC"]) };
		expect(gateOf("documents.generate-api-spec", e).reasonKey).toBe(
			"documents.no-api-source",
		);
	});
});

describe("code indexing switched off for the whole deployment", () => {
	it("says so, and offers no project setting as the remedy", () => {
		const gate = gateOf(
			"atlas.codebase-qa",
			evidenceWith({
				codebase: {
					usable: false,
					indexingAvailable: false,
					indexingEnabled: false,
				},
			}),
		);
		expect(gate.reasonKey).toBe("codebase.indexing-unavailable");
		expect(gate.remedy).toBeNull();
		expect(gate.retry.supported).toBe(false);
	});

	it("keeps 'turn on code search' for the project-setting case", () => {
		const gate = gateOf(
			"atlas.codebase-qa",
			evidenceWith({
				codebase: {
					usable: false,
					indexingAvailable: true,
					indexingEnabled: false,
				},
			}),
		);
		expect(gate.reasonKey).toBe("codebase.code-search-off");
	});
});
