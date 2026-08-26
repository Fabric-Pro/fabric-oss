import { validatePartykitConfig } from "@shared/lib/partykit-config";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("validatePartykitConfig", () => {
	it("does nothing when collaboration is disabled, even with a bad host", () => {
		vi.stubEnv("NEXT_PUBLIC_ENABLE_COLLABORATION", "false");
		vi.stubEnv("NEXT_PUBLIC_PARTYKIT_HOST", "wss://bad-scheme");
		expect(() => validatePartykitConfig()).not.toThrow();
	});

	it("does nothing when the enable flag is unset", () => {
		vi.stubEnv("NEXT_PUBLIC_ENABLE_COLLABORATION", "");
		expect(() => validatePartykitConfig()).not.toThrow();
	});

	it("accepts a bare host", () => {
		vi.stubEnv("NEXT_PUBLIC_ENABLE_COLLABORATION", "true");
		vi.stubEnv(
			"NEXT_PUBLIC_PARTYKIT_HOST",
			"fabric-collab-prod.acme.workers.dev",
		);
		expect(() => validatePartykitConfig()).not.toThrow();
	});

	it("accepts a bare host with a port (in-cluster Service)", () => {
		vi.stubEnv("NEXT_PUBLIC_ENABLE_COLLABORATION", "true");
		vi.stubEnv(
			"NEXT_PUBLIC_PARTYKIT_HOST",
			"partykit.fabric.svc.cluster.local:1999",
		);
		expect(() => validatePartykitConfig()).not.toThrow();
	});

	it("throws on a scheme-prefixed host, in any environment", () => {
		vi.stubEnv("NEXT_PUBLIC_ENABLE_COLLABORATION", "true");
		vi.stubEnv("NODE_ENV", "development");
		vi.stubEnv("NEXT_PUBLIC_PARTYKIT_HOST", "wss://partykit.example.com");
		expect(() => validatePartykitConfig()).toThrow(/without a scheme/);
	});

	it("throws when the host is missing in production", () => {
		vi.stubEnv("NEXT_PUBLIC_ENABLE_COLLABORATION", "true");
		vi.stubEnv("NODE_ENV", "production");
		vi.stubEnv("NEXT_PUBLIC_PARTYKIT_HOST", "");
		expect(() => validatePartykitConfig()).toThrow(/is not set/);
	});

	it("warns (does not throw) when the host is missing in development", () => {
		vi.stubEnv("NEXT_PUBLIC_ENABLE_COLLABORATION", "true");
		vi.stubEnv("NODE_ENV", "development");
		vi.stubEnv("NEXT_PUBLIC_PARTYKIT_HOST", "");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(() => validatePartykitConfig()).not.toThrow();
		expect(warn).toHaveBeenCalledOnce();
	});
});
