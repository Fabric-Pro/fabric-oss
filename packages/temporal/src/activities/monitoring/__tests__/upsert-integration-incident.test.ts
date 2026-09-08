/**
 * Tests for `upsertIntegrationIncident` and `closeIntegrationIncident`
 *.
 *
 * Focus areas:
 *   - Idempotency: re-calling with the same statusPageIncidentId reuses
 *     the existing row (no duplicate).
 *   - Re-fire transition: AUTO_RESOLVED→FIRED within 1h records
 *     IncidentEvent.RE_FIRED on the new row.
 *   - Registry row reconciliation: written when health or the incident
 *     pointer changed, or when the throttled heartbeat went stale —
 *     skipped otherwise.
 *   - Close path resolves only when an active row exists; idempotent if
 *     no row to close.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory mock state — minimal subset of Prisma surface we exercise.
const state = {
	incidents: [] as Array<{
		id: string;
		providerKey: string;
		providerName: string;
		status: "FIRING" | "ACKNOWLEDGED" | "RESOLVED";
		severity: "SEV1" | "SEV2" | "SEV3";
		health: string;
		detectionMethod: string;
		statusPageIncidentId: string | null;
		affectedComponents: string[];
		summary: string | null;
		startedAt: Date;
		resolvedAt: Date | null;
	}>,
	events: [] as Array<{
		id: string;
		integrationIncidentId: string;
		eventType: string;
		message: string | null;
		payload: unknown;
		createdAt: Date;
	}>,
	registry: new Map<
		string,
		{
			providerKey: string;
			currentHealth: string;
			lastIncidentId?: string | null;
			lastPolledAt?: Date | null;
		}
	>(),
	/**
	 * Every `integrationProviderRegistry.update` the activities issued.
	 * The registry is now written through `touchProviderRegistry`, which
	 * skips the UPDATE when nothing changed and the heartbeat is fresh —
	 * so "did this poll rewrite the durable row?" is itself under test.
	 */
	registryUpdates: [] as Array<Record<string, unknown>>,
	/**
	 * Flip to make the registry read throw. The registry write happens
	 * AFTER the incident row and its event are committed, so a registry
	 * failure must never fail the activity — see the best-effort cases
	 * below.
	 */
	registryReadFails: false,
};

let idCounter = 0;
function nextId(prefix: string): string {
	idCounter += 1;
	return `${prefix}-${idCounter}`;
}

