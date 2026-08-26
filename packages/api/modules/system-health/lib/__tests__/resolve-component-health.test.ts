/**
 * Unit tests for the health resolver.
 *
 * Every rule that decides what a customer sees lives in this pure function, so
 * these are the tests that matter most on this surface — and none of them needs
 * a database.
 */

import type { PlatformComponentRegistration } from "@repo/observability";
import { describe, expect, it } from "vitest";
import {
	type HealthSignalInputs,
	type HealthStatus,
	impactToStatus,
	isWorse,
	resolveComponent,
	resolveOverallStatus,
	severityToStatus,
	worstStatus,
} from "../resolve-component-health";

const NOW = new Date("2026-08-06T12:00:00.000Z");

function baseInputs(
	overrides: Partial<HealthSignalInputs> = {},
): HealthSignalInputs {
	return {
		serverFaultCount: 0,
		lastBackgroundWorkAt: new Date(NOW.getTime() - 60_000),
		providerHealth: new Map(),
		unhealthyConnectionCount: 0,
		totalConnectionCount: 0,
		relevantProviderIncidentCount: 0,
		incidentStatusByComponent: new Map(),
		announcementStatusByComponent: new Map(),
		now: NOW,
		...overrides,
	};
}

function component(
	overrides: Partial<PlatformComponentRegistration> = {},
): PlatformComponentRegistration {
	return {
		key: "test-component",
		displayName: "Test",
		description: "A test component",
		group: "CORE",
		signal: {
			kind: "tenant-server-faults",
			windowMinutes: 15,
			degradedAt: 5,
			outageAt: 20,
		},
		displayOrder: 1,
		...overrides,
	};
}

describe("status ordering", () => {
	it("ranks a known degradation above an unknown", () => {
		// A known-bad sibling must never be masked by an unknown one.
		expect(isWorse("DEGRADED", "UNKNOWN")).toBe(true);
		expect(worstStatus(["UNKNOWN", "DEGRADED"])).toBe("DEGRADED");
	});

	it("treats NOT_CONFIGURED as better than an outage", () => {
		// Not enabled on this deployment is a deploy-time fact, not a failure.
		expect(isWorse("MAJOR_OUTAGE", "NOT_CONFIGURED")).toBe(true);
		expect(worstStatus(["NOT_CONFIGURED", "OPERATIONAL"])).toBe(
			"NOT_CONFIGURED",
		);
	});

	it("returns OPERATIONAL for an empty list", () => {
		expect(worstStatus([])).toBe("OPERATIONAL");
	});
});

describe("impactToStatus", () => {
	it("maps declared impact onto a status", () => {
		expect(impactToStatus("CRITICAL")).toBe("MAJOR_OUTAGE");
		expect(impactToStatus("MAJOR")).toBe("PARTIAL_OUTAGE");
		expect(impactToStatus("MINOR")).toBe("DEGRADED");
	});

	it("returns null for NONE so an informational note cannot upgrade a sick component", () => {
		expect(impactToStatus("NONE")).toBeNull();
	});
});

describe("severityToStatus", () => {
	it("maps the SEV ladder", () => {
		expect(severityToStatus("SEV1")).toBe("MAJOR_OUTAGE");
		expect(severityToStatus("SEV2")).toBe("PARTIAL_OUTAGE");
		expect(severityToStatus("SEV3")).toBe("DEGRADED");
	});

	it("reports UNKNOWN for an unrecognised severity rather than assuming minor", () => {
		expect(severityToStatus("SEV9")).toBe("UNKNOWN");
	});
});

