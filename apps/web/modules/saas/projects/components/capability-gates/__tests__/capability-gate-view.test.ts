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
		retry: { supported: false, permitted: false, available: false },
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
		// `HIDDEN` means more than "available" — the action should leave the
		// page entirely — but no rule emits it and no surface acts on it, so
		// the two are indistinguishable here today, on purpose. The note in
		// `capability-gate-view.ts` says what the first such rule must add.
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

describe("HIDDEN fails loudly rather than reading as available", () => {
	// No rule emits HIDDEN today. The point of this pair is that the day one
	// does, it is a build-time surprise for the engineer rather than a
	// capability that quietly renders as working for a user.
	const hidden = {
		capabilityKey: "example.capability",
		state: "HIDDEN" as const,
		reasonKey: null,
		blockingDependency: null,
		remedy: null,
		retry: { supported: false, permitted: false, available: false },
		suppressed: false,
	};

	it("throws in development, naming what the emitting rule must add", () => {
		const previous = process.env.NODE_ENV;
		vi.stubEnv("NODE_ENV", "development");
		try {
			expect(() => buildCapabilityGateView(hidden)).toThrow(
				/cannot act on/,
			);
		} finally {
			vi.stubEnv("NODE_ENV", previous ?? "test");
		}
	});

	it("degrades quietly outside development — a user never meets the exception", () => {
		expect(buildCapabilityGateView(hidden)).toBeNull();
	});
});