vi.mock("@repo/database", () => ({
	setAiUsageRecorder: vi.fn(),
	db: {
		integrationIncident: {
			findFirst: vi.fn(async ({ where, orderBy }: any) => {
				let rows = state.incidents.filter(
					(i) => i.providerKey === where.providerKey,
				);
				if (where.status?.in) {
					rows = rows.filter((i) =>
						where.status.in.includes(i.status),
					);
				} else if (where.status) {
					rows = rows.filter((i) => i.status === where.status);
				}
				if (orderBy?.startedAt === "desc") {
					rows = [...rows].sort(
						(a, b) => b.startedAt.getTime() - a.startedAt.getTime(),
					);
				}
				if (orderBy?.resolvedAt === "desc") {
					rows = [...rows].sort(
						(a, b) =>
							(b.resolvedAt?.getTime() ?? 0) -
							(a.resolvedAt?.getTime() ?? 0),
					);
				}
				return rows[0] ?? null;
			}),
			findUnique: vi.fn(async ({ where }: any) => {
				if (!where.statusPageIncidentId) {
					return null;
				}
				return (
					state.incidents.find(
						(i) =>
							i.statusPageIncidentId ===
							where.statusPageIncidentId,
					) ?? null
				);
			}),
			create: vi.fn(async ({ data, select }: any) => {
				// `statusPageIncidentId` is @unique in the schema. The mock enforces
				// it because without that this harness happily accepted a duplicate
				// the database rejects — which is how a P2002 firing thousands of
				// times a week in production sat under twelve passing tests.
				if (
					data.statusPageIncidentId &&
					state.incidents.some(
						(i) =>
							i.statusPageIncidentId ===
							data.statusPageIncidentId,
					)
				) {
					throw Object.assign(
						new Error(
							'Unique constraint failed on the fields: (`"statusPageIncidentId"`)',
						),
						{ code: "P2002" },
					);
				}
				const id = nextId("incident");
				const row = {
					id,
					providerKey: data.providerKey,
					providerName: data.providerName,
					status: data.status ?? "FIRING",
					severity: data.severity,
					health: data.health,
					detectionMethod: data.detectionMethod,
					statusPageIncidentId: data.statusPageIncidentId ?? null,
					affectedComponents: data.affectedComponents ?? [],
					summary: data.summary ?? null,
					startedAt: new Date(),
					resolvedAt: null,
				};
				state.incidents.push(row);
				return select ? { id } : row;
			}),
			update: vi.fn(async ({ where, data }: any) => {
				const row = state.incidents.find((i) => i.id === where.id);
				if (!row) {
					throw new Error(`incident not found: ${where.id}`);
				}
				Object.assign(row, data);
				return row;
			}),
		},
		incidentEvent: {
			create: vi.fn(async ({ data }: any) => {
				const row = {
					id: nextId("event"),
					integrationIncidentId: data.integrationIncidentId,
					eventType: data.eventType,
					message: data.message ?? null,
					payload: data.payload,
					createdAt: new Date(),
				};
				state.events.push(row);
				return row;
			}),
		},
		integrationProviderRegistry: {
			findUnique: vi.fn(async ({ where }: any) => {
				if (state.registryReadFails) {
					throw new Error("registry unreachable");
				}
				const reg = state.registry.get(where.providerKey);
				if (!reg) {
					return null;
				}
				return {
					currentHealth: reg.currentHealth,
					lastIncidentId: reg.lastIncidentId ?? null,
					lastPolledAt: reg.lastPolledAt ?? null,
				};
			}),
			update: vi.fn(async ({ where, data }: any) => {
				const reg = state.registry.get(where.providerKey);
				if (!reg) {
					throw Object.assign(new Error("not found"), {
						code: "P2025",
					});
				}
				state.registryUpdates.push(data);
				Object.assign(reg, data);
				return reg;
			}),
		},
	},
	// D17 incidents→audit bridge: the upsert/close helpers emit a
	// fire-and-forget `recordAudit(...)` call. The test asserts on the
	// incident-table side effects, not the audit emit, so we just
	// provide a no-op stub.
	recordAudit: vi.fn(),
}));

import { closeIntegrationIncident } from "../close-integration-incident";
import { upsertIntegrationIncident } from "../upsert-integration-incident";

beforeEach(() => {
	state.incidents.length = 0;
	state.events.length = 0;
	state.registry.clear();
	state.registryUpdates.length = 0;
	state.registryReadFails = false;
	// Seed a registry row so the update succeeds for the happy path. A
	// null `lastPolledAt` reads as a stale heartbeat, so the first touch
	// of each test always writes.
	state.registry.set("openai", {
		providerKey: "openai",
		currentHealth: "OPERATIONAL",
		lastIncidentId: null,
		lastPolledAt: null,
	});
	idCounter = 0;
});