describe("precedence", () => {
	it("lets a human announcement override a green probe", () => {
		const result = resolveComponent(
			component(),
			baseInputs({
				serverFaultCount: 0,
				announcementStatusByComponent: new Map([
					["test-component", "PARTIAL_OUTAGE" as HealthStatus],
				]),
			}),
		);
		expect(result.status).toBe("PARTIAL_OUTAGE");
		expect(result.source).toBe("announcement");
	});

	it("lets an announcement override a detected incident", () => {
		const result = resolveComponent(
			component(),
			baseInputs({
				incidentStatusByComponent: new Map([
					["test-component", "DEGRADED" as HealthStatus],
				]),
				announcementStatusByComponent: new Map([
					["test-component", "MAJOR_OUTAGE" as HealthStatus],
				]),
			}),
		);
		expect(result.status).toBe("MAJOR_OUTAGE");
		expect(result.source).toBe("announcement");
	});

	it("lets a detected incident override a green probe", () => {
		const result = resolveComponent(
			component(),
			baseInputs({
				incidentStatusByComponent: new Map([
					["test-component", "DEGRADED" as HealthStatus],
				]),
			}),
		);
		expect(result.status).toBe("DEGRADED");
		expect(result.source).toBe("incident");
	});

	it("never leaks internal detail into the customer-visible reason", () => {
		const result = resolveComponent(
			component(),
			baseInputs({
				incidentStatusByComponent: new Map([
					["test-component", "MAJOR_OUTAGE" as HealthStatus],
				]),
			}),
		);
		expect(result.detail).not.toMatch(/SEV|fingerprint|alertmanager/i);
	});
});

describe("tenant-server-faults signal", () => {
	it("is operational below the degraded threshold", () => {
		const result = resolveComponent(
			component(),
			baseInputs({ serverFaultCount: 4 }),
		);
		expect(result.status).toBe("OPERATIONAL");
	});

	it("degrades at the threshold", () => {
		const result = resolveComponent(
			component(),
			baseInputs({ serverFaultCount: 5 }),
		);
		expect(result.status).toBe("DEGRADED");
	});

	it("reports a partial outage at the outage threshold", () => {
		const result = resolveComponent(
			component(),
			baseInputs({ serverFaultCount: 20 }),
		);
		expect(result.status).toBe("PARTIAL_OUTAGE");
	});
});

describe("background-work-freshness signal", () => {
	const freshness = component({
		key: "background-jobs",
		signal: {
			kind: "background-work-freshness",
			degradedAfterMinutes: 10,
			staleAfterMinutes: 30,
		},
	});

	it("is operational when work completed recently", () => {
		const result = resolveComponent(
			freshness,
			baseInputs({
				lastBackgroundWorkAt: new Date(NOW.getTime() - 2 * 60_000),
			}),
		);
		expect(result.status).toBe("OPERATIONAL");
	});

	it("degrades once work is running behind", () => {
		const result = resolveComponent(
			freshness,
			baseInputs({
				lastBackgroundWorkAt: new Date(NOW.getTime() - 15 * 60_000),
			}),
		);
		expect(result.status).toBe("DEGRADED");
	});

	it("reports UNKNOWN rather than green once the signal is stale", () => {
		// The critical case: a dead signal must never render as healthy, and it
		// must not overstate either — we genuinely do not know.
		const result = resolveComponent(
			freshness,
			baseInputs({
				lastBackgroundWorkAt: new Date(NOW.getTime() - 45 * 60_000),
			}),
		);
		expect(result.status).toBe("UNKNOWN");
	});

	it("reports UNKNOWN when nothing has ever run", () => {
		const result = resolveComponent(
			freshness,
			baseInputs({ lastBackgroundWorkAt: null }),
		);
		expect(result.status).toBe("UNKNOWN");
	});
});

