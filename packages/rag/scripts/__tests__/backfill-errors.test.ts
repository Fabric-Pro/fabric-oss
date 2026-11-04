import { afterEach, expect, it, vi } from "vitest";
import { runBackfillCli } from "../backfill-sparse-vectors";

const output = { log: vi.fn(), error: vi.fn() };
afterEach(() => {
	vi.unstubAllEnvs();
	vi.clearAllMocks();
});
function apiError(status: number, statusText: string, data: unknown) {
	return Object.assign(new Error(statusText), {
		status,
		statusText,
		data,
		headers: new Headers({ "api-key": "example-header-secret" }),
		url: "https://example-user:example-password@example.com/collections",
	});
}
it("prints a 401 status and API-key hint without the key, headers or URL credentials", async () => {
	const key = "example-api-key-secret";
	vi.stubEnv("QDRANT_API_KEY", key);
	const error = apiError(401, "Unauthorized", {
		status: {
			error: `Invalid key ${key} at https://example-user:example-password@example.com`,
		},
		headers: { "api-key": key },
		apiKey: key,
	});
	const client = { getCollections: vi.fn().mockRejectedValue(error) };
	expect(await runBackfillCli([], async () => client as never, output)).toBe(
		1,
	);
	const text = output.error.mock.calls.flat().join(" ");
	expect(text).toContain("401 Unauthorized");
	expect(text).toContain("QDRANT_API_KEY");
	for (const secret of [
		key,
		"example-header-secret",
		"example-user",
		"example-password",
	]) {
		expect(text).not.toContain(secret);
	}
});
it("gives a server-version hint for a 404 from schema creation", async () => {
	const client = {
		getCollection: vi.fn(async () => ({
			config: { params: { sparse_vectors: null } },
		})),
		createVectorName: vi.fn().mockRejectedValue(
			apiError(404, "Not Found", {
				status: { error: "Unknown endpoint" },
			}),
		),
	};
	expect(
		await runBackfillCli(
			["--collection", "project-contexts"],
			async () => client as never,
			output,
		),
	).toBe(1);
	expect(output.error.mock.calls[0]?.[0]).toContain("1.18");
});
it("explains a missing point during update as a concurrent re-index and recommends rerunning", async () => {
	const updateVectors = vi.fn().mockRejectedValue(
		apiError(404, "Not Found", {
			status: { error: "Not found: Point 1 does not exist" },
		}),
	);
	const client = {
		getCollection: vi.fn(async () => ({
			config: { params: { sparse_vectors: { sparse: {} } } },
		})),
		scroll: vi.fn(async () => ({
			points: [{ id: 1, payload: { content: "keyword" } }],
			next_page_offset: null,
		})),
		api: () => ({ updateVectors }),
	};
	expect(
		await runBackfillCli(
			["--collection", "project-contexts"],
			async () => client as never,
			output,
		),
	).toBe(1);
	const text = output.error.mock.calls[0]?.[0];
	expect(text).toContain("re-index");
	expect(text).toContain("rerun");
});
it("truncates response data and diagnoses forbidden access", async () => {
	const client = {
		getCollections: vi
			.fn()
			.mockRejectedValue(
				apiError(403, "Forbidden", { detail: "x".repeat(5000) }),
			),
	};
	await runBackfillCli([], async () => client as never, output);
	const text = output.error.mock.calls[0]?.[0] as string;
	expect(text).toContain("403 Forbidden");
	expect(text).toContain("QDRANT_API_KEY");
	expect(text).toContain("[truncated]");
	expect(text.length).toBeLessThan(1600);
});

it("stops when a successful HTTP response has no update result", async () => {
	const client = {
		getCollection: vi.fn(async () => ({
			config: { params: { sparse_vectors: { sparse: {} } } },
		})),
		scroll: vi.fn(async () => ({
			points: [{ id: 1, payload: { content: "keyword" } }],
			next_page_offset: null,
		})),
		api: () => ({ updateVectors: vi.fn(async () => ({ data: {} })) }),
	};
	expect(
		await runBackfillCli(
			["--collection", "project-contexts"],
			async () => client as never,
			output,
		),
	).toBe(1);
	expect(output.error.mock.calls[0]?.[0]).toContain(
		"no vector update result",
	);
});