describe("upsertIntegrationIncident — provider re-reports a closed incident", () => {
	const input = {
		providerKey: "openai",
		providerName: "OpenAI",
		health: "PARTIAL_OUTAGE" as const,
		severity: "SEV2" as const,
		detectionMethod: "STATUSPAGE_POLL" as const,
		statusPageIncidentId: "inc-reopened",
		affectedComponents: ["API"],
		summary: "Elevated error rates",
	};

	it("reopens the resolved row instead of inserting a duplicate", async () => {
		// The production sequence: an incident fires, gets closed, and the
		// provider keeps listing it. The id is unique, so the second upsert
		// used to attempt an insert carrying an id the resolved row already
		// owned, failing with P2002 on every poll for as long as the provider
		// reported it — roughly 3,300 times a week.
		const first = await upsertIntegrationIncident(input);
		await closeIntegrationIncident({
			providerKey: "openai",
			reason: "STATUSPAGE_RESOLVED",
			note: "operational again",
		});
		expect(
			state.incidents.find((i) => i.id === first.incidentId)?.status,
		).toBe("RESOLVED");

		const second = await upsertIntegrationIncident(input);

		expect(second.incidentId).toBe(first.incidentId);
		expect(second.reFired).toBe(true);
		expect(state.incidents).toHaveLength(1);
	});

	it("clears resolvedAt so the reopened incident reads as live", async () => {
		const first = await upsertIntegrationIncident(input);
		await closeIntegrationIncident({
			providerKey: "openai",
			reason: "STATUSPAGE_RESOLVED",
			note: "operational again",
		});
		await upsertIntegrationIncident(input);

		const row = state.incidents.find((i) => i.id === first.incidentId);
		expect(row?.status).toBe("FIRING");
		expect(row?.resolvedAt).toBeNull();
	});

	it("records RE_FIRED and asks for a fresh lifecycle", async () => {
		await upsertIntegrationIncident(input);
		await closeIntegrationIncident({
			providerKey: "openai",
			reason: "STATUSPAGE_RESOLVED",
			note: "operational again",
		});
		const second = await upsertIntegrationIncident(input);

		expect(state.events.map((e) => e.eventType)).toContain("RE_FIRED");
		// wasNew drives the lifecycle workflow, which a reopened incident needs
		// as much as a fresh one.
		expect(second.wasNew).toBe(true);
	});
});

