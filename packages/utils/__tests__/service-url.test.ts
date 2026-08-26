import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	isDeployedEnvironment,
	requireServiceUrl,
	resolveServiceUrl,
} from "../lib/service-url";

/**
 * The never-localhost guard: env var set ⇒ its value (trailing slash
 * stripped) in every environment; unset + local dev ⇒ the localhost
 * fallback (previous behavior); unset + deployed (VERCEL_ENV, FABRIC_ENV,
 * or NODE_ENV=production) ⇒ a loud config error naming the variable instead
 * of a silent localhost request.
 *
 * Uses a synthetic TEST_SERVICE_URL variable so the matrix never collides
 * with real WEAVE_* values leaking in from the host environment.
 */

const ENV_VAR = "TEST_SERVICE_URL";
const FALLBACK = "http://localhost:8142";

/** Detection states for the deployed-environment matrix. */
const deployedStates: Array<{ label: string; stub: () => void }> = [
	{
		label: "VERCEL_ENV set",
		stub: () => vi.stubEnv("VERCEL_ENV", "preview"),
	},
	{
		label: "FABRIC_ENV set",
		stub: () => vi.stubEnv("FABRIC_ENV", "staging"),
	},
	{
		label: "NODE_ENV=production",
		stub: () => vi.stubEnv("NODE_ENV", "production"),
	},
];

beforeEach(() => {
	// Clean slate: no deployment markers, no service URL. Empty string is
	// falsy, matching the `process.env.X || fallback` semantics the guard
	// replaces.
	vi.unstubAllEnvs();
	vi.stubEnv("VERCEL_ENV", "");
	vi.stubEnv("FABRIC_ENV", "");
	vi.stubEnv("NODE_ENV", "test");
	vi.stubEnv(ENV_VAR, "");
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("isDeployedEnvironment()", () => {
	it("returns false when no deployment markers are set (local dev)", () => {
		expect(isDeployedEnvironment()).toBe(false);
	});

	it("returns false for a non-production NODE_ENV without other markers", () => {
		vi.stubEnv("NODE_ENV", "development");

		expect(isDeployedEnvironment()).toBe(false);
	});

	it.each(deployedStates)("returns true when $label", ({ stub }) => {
		stub();

		expect(isDeployedEnvironment()).toBe(true);
	});
});

describe("resolveServiceUrl()", () => {
	it("returns the env value locally when the var is set", () => {
		vi.stubEnv(ENV_VAR, "https://planners.internal.example.com");

		expect(resolveServiceUrl(ENV_VAR, FALLBACK)).toEqual({
			ok: true,
			url: "https://planners.internal.example.com",
		});
	});

	it.each(deployedStates)(
		"returns the env value when the var is set and $label",
		({ stub }) => {
			stub();
			vi.stubEnv(ENV_VAR, "https://planners.internal.example.com");

			expect(resolveServiceUrl(ENV_VAR, FALLBACK)).toEqual({
				ok: true,
				url: "https://planners.internal.example.com",
			});
		},
	);

	it("strips trailing slashes from the env value", () => {
		vi.stubEnv(ENV_VAR, "https://planners.internal.example.com/");

		expect(resolveServiceUrl(ENV_VAR, FALLBACK)).toEqual({
			ok: true,
			url: "https://planners.internal.example.com",
		});
	});

	it("returns the local fallback when the var is unset and not deployed", () => {
		expect(resolveServiceUrl(ENV_VAR, FALLBACK)).toEqual({
			ok: true,
			url: FALLBACK,
		});
	});

	it.each(deployedStates)(
		"returns ok:false naming the variable when the var is unset and $label",
		({ stub }) => {
			stub();

			const result = resolveServiceUrl(ENV_VAR, FALLBACK);

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toContain(ENV_VAR);
				expect(result.error).toBe(
					`The service is not configured for this environment — set ${ENV_VAR}.`,
				);
			}
		},
	);

	it("never falls back to localhost in a deployed environment", () => {
		vi.stubEnv("VERCEL_ENV", "production");

		const result = resolveServiceUrl(ENV_VAR, FALLBACK);

		expect(result.ok).toBe(false);
		if (result.ok) {
			expect(result.url).not.toContain("localhost");
		}
	});
});

describe("requireServiceUrl()", () => {
	it("returns the env value when the var is set", () => {
		vi.stubEnv(ENV_VAR, "https://planners.internal.example.com/");

		expect(requireServiceUrl(ENV_VAR, FALLBACK)).toBe(
			"https://planners.internal.example.com",
		);
	});

	it("returns the local fallback when the var is unset and not deployed", () => {
		expect(requireServiceUrl(ENV_VAR, FALLBACK)).toBe(FALLBACK);
	});

	it.each(deployedStates)(
		"throws an Error with the resolve message when the var is unset and $label",
		({ stub }) => {
			stub();

			expect(() => requireServiceUrl(ENV_VAR, FALLBACK)).toThrow(
				`The service is not configured for this environment — set ${ENV_VAR}.`,
			);
		},
	);
});
