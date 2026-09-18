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
			"atlas.explore",
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
				"atlas.explore",
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
				"atlas.explore",
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
			"atlas.explore",
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
		const broken = evidenceWith({
			codebase: { integrationStatus: "TOKEN_EXPIRED" },
			releaseNotes: { codebaseUsable: false },
		});
		for (const key of [
			"atlas.explore",
			"atlas.codebase-qa",
			"release-notes.generate",
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

	it("documents.generate-architecture soft-blocks with no product source", () => {
		expect(
			stateOf(
				"documents.generate-architecture",
				evidenceWith({
					codebase: { usable: false },
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
					codebase: { usable: false },
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
					codebase: { usable: false },
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
					releaseNotes: { codebaseUsable: false },
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
});

describe("retry permission", () => {
	it("keeps the control offered but unusable for a viewer who cannot re-run", () => {
		// Hiding it would make the block look unfixable, which is the opposite
		// of what this feature is for — so the affordance stays and the copy
		// refers the viewer to someone who can.
		const gate = gateOf(
			"atlas.explore",
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
			releaseNotes: { codebaseUsable: false },
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