describe("provider-rollup signal", () => {
	const rollup = component({
		key: "ai-generation",
		signal: {
			kind: "provider-rollup",
			providerKeys: ["openai", "anthropic"],
		},
	});

	it("takes the worst configured provider", () => {
		const result = resolveComponent(
			rollup,
			baseInputs({
				providerHealth: new Map<string, HealthStatus>([
					["openai", "OPERATIONAL"],
					["anthropic", "MAJOR_OUTAGE"],
				]),
			}),
		);
		expect(result.status).toBe("MAJOR_OUTAGE");
	});

	it("ignores an unconfigured provider when a sibling is healthy", () => {
		// A capability backed by two providers still works when one is simply
		// not wired up in this deployment.
		const result = resolveComponent(
			rollup,
			baseInputs({
				providerHealth: new Map<string, HealthStatus>([
					["openai", "OPERATIONAL"],
					["anthropic", "NOT_CONFIGURED"],
				]),
			}),
		);
		expect(result.status).toBe("OPERATIONAL");
	});

	it("reports NOT_CONFIGURED only when every backing provider is unconfigured", () => {
		const result = resolveComponent(
			rollup,
			baseInputs({
				providerHealth: new Map<string, HealthStatus>([
					["openai", "NOT_CONFIGURED"],
					["anthropic", "NOT_CONFIGURED"],
				]),
			}),
		);
		expect(result.status).toBe("NOT_CONFIGURED");
	});

	it("does not claim an unmonitored capability is switched off", () => {
		// Staging showed AI generation and file storage both reading "not enabled
		// on this deployment" while both demonstrably worked: NOT_CONFIGURED means
		// the probe credential is absent, not that the feature is off. The wording
		// must say what we actually know.
		const result = resolveComponent(
			rollup,
			baseInputs({
				providerHealth: new Map<string, HealthStatus>([
					["openai", "NOT_CONFIGURED"],
					["anthropic", "NOT_CONFIGURED"],
				]),
			}),
		);
		expect(result.detail).not.toMatch(/not enabled/i);
		expect(result.detail).toMatch(/not actively monitoring/i);
		expect(result.detail).toMatch(/may be working normally/i);
	});

	it("reports UNKNOWN for a provider with no registry row", () => {
		const result = resolveComponent(rollup, baseInputs());
		expect(result.status).toBe("UNKNOWN");
	});
});

describe("tenant-connections signal", () => {
	const connections = component({
		key: "integrations",
		signal: { kind: "tenant-connections" },
	});

	it("is operational with no connections at all", () => {
		const result = resolveComponent(connections, baseInputs());
		expect(result.status).toBe("OPERATIONAL");
		expect(result.detail).toContain("no connected tools");
	});

	it("degrades when the tenant's own connections need attention", () => {
		const result = resolveComponent(
			connections,
			baseInputs({
				totalConnectionCount: 9,
				unhealthyConnectionCount: 2,
			}),
		);
		expect(result.status).toBe("DEGRADED");
		expect(result.detail).toContain("2 of your 9");
	});

	it("degrades when a connected provider reports a problem", () => {
		const result = resolveComponent(
			connections,
			baseInputs({
				totalConnectionCount: 3,
				relevantProviderIncidentCount: 1,
			}),
		);
		expect(result.status).toBe("DEGRADED");
	});
});

describe("resolveOverallStatus", () => {
	it("takes the worst component status", () => {
		expect(
			resolveOverallStatus([
				{
					key: "a",
					displayName: "A",
					description: "",
					group: "CORE",
					status: "OPERATIONAL",
					detail: "",
					source: "signal",
				},
				{
					key: "b",
					displayName: "B",
					description: "",
					group: "AI",
					status: "DEGRADED",
					detail: "",
					source: "signal",
				},
			]),
		).toBe("DEGRADED");
	});

	it("ignores components that are simply not enabled here", () => {
		// A deliberately-disabled capability must not make the whole platform
		// read as anything other than operational.
		expect(
			resolveOverallStatus([
				{
					key: "a",
					displayName: "A",
					description: "",
					group: "CORE",
					status: "OPERATIONAL",
					detail: "",
					source: "signal",
				},
				{
					key: "b",
					displayName: "B",
					description: "",
					group: "DATA",
					status: "NOT_CONFIGURED",
					detail: "",
					source: "signal",
				},
			]),
		).toBe("OPERATIONAL");
	});

	it("does NOT claim operational when nothing is monitored at all", () => {
		// The dangerous case the rule above creates. Filtering NOT_CONFIGURED out
		// is right when SOME component is monitored — one disabled capability must
		// not drag the page down. But when EVERY component is unconfigured the
		// filter empties the list, and `worstStatus([])` seeds at "OPERATIONAL", so
		// a deployment with no probes wired would tell customers "All systems
		// operational" on the strength of having measured nothing.
		//
		// Reachable: `NOT_CONFIGURED` is exactly the state a component reports when
		// its probe credential is absent in an environment, and a deployed
		// environment was observed with `ai-generation` in it.
		expect(
			resolveOverallStatus([
				{
					key: "a",
					displayName: "A",
					description: "",
					group: "CORE",
					status: "NOT_CONFIGURED",
					detail: "",
					source: "signal",
				},
				{
					key: "b",
					displayName: "B",
					description: "",
					group: "DATA",
					status: "NOT_CONFIGURED",
					detail: "",
					source: "signal",
				},
			]),
		).toBe("UNKNOWN");
	});

	it("does not claim operational for an empty component list either", () => {
		// Same reasoning: an empty registry has measured nothing.
		expect(resolveOverallStatus([])).toBe("UNKNOWN");
	});
});

