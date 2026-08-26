import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Force the watcher on with a known current version, regardless of NODE_ENV.
vi.mock("@shared/lib/app-version", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@shared/lib/app-version")>();
	return {
		...actual,
		getAppVersion: () => "v1",
		isVersionCheckEnabled: () => true,
		VERSION_POLL_INTERVAL_MS: 10_000,
	};
});

import { useBuildVersion } from "../use-build-version";

function fetchReturning(body: unknown, ok = true) {
	return vi.fn().mockResolvedValue({ ok, json: async () => body });
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

describe("useBuildVersion", () => {
	it("flags stale when the latest version differs from the loaded one", async () => {
		vi.stubGlobal("fetch", fetchReturning({ version: "v2" }));
		const { result } = renderHook(() => useBuildVersion());
		await waitFor(() => expect(result.current.isStale).toBe(true));
	});

	it("stays fresh when the versions match", async () => {
		vi.stubGlobal("fetch", fetchReturning({ version: "v1" }));
		const { result } = renderHook(() => useBuildVersion());
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(result.current.isStale).toBe(false);
	});

	it("ignores a dev/unknown server version", async () => {
		vi.stubGlobal("fetch", fetchReturning({ version: "dev" }));
		const { result } = renderHook(() => useBuildVersion());
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(result.current.isStale).toBe(false);
	});

	it("swallows network errors without flagging stale", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValue(new Error("network down")),
		);
		const { result } = renderHook(() => useBuildVersion());
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(result.current.isStale).toBe(false);
	});
});
