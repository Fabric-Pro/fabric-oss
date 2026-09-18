/**
 * Warning suppression: what it may hide, and when it comes back.
 *
 * The behaviour worth defending here is the pair of opposites. A suppressed
 * warning must survive a reload, an idle re-render and a transient status flip
 * — otherwise dismissing it feels broken. And it must NOT survive the
 * dependency actually changing, because the warning would then be describing a
 * world that no longer exists.
 */

import { describe, expect, it } from "vitest";
import { CAPABILITY_RULES_BY_KEY } from "../registry";
import {
	applySuppression,
	dependencyFingerprint,
	resolveGate,
	type StoredSuppression,
} from "../resolve";
import {
	expiryFor,
	parseSuppressions,
	serializeSuppressions,
	withoutSuppression,
	withSuppression,
} from "../suppression";
import type { CapabilityGate } from "../types";
import { evidenceWith } from "./evidence-fixture";

const NOW = new Date("2026-09-18T12:00:00.000Z");

/** The project state that produces a dismissible warning on Atlas. */
const STALE_INDEX = evidenceWith({
	codebase: { usable: true, healthy: false },
});

function atlasGate(suppressions: readonly StoredSuppression[] = []) {
	const rule = CAPABILITY_RULES_BY_KEY.get("atlas.explore");
	if (!rule) {
		throw new Error("atlas.explore is not registered");
	}
	return resolveGate(rule, STALE_INDEX, NOW, suppressions);
}

function suppressionFor(
	gate: CapabilityGate,
	fingerprint: string,
	expiresAt?: string,
) {
	return {
		key: `${gate.capabilityKey}:${gate.reasonKey}`,
		fingerprint,
		expiresAt,
	};
}

describe("what suppression may hide", () => {
	it("hides a matching warning", () => {
		const base = atlasGate();
		expect(base.state).toBe("WARNING");
		const stored = suppressionFor(base, dependencyFingerprint(STALE_INDEX));
		expect(atlasGate([stored]).suppressed).toBe(true);
	});

	it("refuses to hide anything that is not a warning", () => {
		// Suppression is a preference about noise, never a statement about
		// whether the capability can run. Every other state is the latter.
		for (const state of [
			"HARD_BLOCK",
			"SOFT_BLOCK",
			"PROCESSING",
		] as const) {
			const gate: CapabilityGate = {
				capabilityKey: "atlas.explore",
				state,
				reasonKey: "codebase.not-connected",
				blockingDependency: "a connected repository",
				remedy: "CONNECT_REPOSITORY",
				retry: { supported: false, permitted: false, available: false },
				suppressed: false,
			};
			const stored = suppressionFor(gate, "anything");
			expect(
				applySuppression(gate, [stored], "anything", NOW).suppressed,
				state,
			).toBe(false);
		}
	});

	it("never leaks across users — suppression is read from the caller's own row", () => {
		// Enforced by where it is stored rather than by a check: the column sits
		// on the per-user-per-project row, so another user's read cannot see it.
		// This test pins the resolver half — an empty list means no suppression.
		expect(atlasGate([]).suppressed).toBe(false);
	});
});

