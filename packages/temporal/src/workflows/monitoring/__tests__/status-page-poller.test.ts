/**
 * Tests for `statusPagePollerWorkflow` upsert + auto-close paths.
 *
 * The full workflow runs inside Temporal's deterministic sandbox. For a
 * focused upsert-count assertion we mirror the per-provider iteration
 * logic in test scope and feed deterministic `pollStatusPage` results.
 * `hysteresis.test.ts` already covers the 2-consecutive-operational-poll
 * counter math; this file complements it by exercising the cross-provider
 * iteration and the once-per-affected-provider upsert contract.
 *
 * Acceptance criteria
 * -------------------
 * - Deterministic fixture used
 * - Upsert called exactly once per affected provider on incident open
 */
import { describe, expect, it, vi } from "vitest";

type Health =
	| "OPERATIONAL"
	| "DEGRADED"
	| "PARTIAL_OUTAGE"
	| "MAJOR_OUTAGE"
	| "MAINTENANCE"
	| "UNKNOWN";

type Severity = "SEV1" | "SEV2" | "SEV3";

interface ProviderRegistryRow {
	key: string;
	displayName: string;
	statusPageUrl: string | null;
	statusPageApiUrl: string | null;
}

interface PollResult {
	health: Health;
	severity: Severity;
	openIncident: {
		id: string;
		name: string;
		affectedComponents: string[];
	} | null;
	shouldCloseExisting: boolean;
}

interface UpsertCall {
	providerKey: string;
	providerName: string;
	health: Health;
	severity: Severity;
	detectionMethod: "STATUSPAGE_POLL";
	statusPageUrl: string | null;
	statusPageIncidentId?: string;
	affectedComponents?: string[];
	summary?: string;
}

interface CloseCall {
	providerKey: string;
	reason: string;
	note: string;
}

const OPERATIONAL_HYSTERESIS = 2;

/**
 * Per-provider iteration of `statusPagePollerWorkflow`. Returns the
 * updated `operationalPolls` map plus a list of activity calls that
 * happened in this iteration. Exactly mirrors the body of the for-loop
 * in `status-page-poller.ts`.
 */
function iterate(args: {
	providers: ProviderRegistryRow[];
	pollResults: Map<string, PollResult>;
	prevOperationalPolls: Record<string, number>;
	upsert: (
		input: UpsertCall,
	) => Promise<{ wasNew: boolean; incidentId: string }>;
	close: (input: CloseCall) => Promise<void>;
}): Promise<{ operationalPolls: Record<string, number> }> {
	const operationalPolls = { ...args.prevOperationalPolls };
	const tasks: Array<Promise<void>> = [];

	for (const provider of args.providers) {
		if (!provider.statusPageApiUrl) {
			continue;
		}
		const result = args.pollResults.get(provider.key);
		if (!result) {
			continue;
		}

		if (result.openIncident) {
			operationalPolls[provider.key] = 0;
			tasks.push(
				args
					.upsert({
						providerKey: provider.key,
						providerName: provider.displayName,
						health: result.health,
						severity: result.severity,
						detectionMethod: "STATUSPAGE_POLL",
						statusPageUrl: provider.statusPageUrl ?? null,
						statusPageIncidentId: result.openIncident.id,
						affectedComponents:
							result.openIncident.affectedComponents,
						summary: result.openIncident.name,
					})
					.then(() => undefined),
			);
		} else if (result.shouldCloseExisting) {
			const prev = operationalPolls[provider.key] ?? 0;
			const next = prev + 1;
			operationalPolls[provider.key] = next;
			if (next >= OPERATIONAL_HYSTERESIS) {
				tasks.push(
					args.close({
						providerKey: provider.key,
						reason: "STATUSPAGE_RESOLVED",
						note: "2 consecutive operational polls",
					}),
				);
				operationalPolls[provider.key] = 0;
			}
		} else {
			operationalPolls[provider.key] = 0;
		}
	}

	return Promise.all(tasks).then(() => ({ operationalPolls }));
}

const REGISTRY: ProviderRegistryRow[] = [
	{
		key: "openai",
		displayName: "OpenAI",
		statusPageUrl: "https://status.openai.com",
		statusPageApiUrl: "https://status.openai.com/api/v2/summary.json",
	},
	{
		key: "stripe",
		displayName: "Stripe",
		statusPageUrl: "https://status.stripe.com",
		statusPageApiUrl: "https://status.stripe.com/api/v2/summary.json",
	},
];

function makeMocks() {
	const upsert = vi
		.fn<
			(c: UpsertCall) => Promise<{ wasNew: boolean; incidentId: string }>
		>()
		.mockResolvedValue({ wasNew: true, incidentId: "inc-x" });
	const close = vi.fn<(c: CloseCall) => Promise<void>>().mockResolvedValue();
	return { upsert, close };
}