describe("upsertIntegrationIncident", () => {
	const baseInput = {
		providerKey: "openai",
		providerName: "OpenAI",
		health: "PARTIAL_OUTAGE" as const,
		severity: "SEV2" as const,
		detectionMethod: "STATUSPAGE_POLL" as const,
		statusPageIncidentId: "inc-abc",
		affectedComponents: ["API"],
		summary: "Test outage",
	};

	it("creates a new incident with FIRED event on first call", async () => {
		const result = await upsertIntegrationIncident(baseInput);
		expect(result.wasNew).toBe(true);
		expect(result.reFired).toBe(false);
		expect(state.incidents).toHaveLength(1);
		expect(state.events).toHaveLength(1);
		expect(state.events[0].eventType).toBe("FIRED");
	});

	it("is idempotent: second call with same statusPageIncidentId reuses the row", async () => {
		const first = await upsertIntegrationIncident(baseInput);
		const second = await upsertIntegrationIncident(baseInput);
		expect(second.wasNew).toBe(false);
		expect(second.incidentId).toBe(first.incidentId);
		expect(state.incidents).toHaveLength(1);
		expect(state.events).toHaveLength(1); // No duplicate FIRED event.
	});

	it("updates registry row currentHealth on each upsert", async () => {
		await upsertIntegrationIncident(baseInput);
		expect(state.registry.get("openai")?.currentHealth).toBe(
			"PARTIAL_OUTAGE",
		);
		expect(state.registryUpdates.at(-1)).toMatchObject({
			currentHealth: "PARTIAL_OUTAGE",
			lastIncidentId: "incident-1",
		});
	});

	it("does NOT rewrite the registry on a continuation poll when health and incident are unchanged and the heartbeat is fresh", async () => {
		// The churn this guards: the status-page poller re-runs every 2
		// minutes for as long as an incident stays open, and every one of
		// those ticks used to rewrite the durable registry row purely to
		// move `lastPolledAt` forward.
		await upsertIntegrationIncident(baseInput);
		expect(state.registryUpdates).toHaveLength(1);

		const second = await upsertIntegrationIncident(baseInput);

		expect(second.wasNew).toBe(false);
		// The first upsert stamped `lastPolledAt`, so the second poll finds
		// a fresh heartbeat with identical health / incident id and skips
		// the write entirely.
		expect(state.registryUpdates).toHaveLength(1);
	});

	it("still refreshes the registry heartbeat once the stored timestamp goes stale", async () => {
		await upsertIntegrationIncident(baseInput);
		expect(state.registryUpdates).toHaveLength(1);

		// Age the stored heartbeat past the throttle window.
		const reg = state.registry.get("openai");
		if (reg) {
			reg.lastPolledAt = new Date(Date.now() - 10 * 60_000);
		}

		await upsertIntegrationIncident(baseInput);

		expect(state.registryUpdates).toHaveLength(2);
		expect(state.registryUpdates[1]).toEqual({
			lastPolledAt: expect.any(Date),
		});
	});

	// Regression #1021 follow-up: when a pre-fix parser wrote a literal
	// markdown heading (e.g. `**Summary**`) into the column, subsequent
	// polls with a fresh, clean summary must overwrite it — even when
	// health / severity / components don't change between polls. Without
	// this, the staging Gmail row stayed pinned at `**Summary**` for
	// hours because the rest of the data was identical poll-over-poll.
	it("refreshes a stale summary on a continuation poll even when other fields are unchanged", async () => {
		// First poll wrote a literal-heading summary (the bug).
		await upsertIntegrationIncident({
			...baseInput,
			summary: "**Summary**",
		});
		expect(state.incidents[0].summary).toBe("**Summary**");

		// Second poll: identical health/severity/components, but a fresh
		// clean summary from the fixed parser.
		await upsertIntegrationIncident({
			...baseInput,
			summary: "Some users may be unable to send messages.",
		});

		expect(state.incidents).toHaveLength(1);
		expect(state.incidents[0].summary).toBe(
			"Some users may be unable to send messages.",
		);
		// And still no duplicate FIRED event — the row was a continuation.
		expect(
			state.events.filter((e) => e.eventType === "FIRED"),
		).toHaveLength(1);
	});

	it("does NOT clear an existing summary when the incoming poll's summary is null/empty", async () => {
		// Defensive: a workflow path that calls upsert without a summary
		// (e.g. a degraded state where the openIncident.name is missing)
		// must not blank a previously-good description.
		await upsertIntegrationIncident({
			...baseInput,
			summary: "Active outage affecting payments",
		});
		expect(state.incidents[0].summary).toBe(
			"Active outage affecting payments",
		);

		await upsertIntegrationIncident({
			...baseInput,
			summary: null,
		});
		expect(state.incidents[0].summary).toBe(
			"Active outage affecting payments",
		);

		await upsertIntegrationIncident({
			...baseInput,
			summary: "   ", // whitespace-only — treated as empty
		});
		expect(state.incidents[0].summary).toBe(
			"Active outage affecting payments",
		);
	});

	it("records RE_FIRED when a previous incident auto-resolved within 1h", async () => {
		// Seed a resolved row from 30 minutes ago.
		state.incidents.push({
			id: "old",
			providerKey: "openai",
			providerName: "OpenAI",
			status: "RESOLVED",
			severity: "SEV2",
			health: "OPERATIONAL",
			detectionMethod: "STATUSPAGE_POLL",
			statusPageIncidentId: "inc-old",
			affectedComponents: [],
			summary: null,
			startedAt: new Date(Date.now() - 60 * 60 * 1000),
			resolvedAt: new Date(Date.now() - 30 * 60 * 1000),
		});

		const result = await upsertIntegrationIncident({
			...baseInput,
			statusPageIncidentId: "inc-new",
		});
		expect(result.reFired).toBe(true);
		const event = state.events.find(
			(e) => e.integrationIncidentId === result.incidentId,
		);
		expect(event?.eventType).toBe("RE_FIRED");
	});

	it("still reports wasNew:true when the registry read fails after the incident is persisted", async () => {
		// The registry touch runs after the incident row and its FIRED
		// event are committed. If a registry failure propagated, the
		// activity would fail, and the retry would find the incident
		// already present and return `wasNew: false` — at which point
		// status-page-poller.ts never starts the lifecycle workflow and
		// nobody is notified about a live outage.
		state.registryReadFails = true;

		const result = await upsertIntegrationIncident(baseInput);

		expect(result.wasNew).toBe(true);
		expect(state.incidents).toHaveLength(1);
		expect(state.events[0].eventType).toBe("FIRED");
		expect(state.registryUpdates).toHaveLength(0);
	});

	it("does NOT mark RE_FIRED when the previous incident is older than 1h", async () => {
		// Seed a resolved row from 2 hours ago.
		state.incidents.push({
			id: "old",
			providerKey: "openai",
			providerName: "OpenAI",
			status: "RESOLVED",
			severity: "SEV2",
			health: "OPERATIONAL",
			detectionMethod: "STATUSPAGE_POLL",
			statusPageIncidentId: "inc-very-old",
			affectedComponents: [],
			summary: null,
			startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
			resolvedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
		});

		const result = await upsertIntegrationIncident({
			...baseInput,
			statusPageIncidentId: "inc-fresh",
		});
		expect(result.reFired).toBe(false);
	});
});

