/**
 * Tests for the log-source provider registry (Fizzy #1234).
 *
 * The point of the registry is that Fabric is not bound to any log platform.
 * These tests use synthetic providers rather than the real Azure one, which is
 * itself the assertion: the selection logic knows nothing about any vendor.
 */
import type { LogSourceAdapter } from "@repo/ai/lib/log-context";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	knownProviderIds,
	type LogSourceProvider,
	PROVIDERS,
	resolveConfiguredLogSource,
	resolveProjectLogSource,
} from "../log-source-registry";

function fakeAdapter(kind: string): LogSourceAdapter {
	return {
		kind,
		label: `${kind} label`,
		sharedStore: false,
		fetchLogExcerpts: async () => [],
	};
}

function provider(id: string, configured: boolean): LogSourceProvider {
	return {
		id,
		label: `${id} label`,
		fromEnvironment: () => (configured ? fakeAdapter(id) : null),
		// Project settings are usable when they carry this provider's own key.
		fromProjectConfig: (config) =>
			config.usable ? fakeAdapter(`${id}-project`) : null,
	};
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("resolveConfiguredLogSource", () => {
	it("returns nothing when no provider is configured", () => {
		expect(
			resolveConfiguredLogSource([
				provider("a", false),
				provider("b", false),
			]),
		).toBeNull();
	});

	it("auto-detects the first configured provider", () => {
		const adapter = resolveConfiguredLogSource([
			provider("a", false),
			provider("b", true),
			provider("c", true),
		]);
		expect(adapter?.kind).toBe("b");
	});

	it("honours an explicitly named provider over auto-detection order", () => {
		vi.stubEnv("FABRIC_BUG_ANALYSIS_LOG_PROVIDER", "c");
		const adapter = resolveConfiguredLogSource([
			provider("a", true),
			provider("b", true),
			provider("c", true),
		]);
		expect(adapter?.kind).toBe("c");
	});

	it("returns nothing when the named provider is unknown, without falling back", () => {
		vi.stubEnv("FABRIC_BUG_ANALYSIS_LOG_PROVIDER", "does-not-exist");
		// Falling back would silently query a platform the operator did not
		// name, which is the opposite of what naming one means.
		expect(resolveConfiguredLogSource([provider("a", true)])).toBeNull();
	});

	it("returns nothing when the named provider exists but is unconfigured", () => {
		vi.stubEnv("FABRIC_BUG_ANALYSIS_LOG_PROVIDER", "a");
		expect(
			resolveConfiguredLogSource([
				provider("a", false),
				provider("b", true),
			]),
		).toBeNull();
	});

	it("ignores surrounding whitespace in the provider name", () => {
		vi.stubEnv("FABRIC_BUG_ANALYSIS_LOG_PROVIDER", "  b  ");
		expect(
			resolveConfiguredLogSource([
				provider("a", true),
				provider("b", true),
			])?.kind,
		).toBe("b");
	});
});

describe("the shipped registry", () => {
	it("exposes provider ids without requiring any of them to be configured", () => {
		expect(knownProviderIds().length).toBeGreaterThan(0);
		expect(knownProviderIds()).toContain("azure-monitor");
	});

	it("every provider declares an id and a label and resolves without I/O", () => {
		for (const p of PROVIDERS) {
			expect(p.id).toBeTruthy();
			expect(p.label).toBeTruthy();
			// Unconfigured by default, and must not throw or hit the network.
			expect(() => p.fromEnvironment()).not.toThrow();
		}
	});

	it("is not configured by default, so the feature stays inert", () => {
		expect(resolveConfiguredLogSource()).toBeNull();
	});
});

describe("resolveProjectLogSource", () => {
	it("builds from the project's own settings", () => {
		const adapter = resolveProjectLogSource("a", { usable: true }, [
			provider("a", false),
		]);
		// The project binding works even when the provider has no deployment
		// configuration of its own — that is the whole point of per-project.
		expect(adapter?.kind).toBe("a-project");
	});

	it("returns nothing for a provider the registry does not know", () => {
		expect(
			resolveProjectLogSource("nope", { usable: true }, [
				provider("a", true),
			]),
		).toBeNull();
	});

	it("returns nothing when the project's settings are incomplete", () => {
		expect(
			resolveProjectLogSource("a", {}, [provider("a", true)]),
		).toBeNull();
	});

	it("never falls back to another provider", () => {
		// Reading a log source nobody named is worse than reading none.
		const adapter = resolveProjectLogSource("a", {}, [
			provider("a", true),
			provider("b", true),
		]);
		expect(adapter).toBeNull();
	});
});