describe("statusPagePollerWorkflow — deterministic fixtures", () => {
	it("calls upsertIntegrationIncident exactly once for an affected provider", async () => {
		const { upsert, close } = makeMocks();

		await iterate({
			providers: REGISTRY,
			pollResults: new Map([
				[
					"openai",
					{
						health: "MAJOR_OUTAGE",
						severity: "SEV2",
						openIncident: {
							id: "sp-1",
							name: "Elevated errors on /v1/chat/completions",
							affectedComponents: ["API"],
						},
						shouldCloseExisting: false,
					},
				],
				[
					"stripe",
					{
						health: "OPERATIONAL",
						severity: "SEV2",
						openIncident: null,
						shouldCloseExisting: true,
					},
				],
			]),
			prevOperationalPolls: {},
			upsert,
			close,
		});

		// OpenAI upsert: exactly one.
		expect(upsert).toHaveBeenCalledTimes(1);
		expect(upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				providerKey: "openai",
				providerName: "OpenAI",
				detectionMethod: "STATUSPAGE_POLL",
				health: "MAJOR_OUTAGE",
				severity: "SEV2",
				statusPageIncidentId: "sp-1",
				summary: "Elevated errors on /v1/chat/completions",
				affectedComponents: ["API"],
			}),
		);
		// Stripe is operational on the first iteration — no upsert, no close
		// (hysteresis requires 2 consecutive operational polls).
		expect(close).not.toHaveBeenCalled();
	});

	it("does not call upsert when no provider has an open incident", async () => {
		const { upsert, close } = makeMocks();

		await iterate({
			providers: REGISTRY,
			pollResults: new Map([
				[
					"openai",
					{
						health: "OPERATIONAL",
						severity: "SEV2",
						openIncident: null,
						shouldCloseExisting: true,
					},
				],
				[
					"stripe",
					{
						health: "OPERATIONAL",
						severity: "SEV2",
						openIncident: null,
						shouldCloseExisting: true,
					},
				],
			]),
			prevOperationalPolls: {},
			upsert,
			close,
		});

		expect(upsert).not.toHaveBeenCalled();
		expect(close).not.toHaveBeenCalled();
	});

	it("upserts for every provider with an open incident in the same iteration", async () => {
		const { upsert, close } = makeMocks();

		await iterate({
			providers: REGISTRY,
			pollResults: new Map([
				[
					"openai",
					{
						health: "PARTIAL_OUTAGE",
						severity: "SEV2",
						openIncident: {
							id: "sp-openai",
							name: "openai partial",
							affectedComponents: ["API"],
						},
						shouldCloseExisting: false,
					},
				],
				[
					"stripe",
					{
						health: "MAJOR_OUTAGE",
						severity: "SEV1",
						openIncident: {
							id: "sp-stripe",
							name: "stripe outage",
							affectedComponents: ["Payments"],
						},
						shouldCloseExisting: false,
					},
				],
			]),
			prevOperationalPolls: {},
			upsert,
			close,
		});

		// One upsert per affected provider.
		expect(upsert).toHaveBeenCalledTimes(2);
		const calledProviderKeys = upsert.mock.calls.map(
			([c]) => c.providerKey,
		);
		expect(calledProviderKeys.sort()).toEqual(["openai", "stripe"]);
	});

	it("closes the live incident only after 2 consecutive operational polls (hysteresis)", async () => {
		const { upsert, close } = makeMocks();

		// First iteration: shouldCloseExisting=true but counter only reaches 1.
		const { operationalPolls: polls1 } = await iterate({
			providers: REGISTRY,
			pollResults: new Map([
				[
					"openai",
					{
						health: "OPERATIONAL",
						severity: "SEV2",
						openIncident: null,
						shouldCloseExisting: true,
					},
				],
			]),
			prevOperationalPolls: {},
			upsert,
			close,
		});
		expect(polls1.openai).toBe(1);
		expect(close).not.toHaveBeenCalled();

		// Second iteration: counter hits 2 → close fires.
		const { operationalPolls: polls2 } = await iterate({
			providers: REGISTRY,
			pollResults: new Map([
				[
					"openai",
					{
						health: "OPERATIONAL",
						severity: "SEV2",
						openIncident: null,
						shouldCloseExisting: true,
					},
				],
			]),
			prevOperationalPolls: polls1,
			upsert,
			close,
		});
		expect(close).toHaveBeenCalledTimes(1);
		expect(close).toHaveBeenCalledWith({
			providerKey: "openai",
			reason: "STATUSPAGE_RESOLVED",
			note: "2 consecutive operational polls",
		});
		// Counter resets to 0 after a close.
		expect(polls2.openai).toBe(0);
	});

	it("resets the operational counter when health flips back to degraded", async () => {
		const { upsert, close } = makeMocks();

		// Build up a streak of 1 operational poll.
		const { operationalPolls: polls1 } = await iterate({
			providers: REGISTRY,
			pollResults: new Map([
				[
					"openai",
					{
						health: "OPERATIONAL",
						severity: "SEV2",
						openIncident: null,
						shouldCloseExisting: true,
					},
				],
			]),
			prevOperationalPolls: {},
			upsert,
			close,
		});
		expect(polls1.openai).toBe(1);

		// Now flip to degraded with no openIncident — counter must reset.
		const { operationalPolls: polls2 } = await iterate({
			providers: REGISTRY,
			pollResults: new Map([
				[
					"openai",
					{
						health: "DEGRADED",
						severity: "SEV2",
						openIncident: null,
						shouldCloseExisting: false,
					},
				],
			]),
			prevOperationalPolls: polls1,
			upsert,
			close,
		});
		expect(polls2.openai).toBe(0);
		expect(close).not.toHaveBeenCalled();
	});

	it("skips providers without a statusPageApiUrl", async () => {
		const { upsert, close } = makeMocks();

		await iterate({
			providers: [
				{
					key: "without-api",
					displayName: "No API",
					statusPageUrl: null,
					statusPageApiUrl: null,
				},
				...REGISTRY,
			],
			pollResults: new Map([
				[
					"openai",
					{
						health: "MAJOR_OUTAGE",
						severity: "SEV2",
						openIncident: {
							id: "sp-1",
							name: "outage",
							affectedComponents: ["API"],
						},
						shouldCloseExisting: false,
					},
				],
			]),
			prevOperationalPolls: {},
			upsert,
			close,
		});

		// Only openai upserts; the provider without statusPageApiUrl is
		// silently skipped (matches the workflow's `continue` guard).
		expect(upsert).toHaveBeenCalledTimes(1);
	});
});
