/**
 * The gate-to-copy mapping (Fizzy #1930).
 *
 * These assert on translation KEYS rather than sentences. That is not a
 * shortcut around the copy — it is the only assertion that stays true when the
 * copy is edited, and the thing actually worth pinning is which key a gate
 * chooses. A test that asserted English would pass a change that pointed an
 * unreachable repository at the reconnect flow as long as somebody reworded
 * the sentence.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CapabilityGate } from "@repo/api/modules/capabilities/types";
import { describe, expect, it, vi } from "vitest";
import { buildCapabilityGateView } from "../../../lib/capability-gate-view";

function gate(overrides: Partial<CapabilityGate> = {}): CapabilityGate {
	return {
		capabilityKey: "atlas.explore",
		state: "AVAILABLE",
		reasonKey: null,
		blockingDependency: null,
		remedy: null,
		retry: {
			supported: false,
			permitted: false,
			available: false,
			targetId: null,
		},
		fingerprint: "fingerprint_example",
		suppressed: false,
		...overrides,
	};
}

describe("buildCapabilityGateView — what renders nothing", () => {
	it("builds no view for an available capability", () => {
		expect(
			buildCapabilityGateView(gate({ state: "AVAILABLE" })),
		).toBeNull();
	});

	it("builds no view for a hidden capability", () => {
		// `HIDDEN` means more than "available" — the action leaves the page —
		// but that is the surface's call, read from `useCapabilityGate().hidden`.
		// A banner has nothing to say about it.
		expect(buildCapabilityGateView(gate({ state: "HIDDEN" }))).toBeNull();
	});

	it("builds no view for a warning this viewer silenced", () => {
		// The server flags rather than filters, so if this module did not hide
		// a suppressed warning nothing would — dismissal would appear broken.
		const suppressed = gate({
			state: "WARNING",
			reasonKey: "codebase.index-stale",
			blockingDependency: "the most recent indexing run",
			remedy: "RETRY_JOB",
			suppressed: true,
		});
		expect(buildCapabilityGateView(suppressed)).toBeNull();
	});
});

describe("buildCapabilityGateView — remedy drives the call to action", () => {
	const unreachable = gate({
		state: "HARD_BLOCK",
		reasonKey: "codebase.repository-unreachable",
		blockingDependency: "access to the connected repository",
		remedy: "INSTALL_REPOSITORY_APP",
	});

	const expired = gate({
		state: "HARD_BLOCK",
		reasonKey: "codebase.credentials-expired",
		blockingDependency: "valid repository credentials",
		remedy: "RECONNECT_CREDENTIAL",
	});

	it("never points an unreachable repository at the reconnect flow", () => {
		// Reconnecting with the same grant cannot reach a repository the
		// credential does not cover — the repository status enum's own schema
		// comment says so. Sending these users to reconnect wastes a round trip.
		const view = buildCapabilityGateView(unreachable);
		expect(view?.ctaLabel).toBe("remedy.installRepositoryApp");
		expect(view?.ctaLabel).not.toBe("remedy.reconnectCredential");
	});

	it("gives an expired credential the reconnect flow", () => {
		expect(buildCapabilityGateView(expired)?.ctaLabel).toBe(
			"remedy.reconnectCredential",
		);
	});

	it("gives the two repository failures different copy end to end", () => {
		const a = buildCapabilityGateView(unreachable);
		const b = buildCapabilityGateView(expired);
		expect(a?.title).not.toBe(b?.title);
		expect(a?.body).not.toBe(b?.body);
		expect(a?.ctaLabel).not.toBe(b?.ctaLabel);
	});

	it("maps every remedy to its own key", () => {
		const remedies = [
			["CONNECT_REPOSITORY", "remedy.connectRepository"],
			["RECONNECT_CREDENTIAL", "remedy.reconnectCredential"],
			["INSTALL_REPOSITORY_APP", "remedy.installRepositoryApp"],
			["ADD_CONTEXT", "remedy.addContext"],
			[
				"GENERATE_PREREQUISITE_DOCUMENT",
				"remedy.generatePrerequisiteDocument",
			],
			["CONFIGURE_INTEGRATION", "remedy.configureIntegration"],
			["CONFIGURE_PM_BOARD", "remedy.configurePmBoard"],
			["RETRY_JOB", "remedy.retryJob"],
		] as const;

		const labels = remedies.map(([remedy, expected]) => {
			const view = buildCapabilityGateView(
				gate({
					state: "HARD_BLOCK",
					reasonKey: "codebase.not-connected",
					blockingDependency: "a connected repository",
					remedy,
				}),
			);
			expect(view?.ctaLabel).toBe(expected);
			return view?.ctaLabel;
		});
		// No two remedies may collapse onto one another's copy.
		expect(new Set(labels).size).toBe(remedies.length);
	});

	it("offers nothing to press while a job is simply running", () => {
		const view = buildCapabilityGateView(
			gate({
				state: "PROCESSING",
				reasonKey: "codebase.indexing",
				blockingDependency: "repository indexing",
				remedy: "WAIT",
			}),
		);
		expect(view?.ctaKind).toBe("none");
		expect(view?.ctaLabel).toBeNull();
	});

	it("sends a retry remedy to the retry affordance, not a link", () => {
		const view = buildCapabilityGateView(
			gate({
				state: "HARD_BLOCK",
				reasonKey: "codebase.indexing-failed",
				blockingDependency: "a completed index of the repository",
				remedy: "RETRY_JOB",
			}),
		);
		expect(view?.ctaKind).toBe("retry");
		expect(view?.ctaTarget).toBeNull();
	});
});

describe("buildCapabilityGateView — state semantics", () => {
	const states = [
		"HARD_BLOCK",
		"SOFT_BLOCK",
		"PROCESSING",
		"WARNING",
	] as const;

	it("offers dismissal on a warning and on nothing else", () => {
		for (const state of states) {
			const view = buildCapabilityGateView(
				gate({
					state,
					reasonKey: "context.thin",
					blockingDependency: "project context",
					remedy: "ADD_CONTEXT",
				}),
			);
			expect(view?.dismissible).toBe(state === "WARNING");
		}
	});

	it("disables the action for every state except a warning", () => {
		for (const state of states) {
			const view = buildCapabilityGateView(
				gate({
					state,
					reasonKey: "context.thin",
					blockingDependency: "project context",
					remedy: "ADD_CONTEXT",
				}),
			);
			// A warning means the capability genuinely runs, just on thinner
			// input than it would like. Disabling it would be a lie.
			expect(view?.blocksAction).toBe(state !== "WARNING");
		}
	});

	it("paints a block, a warning and a running job differently", () => {
		const toneOf = (state: (typeof states)[number]) =>
			buildCapabilityGateView(
				gate({
					state,
					reasonKey: "context.thin",
					remedy: "ADD_CONTEXT",
				}),
			)?.tone;
		expect(toneOf("HARD_BLOCK")).toBe("destructive");
		expect(toneOf("WARNING")).toBe("warning");
		// Work in progress is not a problem and must not be painted like one.
		expect(toneOf("PROCESSING")).toBe("info");
	});
});

describe("buildCapabilityGateView — naming the missing dependency", () => {
	it("carries the server's named dependency through for interpolation", () => {
		const view = buildCapabilityGateView(
			gate({
				state: "SOFT_BLOCK",
				reasonKey: "documents.no-technical-source",
				blockingDependency:
					"a PRD, architecture document or indexed codebase",
				remedy: "ADD_CONTEXT",
			}),
		);
		expect(view?.params.dependency).toBe(
			"a PRD, architecture document or indexed codebase",
		);
	});

	it("falls back to copy that still names the dependency for an unknown reason", () => {
		// A rule added server-side reaches this build with no copy for its
		// reason. It must still say something true rather than render a raw key.
		const view = buildCapabilityGateView(
			gate({
				state: "HARD_BLOCK",
				reasonKey: "roadmap.some-future-rule",
				blockingDependency: "a connected project management system",
				remedy: "CONFIGURE_INTEGRATION",
			}),
		);
		expect(view?.title).toBe("fallback.hardBlock.title");
		expect(view?.body).toBe("fallback.hardBlock.body");
		expect(view?.params.dependency).toBe(
			"a connected project management system",
		);
	});

	it("uses the reason's own copy when it knows it", () => {
		const view = buildCapabilityGateView(
			gate({
				state: "HARD_BLOCK",
				reasonKey: "codebase.not-connected",
				blockingDependency: "a connected repository",
				remedy: "CONNECT_REPOSITORY",
			}),
		);
		expect(view?.title).toBe("reason.codebase.not-connected.title");
		expect(view?.body).toBe("reason.codebase.not-connected.body");
	});
});

describe("HIDDEN builds no view in every environment", () => {
	// The Roadmap's batch-removal rule emits HIDDEN, so it is a real state now,
	// not a surprise to fail loudly on. The surface removes the action; the
	// view builder must never throw on the way there, development included.
	const hidden = gate({
		capabilityKey: "roadmap.remove-ai-recommended",
		state: "HIDDEN",
		reasonKey: "roadmap.no-eligible-ai-batch",
	});

	it("returns null in development", () => {
		const previous = process.env.NODE_ENV;
		vi.stubEnv("NODE_ENV", "development");
		try {
			expect(buildCapabilityGateView(hidden)).toBeNull();
		} finally {
			vi.stubEnv("NODE_ENV", previous ?? "test");
		}
	});

	it("returns null outside development", () => {
		expect(buildCapabilityGateView(hidden)).toBeNull();
	});
});

describe("the review round's additions (Fizzy #1930)", () => {
	it("sends 'code search is off' to the code-search toggle", () => {
		const view = buildCapabilityGateView(
			gate({
				state: "HARD_BLOCK",
				reasonKey: "codebase.code-search-off",
				blockingDependency: "code search for this project",
				remedy: "ENABLE_CODE_SEARCH",
			}),
		);
		expect(view).toMatchObject({
			title: "reason.codebase.code-search-off.title",
			ctaKind: "navigate",
			ctaTarget: "code-search",
			ctaLabel: "remedy.enableCodeSearch",
		});
	});

	it("labels the first run of an index 'Start indexing', not 'Try again'", () => {
		const view = buildCapabilityGateView(
			gate({
				state: "HARD_BLOCK",
				reasonKey: "codebase.never-indexed",
				blockingDependency: "a completed index of the repository",
				remedy: "RETRY_JOB",
			}),
		);
		expect(view?.ctaLabel).toBe("remedy.startIndexing");
	});

	it("does not disable a generator whose source is on its way — the queue waits", () => {
		const view = buildCapabilityGateView(
			gate({
				state: "PROCESSING",
				reasonKey: "documents.source-processing",
				blockingDependency: "a product or architecture source",
				remedy: "WAIT",
			}),
		);
		expect(view?.state).toBe("PROCESSING");
		expect(view?.blocksAction).toBe(false);
	});

	it("hides a warning dismissed for the session, and never a block", () => {
		const warning = gate({
			state: "WARNING",
			reasonKey: "context.thin",
			blockingDependency: "project context",
			remedy: "ADD_CONTEXT",
		});
		expect(buildCapabilityGateView(warning, true)).toBeNull();
		expect(
			buildCapabilityGateView(
				{
					...warning,
					state: "HARD_BLOCK",
					reasonKey: "codebase.not-connected",
				},
				true,
			),
		).not.toBeNull();
	});
});

describe("buildCapabilityGateView — Roadmap reasons", () => {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const messages = JSON.parse(
		readFileSync(
			path.resolve(
				here,
				"../../../../../../../../packages/i18n/translations/en.json",
			),
			"utf8",
		),
	) as { projects: { capabilityGates: Record<string, unknown> } };

	/** Walk a dotted key, treating each segment as a whole property name. */
	function copyAt(key: string): unknown {
		return key
			.split(".")
			.reduce<unknown>(
				(node, segment) =>
					node && typeof node === "object"
						? (node as Record<string, unknown>)[segment]
						: undefined,
				messages.projects.capabilityGates,
			);
	}

	it.each([
		"roadmap.pm-not-connected",
		"roadmap.pm-no-board",
		"roadmap.pm-read-only",
		"roadmap.pm-sync-running",
		"roadmap.recommend.context-insufficient",
		"roadmap.do-both.needs-pm",
		"roadmap.do-both.needs-context",
	])(
		"uses the reason's own copy for %s, and that copy exists",
		(reasonKey) => {
			const view = buildCapabilityGateView(
				gate({
					state: "WARNING",
					reasonKey,
					blockingDependency: "a dependency",
					remedy: "ADD_CONTEXT",
				}),
			);

			expect(view?.title).toBe(`reason.${reasonKey}.title`);
			expect(view?.body).toBe(`reason.${reasonKey}.body`);
			expect(copyAt(`reason.${reasonKey}.title`)).toEqual(
				expect.any(String),
			);
			expect(copyAt(`reason.${reasonKey}.body`)).toEqual(
				expect.any(String),
			);
		},
	);

	it("has copy for the hidden batch-removal reason, read by its dialog", () => {
		expect(copyAt("reason.roadmap.no-eligible-ai-batch.title")).toEqual(
			expect.any(String),
		);
		expect(copyAt("reason.roadmap.no-eligible-ai-batch.body")).toEqual(
			expect.any(String),
		);
	});

	it("sends a missing board to the PM settings, not the integrations page", () => {
		const view = buildCapabilityGateView(
			gate({
				state: "HARD_BLOCK",
				reasonKey: "roadmap.pm-no-board",
				blockingDependency: "a board",
				remedy: "CONFIGURE_PM_BOARD",
			}),
		);

		expect(view?.ctaKind).toBe("navigate");
		expect(view?.ctaTarget).toBe("pm-settings");
		expect(copyAt("remedy.configurePmBoard")).toEqual(expect.any(String));
	});
});
