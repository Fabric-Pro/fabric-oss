/**
 * Startup-wiring tests for `apps/web/instrumentation.ts`.
 *
 * These exist for one contract: the `CRON_SECRET` diagnostic is the *only*
 * remaining signal that the Vercel-scheduled cron jobs are silently dead, now
 * that `isCronRequestAuthorized` has no User-Agent fallback (issue #2883). So
 * it must be reported, and it must be reported before anything that can throw —
 * `validatePartykitConfig` does, and an unrelated PartyKit misconfiguration
 * must not be able to swallow the cron signal.
 *
 * The helper tests in `app/api/cron/lib/__tests__/cron-auth.test.ts` pin the
 * rule itself; deleting the call from `register()`, or moving it below the
 * PartyKit check, would leave those green. This file is what fails instead.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { validatePartykitConfigMock } = vi.hoisted(() => ({
	validatePartykitConfigMock: vi.fn(),
}));

vi.mock("@shared/lib/partykit-config", () => ({
	validatePartykitConfig: validatePartykitConfigMock,
}));
vi.mock("@repo/observability", () => ({ initObservability: vi.fn() }));
vi.mock("@repo/utils", () => ({
	describeEncryptionKeyMisconfiguration: vi.fn(() => null),
}));
vi.mock("@repo/storage", () => ({ ensureBuckets: vi.fn() }));
vi.mock("@repo/config", () => ({
	config: { storage: { bucketNames: {} } },
}));

import { register } from "../instrumentation";

function cronErrorCalls(spy: ReturnType<typeof vi.spyOn>): string[] {
	return spy.mock.calls
		.map((call) => String(call[0]))
		.filter((message) => message.includes("CRON_SECRET"));
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	validatePartykitConfigMock.mockReset();
	errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	vi.stubEnv("NEXT_RUNTIME", "nodejs");
	vi.stubEnv("VERCEL_ENV", "production");
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("register — CRON_SECRET startup diagnostic", () => {
	it("reports a production deployment with no usable secret", async () => {
		vi.stubEnv("CRON_SECRET", "");

		await register();

		expect(cronErrorCalls(errorSpy)).toHaveLength(1);
		expect(cronErrorCalls(errorSpy)[0]).toContain("[env]");
	});

	it("still reports it when a later startup check throws", async () => {
		// The ordering guarantee. PartyKit validation throwing must not cost us
		// the only signal that the cron schedule is dead.
		vi.stubEnv("CRON_SECRET", "");
		validatePartykitConfigMock.mockImplementation(() => {
			throw new Error("partykit misconfigured");
		});

		await expect(register()).rejects.toThrow("partykit misconfigured");

		expect(cronErrorCalls(errorSpy)).toHaveLength(1);
	});

	it("stays quiet when the secret is configured", async () => {
		vi.stubEnv("CRON_SECRET", "a-real-cron-secret");

		await register();

		expect(cronErrorCalls(errorSpy)).toEqual([]);
	});

	it("stays quiet outside the Node.js runtime", async () => {
		vi.stubEnv("NEXT_RUNTIME", "edge");
		vi.stubEnv("CRON_SECRET", "");

		await register();

		expect(cronErrorCalls(errorSpy)).toEqual([]);
		expect(validatePartykitConfigMock).not.toHaveBeenCalled();
	});
});
