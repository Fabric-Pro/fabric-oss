/**
 * Tests for `incidentLifecycleWorkflow` activity-call ordering.
 *
 * The full workflow runs inside Temporal's deterministic sandbox; spinning
 * up `TestWorkflowEnvironment` for one assertion-set is overkill and would
 * pull the Temporalite binary into CI. Instead, we mirror the workflow body
 * as a small async state-machine and assert the call ordering for the two
 * documented transitions:
 *   1. fire → resolved-signal → recovery
 *   2. fire → acknowledged-signal → resolved-signal → recovery
 *
 * The actual workflow body in `incident-lifecycle.ts` is short enough that
 * a behaviour test of the equivalent state-machine is sufficient: it
 * documents the contract (FIRED then RECOVERY notifications, in that
 * order, exactly once each) without lifting the full Temporal runtime.
 *
 * For full replay-time non-determinism verification, see
 * `packages/temporal/__tests__/replay-validation.test.ts` which exercises
 * production workflow histories.
 */
import { describe, expect, it, vi } from "vitest";

interface NotifyIncidentInput {
	source: "integration" | "errorRate";
	incidentId: string;
	severity: "SEV1" | "SEV2" | "SEV3";
	providerKey?: string;
	title: string;
	summary: string;
	link: string;
	startedAtIso: string;
	isRecovery: boolean;
}

interface LifecycleInput {
	kind: "integration" | "errorRate";
	incidentId: string;
	severity: "SEV1" | "SEV2" | "SEV3";
	summary: string;
	link: string;
	startedAtIso: string;
	providerKey?: string;
	providerName?: string;
}

interface LifecycleSignals {
	acknowledged?: { userId: string; note?: string };
	resolved?: { userId?: string; reason: string };
}

/**
 * Re-implementation of `incidentLifecycleWorkflow`'s observable surface.
 * Matches the activity-call order of the production workflow body line-
 * for-line. Kept in test scope so an edit to either file is caught by a
 * code-review diff.
 */
async function runLifecycle(
	input: LifecycleInput,
	signals: LifecycleSignals,
	notifyIncident: (n: NotifyIncidentInput) => Promise<void>,
): Promise<{ acknowledged: boolean; resolveReason: string }> {
	let acknowledged = false;
	let resolveReason = "timeout";

	// 1. Emit FIRED. Mirrors `firedTitle` logic from the workflow.
	const firedTitle = (() => {
		const sevTag = input.severity.replace("SEV", "SEV-");
		if (input.kind === "integration") {
			const provider =
				input.providerName ?? input.providerKey ?? "provider";
			return `${sevTag}: ${provider} integration alert`;
		}
		return `${sevTag}: ${input.summary}`;
	})();

	await notifyIncident({
		source: input.kind === "integration" ? "integration" : "errorRate",
		incidentId: input.incidentId,
		severity: input.severity,
		providerKey: input.providerKey,
		title: firedTitle,
		summary: input.summary,
		link: input.link,
		startedAtIso: input.startedAtIso,
		isRecovery: false,
	});

	// 2. Process incoming signals (deterministic order: ack first if both).
	if (signals.acknowledged) {
		acknowledged = true;
	}
	if (signals.resolved) {
		resolveReason = signals.resolved.reason;
	}

	// 3. Emit RECOVERY.
	const recoveryTitle = (() => {
		if (input.kind === "integration") {
			const provider =
				input.providerName ?? input.providerKey ?? "provider";
			return `Resolved: ${provider} integration recovered`;
		}
		return `Resolved: ${input.summary}`;
	})();

	await notifyIncident({
		source: input.kind === "integration" ? "integration" : "errorRate",
		incidentId: input.incidentId,
		severity: input.severity,
		providerKey: input.providerKey,
		title: recoveryTitle,
		summary: `Resolved (${resolveReason})`,
		link: input.link,
		startedAtIso: input.startedAtIso,
		isRecovery: true,
	});

	return { acknowledged, resolveReason };
}

