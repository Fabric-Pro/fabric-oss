import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({ listContextCoveredCodePaths: vi.fn() }));
vi.mock("../../shared/fabric-internal-url", () => ({
	getFabricInternalBaseUrl: () => "http://fabric.example.com",
}));

import {
	changedCoverage,
	reindexCodeForContextPaths,
} from "../context-sync-code-index";

const scope = { projectId: "p1", repositoryIntegrationId: "ri-1" };

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("changedCoverage", () => {
	it("lists files taken in and files let go, sorted", () => {
		expect(
			changedCoverage(
				new Set(["docs/a.md", "docs/b.md"]),
				new Set(["docs/b.md", "docs/c.md"]),
			),
		).toEqual(["docs/a.md", "docs/c.md"]);
	});

	it("is empty when nothing moved", () => {
		expect(changedCoverage(new Set(["a.md"]), new Set(["a.md"]))).toEqual(
			[],
		);
	});
});

describe("reindexCodeForContextPaths", () => {
	it("asks the web app once, with the service token", async () => {
		vi.stubEnv("AGENT_SERVICE_SECRET", "service-secret-for-test");
		const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
		vi.stubGlobal("fetch", fetch);

		await reindexCodeForContextPaths(scope, ["docs/a.md"]);

		expect(fetch).toHaveBeenCalledTimes(1);
		const [url, init] = fetch.mock.calls[0];
		expect(url).toBe(
			"http://fabric.example.com/api/internal/code-index/context-paths",
		);
		expect(init.headers["X-Agent-Service-Token"]).toBe(
			"service-secret-for-test",
		);
		expect(JSON.parse(init.body)).toEqual({
			...scope,
			paths: ["docs/a.md"],
		});
	});

	it("sends nothing for no change", async () => {
		vi.stubEnv("AGENT_SERVICE_SECRET", "service-secret-for-test");
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		await reindexCodeForContextPaths(scope, []);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("never throws when the web app fails", async () => {
		vi.stubEnv("AGENT_SERVICE_SECRET", "service-secret-for-test");
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
		await expect(
			reindexCodeForContextPaths(scope, ["docs/a.md"]),
		).resolves.toBeUndefined();
	});
});