describe("when a suppressed warning comes back", () => {
	it("stays hidden across a plain re-resolution with identical state", () => {
		const stored = suppressionFor(
			atlasGate(),
			dependencyFingerprint(STALE_INDEX),
		);
		expect(atlasGate([stored]).suppressed).toBe(true);
		expect(atlasGate([stored]).suppressed).toBe(true);
	});

	it("returns once the dependency materially changes", () => {
		const stored = suppressionFor(
			atlasGate(),
			dependencyFingerprint(STALE_INDEX),
		);
		const rule = CAPABILITY_RULES_BY_KEY.get("atlas.explore");
		if (!rule) {
			throw new Error("atlas.explore is not registered");
		}
		// Somebody added context. The fingerprint moves, so the old dismissal no
		// longer applies to what is now a different situation.
		const changed = evidenceWith({
			codebase: { usable: true, healthy: false },
			context: { total: 9, technical: 5, product: 4 },
		});
		expect(resolveGate(rule, changed, NOW, [stored]).suppressed).toBe(
			false,
		);
	});

	it("returns when the snooze expires", () => {
		const stored = suppressionFor(
			atlasGate(),
			dependencyFingerprint(STALE_INDEX),
			new Date(NOW.getTime() - 1000).toISOString(),
		);
		expect(atlasGate([stored]).suppressed).toBe(false);
	});

	it("does not expire a 'do not show again' entry", () => {
		const stored = suppressionFor(
			atlasGate(),
			dependencyFingerprint(STALE_INDEX),
		);
		expect(stored.expiresAt).toBeUndefined();
		expect(atlasGate([stored]).suppressed).toBe(true);
	});
});

describe("the fingerprint", () => {
	it("ignores transient status so a flip does not resurrect a dismissal", () => {
		// `healthy` is exactly the sort of value that flips on every re-index.
		// If it fed the fingerprint, a dismissal would survive about a minute.
		const a = dependencyFingerprint(
			evidenceWith({ codebase: { healthy: true } }),
		);
		const b = dependencyFingerprint(
			evidenceWith({ codebase: { healthy: false } }),
		);
		expect(a).toBe(b);
	});

	it("moves when a durable fact changes", () => {
		const a = dependencyFingerprint(evidenceWith({}));
		const b = dependencyFingerprint(
			evidenceWith({ codebase: { usable: false } }),
		);
		expect(a).not.toBe(b);
	});
});

describe("storage round trip", () => {
	it("parses a well-formed map", () => {
		const parsed = parseSuppressions({
			"atlas.explore:codebase.index-stale": { fingerprint: "f1" },
		});
		expect(parsed).toEqual([
			{
				key: "atlas.explore:codebase.index-stale",
				fingerprint: "f1",
				expiresAt: undefined,
			},
		]);
	});

	it("treats a malformed column as nothing suppressed rather than failing", () => {
		// This is per-user convenience state. If it is corrupt the right outcome
		// is that the person sees their warnings again, not a broken page.
		expect(parseSuppressions({ bad: { nope: true } })).toEqual([]);
		expect(parseSuppressions("not an object")).toEqual([]);
		expect(parseSuppressions(null)).toEqual([]);
	});

	it("drops expired entries on write so the column self-prunes", () => {
		const out = serializeSuppressions(
			[
				{
					key: "a",
					fingerprint: "f",
					expiresAt: new Date(NOW.getTime() - 1).toISOString(),
				},
				{ key: "b", fingerprint: "g" },
			],
			NOW,
		);
		expect(Object.keys(out)).toEqual(["b"]);
	});

	it("replaces rather than duplicates an existing key", () => {
		const next = withSuppression([{ key: "a", fingerprint: "old" }], {
			key: "a",
			fingerprint: "new",
		});
		expect(next).toEqual([{ key: "a", fingerprint: "new" }]);
	});

	it("restores one entry, or all of them", () => {
		const existing = [
			{ key: "a", fingerprint: "f" },
			{ key: "b", fingerprint: "g" },
		];
		expect(withoutSuppression(existing, "a")).toEqual([
			{ key: "b", fingerprint: "g" },
		]);
		expect(withoutSuppression(existing)).toEqual([]);
	});

	it("refuses to compute an expiry for a session dismissal", () => {
		// It would create a row nothing ever cleans up. The client holds it.
		expect(() => expiryFor("session", NOW)).toThrow();
	});

	it("gives 'forever' no expiry at all", () => {
		expect(expiryFor("forever", NOW)).toBeUndefined();
	});

	it("computes the fixed presets from now", () => {
		expect(expiryFor("7d", NOW)).toBe("2026-09-25T12:00:00.000Z");
	});
});