describe("closeIntegrationIncident", () => {
	it("marks the active incident RESOLVED and records AUTO_RESOLVED event", async () => {
		state.incidents.push({
			id: "live",
			providerKey: "openai",
			providerName: "OpenAI",
			status: "FIRING",
			severity: "SEV2",
			health: "PARTIAL_OUTAGE",
			detectionMethod: "STATUSPAGE_POLL",
			statusPageIncidentId: "inc-live",
			affectedComponents: [],
			summary: null,
			startedAt: new Date(),
			resolvedAt: null,
		});

		const result = await closeIntegrationIncident({
			providerKey: "openai",
			reason: "STATUSPAGE_RESOLVED",
		});
		expect(result.resolved).toBe(true);
		expect(state.incidents[0].status).toBe("RESOLVED");
		expect(state.incidents[0].resolvedAt).not.toBeNull();
		expect(state.events[0]?.eventType).toBe("AUTO_RESOLVED");
	});

	it("is a no-op when no active incident exists", async () => {
		const result = await closeIntegrationIncident({
			providerKey: "openai",
			reason: "STATUSPAGE_RESOLVED",
		});
		expect(result.resolved).toBe(false);
		expect(result.incidentId).toBeNull();
	});

	it("flips the registry row to OPERATIONAL even when no active incident", async () => {
		state.registry.set("openai", {
			providerKey: "openai",
			currentHealth: "MAJOR_OUTAGE",
			lastIncidentId: null,
			lastPolledAt: null,
		});

		await closeIntegrationIncident({
			providerKey: "openai",
			reason: "STATUSPAGE_RESOLVED",
		});
		expect(state.registry.get("openai")?.currentHealth).toBe("OPERATIONAL");
	});

	it("does NOT rewrite the registry on a repeat healthy close when the heartbeat is fresh", async () => {
		// A healthy provider reaches this branch every time the poller's
		// 2-poll operational hysteresis clears. Once the row already reads
		// OPERATIONAL with a fresh heartbeat there is nothing to write.
		await closeIntegrationIncident({
			providerKey: "openai",
			reason: "STATUSPAGE_RESOLVED",
		});
		expect(state.registryUpdates).toHaveLength(1);

		await closeIntegrationIncident({
			providerKey: "openai",
			reason: "STATUSPAGE_RESOLVED",
		});
		expect(state.registryUpdates).toHaveLength(1);
	});

	it("still reports resolved:true when the registry read fails after the incident is resolved", async () => {
		// Same invariant as the upsert path: the registry touch is the last
		// thing this activity does, long after the incident row flipped to
		// RESOLVED and the AUTO_RESOLVED event was written. A registry
		// failure must not fail the activity and force a retry over
		// already-committed work.
		state.incidents.push({
			id: "live",
			providerKey: "openai",
			providerName: "OpenAI",
			status: "FIRING",
			severity: "SEV2",
			health: "PARTIAL_OUTAGE",
			detectionMethod: "STATUSPAGE_POLL",
			statusPageIncidentId: "inc-live",
			affectedComponents: [],
			summary: null,
			startedAt: new Date(),
			resolvedAt: null,
		});
		state.registryReadFails = true;

		const result = await closeIntegrationIncident({
			providerKey: "openai",
			reason: "STATUSPAGE_RESOLVED",
		});

		expect(result.resolved).toBe(true);
		expect(result.incidentId).toBe("live");
		expect(state.incidents[0].status).toBe("RESOLVED");
		expect(state.registryUpdates).toHaveLength(0);
	});

	// Bug 2: when the close reason is NOT_CONFIGURED, the registry row's
	// currentHealth must be preserved (it was set by markProviderNotConfigured
	// before this activity ran). Overwriting it with OPERATIONAL would
	// race against the gray-badge UI signal that says "we can't probe this
	// provider at all."
	describe("reason=NOT_CONFIGURED — staging follow-up", () => {
		it("does NOT overwrite NOT_CONFIGURED currentHealth on the registry row", async () => {
			state.registry.set("stripe", {
				providerKey: "stripe",
				currentHealth: "NOT_CONFIGURED",
				// Non-null so "lastIncidentId is preserved" is actually
				// exercised rather than passing because it was never set.
				lastIncidentId: "stripe-stale",
				lastPolledAt: null,
			});
			state.incidents.push({
				id: "stripe-stale",
				providerKey: "stripe",
				providerName: "Stripe",
				status: "FIRING",
				severity: "SEV2",
				health: "MAJOR_OUTAGE",
				detectionMethod: "SYNTHETIC_PROBE",
				statusPageIncidentId: null,
				affectedComponents: [],
				summary: "STRIPE_SECRET_KEY not set in this environment",
				startedAt: new Date(Date.now() - 9 * 60 * 60 * 1000),
				resolvedAt: null,
			});

			const result = await closeIntegrationIncident({
				providerKey: "stripe",
				reason: "NOT_CONFIGURED",
				note: "Provider transitioned to NOT_CONFIGURED",
			});

			expect(result.resolved).toBe(true);
			expect(result.incidentId).toBe("stripe-stale");
			// Incident row flipped to RESOLVED.
			expect(state.incidents[0].status).toBe("RESOLVED");
			expect(state.incidents[0].resolvedAt).not.toBeNull();
			// And, critically, the terminal `health` on the row reflects
			// NOT_CONFIGURED — not "OPERATIONAL" — so the audit trail
			// preserves the cause.
			expect(state.incidents[0].health).toBe("NOT_CONFIGURED");
			// Registry row stays NOT_CONFIGURED, and the deep-link target
			// survives the close.
			expect(state.registry.get("stripe")?.currentHealth).toBe(
				"NOT_CONFIGURED",
			);
			expect(state.registry.get("stripe")?.lastIncidentId).toBe(
				"stripe-stale",
			);
			// Asserting on the written payload directly: neither column may
			// appear in it at all, so this cannot pass by coincidence of the
			// stored value already matching.
			expect(state.registryUpdates).toHaveLength(1);
			expect(state.registryUpdates[0]).not.toHaveProperty(
				"currentHealth",
			);
			expect(state.registryUpdates[0]).not.toHaveProperty(
				"lastIncidentId",
			);
			expect(state.registryUpdates[0]).toEqual({
				lastPolledAt: expect.any(Date),
			});
			// AUTO_RESOLVED event written with the NOT_CONFIGURED reason.
			const event = state.events.find(
				(e) => e.eventType === "AUTO_RESOLVED",
			);
			expect(event).toBeDefined();
			expect((event?.payload as { reason: string }).reason).toBe(
				"NOT_CONFIGURED",
			);
		});

		it("is a no-op (no incident row) but still leaves the registry alone", async () => {
			state.registry.set("aws_s3", {
				providerKey: "aws_s3",
				currentHealth: "NOT_CONFIGURED",
				lastIncidentId: "aws-old-incident",
				lastPolledAt: null,
			});

			const result = await closeIntegrationIncident({
				providerKey: "aws_s3",
				reason: "NOT_CONFIGURED",
			});

			expect(result.resolved).toBe(false);
			expect(result.incidentId).toBeNull();
			// The write payload is captured, so this asserts the columns were
			// never written rather than merely that they still read the same:
			// the heartbeat is the only thing this branch may touch.
			expect(state.registryUpdates).toHaveLength(1);
			expect(state.registryUpdates[0]).toEqual({
				lastPolledAt: expect.any(Date),
			});
			expect(state.registry.get("aws_s3")?.currentHealth).toBe(
				"NOT_CONFIGURED",
			);
			expect(state.registry.get("aws_s3")?.lastIncidentId).toBe(
				"aws-old-incident",
			);
		});
	});
});