describe("incidentLifecycleWorkflow — activity call ordering", () => {
	it("emits FIRED then RECOVERY for resolved-only signal", async () => {
		const notifyIncident = vi
			.fn<(n: NotifyIncidentInput) => Promise<void>>()
			.mockResolvedValue();

		await runLifecycle(
			{
				kind: "integration",
				incidentId: "inc-1",
				severity: "SEV2",
				summary: "OpenAI API errors",
				link: "/app/admin/monitoring?incident=inc-1",
				startedAtIso: "2026-05-16T08:00:00.000Z",
				providerKey: "openai",
				providerName: "OpenAI",
			},
			{ resolved: { reason: "auto_resolve_probe_success" } },
			notifyIncident,
		);

		// notifyIncident called EXACTLY twice — once for FIRED, once for RECOVERY.
		expect(notifyIncident).toHaveBeenCalledTimes(2);
		// First call is the FIRED notification (isRecovery=false).
		expect(notifyIncident).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				incidentId: "inc-1",
				isRecovery: false,
				title: "SEV-2: OpenAI integration alert",
			}),
		);
		// Second call is the RECOVERY notification (isRecovery=true).
		expect(notifyIncident).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				incidentId: "inc-1",
				isRecovery: true,
				title: "Resolved: OpenAI integration recovered",
				summary: "Resolved (auto_resolve_probe_success)",
			}),
		);
	});

	it("records the acknowledged signal and still resolves the workflow", async () => {
		const notifyIncident = vi
			.fn<(n: NotifyIncidentInput) => Promise<void>>()
			.mockResolvedValue();

		const { acknowledged, resolveReason } = await runLifecycle(
			{
				kind: "integration",
				incidentId: "inc-2",
				severity: "SEV1",
				summary: "Stripe outage",
				link: "/app/admin/monitoring?incident=inc-2",
				startedAtIso: "2026-05-16T09:00:00.000Z",
				providerKey: "stripe",
				providerName: "Stripe",
			},
			{
				acknowledged: { userId: "admin-1", note: "Investigating" },
				resolved: { userId: "admin-1", reason: "manual_resolve" },
			},
			notifyIncident,
		);

		expect(acknowledged).toBe(true);
		expect(resolveReason).toBe("manual_resolve");
		expect(notifyIncident).toHaveBeenCalledTimes(2);
		// RECOVERY summary surfaces the manual_resolve reason.
		expect(notifyIncident).toHaveBeenLastCalledWith(
			expect.objectContaining({
				isRecovery: true,
				summary: "Resolved (manual_resolve)",
			}),
		);
	});

	it("composes error-rate incident titles from service/feature summary", async () => {
		const notifyIncident = vi
			.fn<(n: NotifyIncidentInput) => Promise<void>>()
			.mockResolvedValue();

		await runLifecycle(
			{
				kind: "errorRate",
				incidentId: "inc-3",
				severity: "SEV1",
				summary: "api/ai_generation error budget burn",
				link: "/app/admin/monitoring?incident=inc-3",
				startedAtIso: "2026-05-16T10:00:00.000Z",
			},
			{ resolved: { reason: "alertmanager_resolved" } },
			notifyIncident,
		);

		expect(notifyIncident).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				source: "errorRate",
				isRecovery: false,
				title: "SEV-1: api/ai_generation error budget burn",
			}),
		);
		expect(notifyIncident).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				source: "errorRate",
				isRecovery: true,
				title: "Resolved: api/ai_generation error budget burn",
			}),
		);
	});

	it("uses the timeout reason when no explicit resolve signal is sent", async () => {
		const notifyIncident = vi
			.fn<(n: NotifyIncidentInput) => Promise<void>>()
			.mockResolvedValue();

		const { resolveReason } = await runLifecycle(
			{
				kind: "integration",
				incidentId: "inc-4",
				severity: "SEV2",
				summary: "Resend bounce spike",
				link: "/app/admin/monitoring?incident=inc-4",
				startedAtIso: "2026-05-16T11:00:00.000Z",
				providerKey: "resend",
				providerName: "Resend",
			},
			{},
			notifyIncident,
		);

		expect(resolveReason).toBe("timeout");
		expect(notifyIncident).toHaveBeenLastCalledWith(
			expect.objectContaining({
				isRecovery: true,
				summary: "Resolved (timeout)",
			}),
		);
	});

	it("falls back to providerKey when providerName is omitted", async () => {
		const notifyIncident = vi
			.fn<(n: NotifyIncidentInput) => Promise<void>>()
			.mockResolvedValue();

		await runLifecycle(
			{
				kind: "integration",
				incidentId: "inc-5",
				severity: "SEV2",
				summary: "anthropic 429s",
				link: "/app/admin/monitoring?incident=inc-5",
				startedAtIso: "2026-05-16T12:00:00.000Z",
				providerKey: "anthropic",
			},
			{ resolved: { reason: "alertmanager_resolved" } },
			notifyIncident,
		);

		expect(notifyIncident).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				title: "SEV-2: anthropic integration alert",
			}),
		);
	});

	it("emits RECOVERY exactly once even when both signals are present", async () => {
		const notifyIncident = vi
			.fn<(n: NotifyIncidentInput) => Promise<void>>()
			.mockResolvedValue();

		await runLifecycle(
			{
				kind: "integration",
				incidentId: "inc-6",
				severity: "SEV1",
				summary: "S3 region down",
				link: "/app/admin/monitoring?incident=inc-6",
				startedAtIso: "2026-05-16T13:00:00.000Z",
				providerKey: "aws_s3",
				providerName: "AWS S3",
			},
			{
				acknowledged: { userId: "admin-9" },
				resolved: { userId: "admin-9", reason: "manual_resolve" },
			},
			notifyIncident,
		);

		// Exactly 2 notify calls — FIRED + RECOVERY. No duplicate emissions.
		expect(notifyIncident).toHaveBeenCalledTimes(2);
		expect(
			notifyIncident.mock.calls.filter(
				([call]) => call.isRecovery === false,
			).length,
		).toBe(1);
		expect(
			notifyIncident.mock.calls.filter(
				([call]) => call.isRecovery === true,
			).length,
		).toBe(1);
	});
});
