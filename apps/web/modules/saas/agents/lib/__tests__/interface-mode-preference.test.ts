import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
	orchestratorPreferencesQueryKey,
	resolveInitialUiMode,
	setCachedUiMode,
} from "../interface-mode-preference";

describe("resolveInitialUiMode", () => {
	it("uses the SSR interface preference on the initial render", () => {
		expect(
			resolveInitialUiMode({ exists: true, uiMode: "advanced" }, null),
		).toBe("advanced");
		expect(
			resolveInitialUiMode({ exists: true, uiMode: "simple" }, null),
		).toBe("simple");
	});
	it("keeps the existing research visit override without changing other deep links", () => {
		const preferences = { exists: true, uiMode: "simple" } as const;
		expect(resolveInitialUiMode(preferences, "research")).toBe("advanced");
		expect(resolveInitialUiMode(preferences, "agent")).toBe("simple");
		expect(preferences.uiMode).toBe("simple");
	});
	it("keeps the existing default when no saved preference was resolved", () => {
		expect(resolveInitialUiMode(null, "research")).toBe("simple");
		expect(
			resolveInitialUiMode(
				{ exists: false, uiMode: "simple" },
				"research",
			),
		).toBe("simple");
	});
});

describe("setCachedUiMode", () => {
	it("updates the uiMode the page and the drawer both read", () => {
		const queryClient = new QueryClient();
		const key = orchestratorPreferencesQueryKey("org_1");
		queryClient.setQueryData(key, {
			exists: false,
			uiMode: "simple",
			chatMode: "orchestrator",
		});

		setCachedUiMode(queryClient, "org_1", "advanced");

		expect(queryClient.getQueryData(key)).toEqual({
			exists: true,
			uiMode: "advanced",
			chatMode: "orchestrator",
		});
	});

	it("leaves an unresolved preference alone rather than inventing one", () => {
		const queryClient = new QueryClient();

		setCachedUiMode(queryClient, null, "advanced");

		expect(
			queryClient.getQueryData(orchestratorPreferencesQueryKey(null)),
		).toBeUndefined();
	});

	it("keys per organization", () => {
		expect(orchestratorPreferencesQueryKey(undefined)).toEqual([
			"orchestrator-preferences",
			null,
		]);
		expect(orchestratorPreferencesQueryKey("org_2")).toEqual([
			"orchestrator-preferences",
			"org_2",
		]);
	});
});
