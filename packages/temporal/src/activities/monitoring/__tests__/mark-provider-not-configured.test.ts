/**
 * Tests for the `markProviderNotConfigured` activity.
 *
 * Regression coverage: this activity was added in #1019 to flip the
 * registry row to `NOT_CONFIGURED` when the synthetic probe is blocked by
 * missing env vars (e.g. `STRIPE_SECRET_KEY` unset on staging). It is
 * called from the `syntheticProbeWorkflow` NOT_CONFIGURED short-circuit
 * path; if the activity is not registered on the worker side (re-export
 * gap in `packages/temporal/src/activities/index.ts`), the proxied call
 * fails at runtime and the registry row stays stuck at its old value —
 * which is exactly what we observed on staging where AWS S3 and Stripe
 * remained at `MAJOR_OUTAGE` with a 5-hour-old `lastPolledAt`.
 *
 * Beyond the activity's own DB interactions, this file also asserts that
 * the top-level activities barrel re-exports the function so the worker's
 * `bundleActivities`/`workerOptions.activities` registers it correctly.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const update = vi.fn();

vi.mock("@repo/database", () => ({
	setAiUsageRecorder: vi.fn(),
	db: {
		integrationProviderRegistry: {
			findUnique: (args: unknown) => findUnique(args),
			update: (args: unknown) => update(args),
		},
	},
}));

import { markProviderNotConfigured } from "../mark-provider-not-configured";

beforeEach(() => {
	findUnique.mockReset();
	update.mockReset();
	update.mockReturnValue({
		catch: () => Promise.resolve(),
	});
});

describe("markProviderNotConfigured — activity behavior", () => {
	it("flips the registry row to NOT_CONFIGURED and reports updated:true on first call", async () => {
		findUnique.mockResolvedValueOnce({ currentHealth: "MAJOR_OUTAGE" });

		const result = await markProviderNotConfigured({
			providerKey: "aws_s3",
			reason: "AWS_S3_BUCKET not set in this environment",
		});

		expect(result.updated).toBe(true);
		expect(update).toHaveBeenCalledTimes(1);
		const args = update.mock.calls[0][0] as {
			where: { providerKey: string };
			data: { currentHealth: string; lastPolledAt: Date };
		};
		expect(args.where.providerKey).toBe("aws_s3");
		expect(args.data.currentHealth).toBe("NOT_CONFIGURED");
		expect(args.data.lastPolledAt).toBeInstanceOf(Date);
	});

	it("reports updated:false when the row is already NOT_CONFIGURED (idempotent)", async () => {
		findUnique.mockResolvedValueOnce({ currentHealth: "NOT_CONFIGURED" });

		const result = await markProviderNotConfigured({
			providerKey: "stripe",
			reason: "STRIPE_SECRET_KEY not set",
		});

		// The activity still issues the update (to refresh lastPolledAt)
		// but reports updated:false so the workflow doesn't spam logs.
		expect(result.updated).toBe(false);
		expect(update).toHaveBeenCalledTimes(1);
	});

	it("returns updated:false when no registry row exists yet (boot ordering tolerance)", async () => {
		findUnique.mockResolvedValueOnce(null);

		const result = await markProviderNotConfigured({
			providerKey: "unknown-provider",
		});

		expect(result.updated).toBe(false);
		// No update issued — there is no row to update.
		expect(update).not.toHaveBeenCalled();
	});

	it("refreshes lastPolledAt every call so the admin UI does not show stale 'last poll' time", async () => {
		// The original staging bug was the opposite: AWS S3 read "Last poll
		// 5 hours ago" because the activity was never reachable. This
		// assertion locks in that every successful flip refreshes the
		// timestamp.
		findUnique.mockResolvedValueOnce({ currentHealth: "NOT_CONFIGURED" });
		const before = Date.now();
		await markProviderNotConfigured({ providerKey: "stripe" });
		const args = update.mock.calls[0][0] as {
			data: { lastPolledAt: Date };
		};
		expect(args.data.lastPolledAt.getTime()).toBeGreaterThanOrEqual(before);
	});
});

describe("markProviderNotConfigured — top-level worker registration", () => {
	// This is the bug fix the test exists to guard against: the activity
	// was implemented in `mark-provider-not-configured.ts` and re-exported
	// from `packages/temporal/src/activities/monitoring/index.ts`, but the
	// top-level barrel at `packages/temporal/src/activities/index.ts` did
	// NOT include it. As a result, the Temporal worker (which iterates
	// `Object.values(activitiesNamespace)` to register the activity map)
	// never saw `markProviderNotConfigured`, so proxied calls from
	// `syntheticProbeWorkflow` failed at runtime with
	// `ActivityNotRegisteredError`. The workflow caught the error in a
	// best-effort try/catch and continued — leaving the registry row stuck
	// at whatever its previous value was (the observed MAJOR_OUTAGE for
	// AWS S3 / 5-hour-stale lastPolledAt).
	//
	// We assert against the SOURCE TEXT rather than importing the barrel —
	// importing the top-level activities module pulls in payments / db
	// initialization that needs heavy ESM mocking. Source-text check is
	// sufficient: the symbol either appears in the export list or it
	// doesn't.
	it("re-exports `markProviderNotConfigured` from the top-level activities barrel", async () => {
		const { readFileSync } = await import("node:fs");
		const { fileURLToPath } = await import("node:url");
		const { dirname, join } = await import("node:path");
		const here = dirname(fileURLToPath(import.meta.url));
		const barrelPath = join(here, "../../index.ts");
		const source = readFileSync(barrelPath, "utf8");
		expect(source).toMatch(/markProviderNotConfigured\b/);
	});

	it("re-exports the matching input/output type aliases too", async () => {
		const { readFileSync } = await import("node:fs");
		const { fileURLToPath } = await import("node:url");
		const { dirname, join } = await import("node:path");
		const here = dirname(fileURLToPath(import.meta.url));
		const barrelPath = join(here, "../../index.ts");
		const source = readFileSync(barrelPath, "utf8");
		expect(source).toMatch(/MarkProviderNotConfiguredInput\b/);
		expect(source).toMatch(/MarkProviderNotConfiguredOutput\b/);
	});
});