describe("the banner cannot contradict a live announcement", () => {
	// Found by looking at a screenshot of the real page: "All systems operational"
	// sat directly above "Degraded AI generation — Major impact". `affectedComponentKeys`
	// is optional (the authoring form requires only a title and a body), so an
	// announcement can paint no component and leave the banner green. It became
	// reachable at scale once the sweeper started notifying owners and admins about
	// exactly these announcements and sending them to this page to look.
	const operational = [
		{ status: "OPERATIONAL" as const },
		{ status: "OPERATIONAL" as const },
	] as Parameters<typeof resolveOverallStatus>[0];

	it("a MAJOR announcement degrades an otherwise-green board", () => {
		expect(resolveOverallStatus(operational, ["PARTIAL_OUTAGE"])).toBe(
			"PARTIAL_OUTAGE",
		);
	});

	it("a CRITICAL announcement outranks a MAJOR component", () => {
		const mixed = [
			{ status: "OPERATIONAL" as const },
			{ status: "PARTIAL_OUTAGE" as const },
		] as Parameters<typeof resolveOverallStatus>[0];

		expect(resolveOverallStatus(mixed, ["MAJOR_OUTAGE"])).toBe(
			"MAJOR_OUTAGE",
		);
	});

	it("a worse COMPONENT still wins over a milder announcement", () => {
		// The fold is symmetric: announcements raise the floor, they do not cap it.
		const outage = [{ status: "MAJOR_OUTAGE" as const }] as Parameters<
			typeof resolveOverallStatus
		>[0];

		expect(resolveOverallStatus(outage, ["DEGRADED"])).toBe("MAJOR_OUTAGE");
	});

	it("no announcements leaves the component verdict untouched", () => {
		expect(resolveOverallStatus(operational)).toBe("OPERATIONAL");
		expect(resolveOverallStatus(operational, [])).toBe("OPERATIONAL");
	});

	it("an announcement beats UNKNOWN when nothing is monitored", () => {
		// A deployment with no probes wired answers UNKNOWN. An announcement is a
		// first-hand statement that something is wrong, so it outranks "we cannot
		// tell you" rather than being swallowed by it.
		const nothingMonitored = [
			{ status: "NOT_CONFIGURED" as const },
		] as Parameters<typeof resolveOverallStatus>[0];

		expect(resolveOverallStatus(nothingMonitored)).toBe("UNKNOWN");
		expect(resolveOverallStatus(nothingMonitored, ["PARTIAL_OUTAGE"])).toBe(
			"PARTIAL_OUTAGE",
		);
	});

	it("an informational NONE-impact announcement leaves the banner green", () => {
		// impactToStatus maps NONE to null and build-overview filters those out, so
		// nothing reaches this function. Asserted so the contract stays explicit.
		expect(impactToStatus("NONE")).toBeNull();
		expect(resolveOverallStatus(operational, [])).toBe("OPERATIONAL");
	});
});
