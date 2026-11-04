import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ContextQualityEvaluationInput,
	createFabric,
	FabricError,
} from "../src/index.js";

const input: ContextQualityEvaluationInput = {
	version: 1,
	sources: [{ sourceId: "source-1", expectedRevision: "a".repeat(64) }],
	cases: [
		{
			id: "case-1",
			recordedAnswer: "Example answer",
			retrievedSourceIds: ["source-1"],
			citedSourceIds: ["source-1"],
			expectations: {
				expectedSourceIds: ["source-1"],
				requiredPhrases: ["Example"],
				forbiddenPhrases: [],
			},
		},
	],
};

function fixture(status = 200, data: unknown = { status: "passed" }) {
	const fetch = vi.fn<typeof globalThis.fetch>();
	fetch.mockImplementation(
		async () =>
			new Response(
				JSON.stringify(
					status < 400
						? { data }
						: {
								error: {
									message: "Source revision changed",
									code: "CONFLICT",
								},
							},
				),
				{ status, headers: { "Content-Type": "application/json" } },
			),
	);
	return {
		fetch,
		client: createFabric({
			apiKey: "synthetic-key",
			baseUrl: "https://example.com",
			fetch,
			retry: { maxRetries: 3 },
		}),
	};
}

afterEach(() => vi.unstubAllEnvs());

describe("contextQuality source inspection", () => {
	it("encodes source/project identifiers and an explicit organization after the path", async () => {
		const source = {
			sourceId: "source/1",
			sourceKind: "project_context",
			projectId: "project 1",
			organizationId: "example-org",
			title: "Example source",
			content: "Example context",
			revision: "a".repeat(64),
			byteLength: 15,
			indexingExcluded: true,
			readMode: "direct",
		};
		const { client, fetch } = fixture(200, source);
		await expect(
			client.contextQuality.inspect("source/1", {
				projectId: "project 1",
				org: "example org",
			}),
		).resolves.toEqual(source);
		expect(fetch.mock.calls[0]?.[0]).toBe(
			"https://example.com/api/v1/projects/project%201/context-quality/sources/source%2F1?org=example%20org",
		);
		expect(fetch.mock.calls[0]?.[1]?.method).toBe("GET");
	});

	it("uses a bound project and allows a per-call project override", async () => {
		const { client, fetch } = fixture();
		const bound = client.withProject("project-default");
		await bound.contextQuality.inspect("source-1");
		await bound.contextQuality.inspect("source-1", {
			projectId: "project-override",
		});
		expect(fetch.mock.calls[0]?.[0]).toContain(
			"/projects/project-default/",
		);
		expect(fetch.mock.calls[1]?.[0]).toContain(
			"/projects/project-override/",
		);
		expect(() => client.contextQuality.inspect("source-1")).toThrow(
			"A project ID is required",
		);
	});

	it("rejects personal defaults without dispatching", () => {
		const { client, fetch } = fixture();
		expect(() =>
			client
				.withPersonal()
				.contextQuality.inspect("source-1", { projectId: "project-1" }),
		).toThrow("requires an organization project");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("rejects an already-aborted inspection without dispatching", async () => {
		const { client, fetch } = fixture();
		const signal = AbortSignal.abort(new Error("cancelled"));
		await expect(
			client.contextQuality.inspect("source-1", {
				projectId: "project-1",
				signal,
			}),
		).rejects.toBe(signal.reason);
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe("contextQuality saved runs", () => {
	const createInput = {
		bindingId: "example-binding",
		idempotencyKey: "ad760b08-b7dc-4c43-8328-67fd17ba33c9",
		name: "Example evaluation",
		evaluation: input,
	};

	it("binds the explicit key to the header and body across manual retries", async () => {
		const { client, fetch } = fixture(200, { run: { id: "example-run" } });
		fetch.mockRejectedValueOnce(new TypeError("lost response"));
		const runs = client.withProject("example-project").contextQuality.runs;
		await expect(runs.create(createInput)).rejects.toBeInstanceOf(
			FabricError,
		);
		expect(fetch).toHaveBeenCalledTimes(1);
		await expect(
			runs.create(createInput, { org: "example org" }),
		).resolves.toEqual({ run: { id: "example-run" } });
		for (const [, init] of fetch.mock.calls) {
			expect(init?.method).toBe("POST");
			expect(new Headers(init?.headers).get("Idempotency-Key")).toBe(
				createInput.idempotencyKey,
			);
			expect(JSON.parse(String(init?.body))).toEqual(createInput);
		}
		expect(fetch.mock.calls[1]?.[0]).toBe(
			"https://example.com/api/v1/projects/example-project/context-quality/runs?org=example%20org",
		);
	});

	it("does not replace a missing caller key with an automatically generated key", () => {
		const { client, fetch } = fixture();
		expect(() =>
			client.withProject("example-project").contextQuality.runs.create({
				...createInput,
				idempotencyKey: " ",
			}),
		).toThrow("stable idempotency key");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("never retries create or cancel on server failure", async () => {
		const { client, fetch } = fixture(503);
		const runs = client.withProject("example-project").contextQuality.runs;
		await expect(runs.create(createInput)).rejects.toMatchObject({
			status: 503,
		});
		await expect(runs.cancel("run/1")).rejects.toMatchObject({
			status: 503,
		});
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(fetch.mock.calls[1]?.[0]).toContain("/runs/run%2F1/cancel");
	});

	it("preserves cancellation intent instead of claiming confirmed cancellation", async () => {
		const run = {
			id: "example-run",
			status: "CANCEL_REQUESTED",
			report: null,
			evidenceAvailable: false,
			cleanupStatus: "PENDING",
		};
		const { client, fetch } = fixture(200, { run });
		await expect(
			client
				.withProject("example-project")
				.contextQuality.runs.cancel("run/1"),
		).resolves.toEqual({ run });
		expect(fetch.mock.calls[0]?.[1]?.method).toBe("POST");
		expect(fetch.mock.calls[0]?.[1]?.body).toBeUndefined();
	});

	it("encodes paginated, detail, comparison and capability requests with explicit scope", async () => {
		const { client, fetch } = fixture(200, { runs: [], nextCursor: null });
		const runs = client.withProject("default-project").contextQuality.runs;
		const options = { projectId: "project/1", org: "example org" };
		await runs.capabilities(options);
		await runs.list({ ...options, limit: 25, cursor: "run/older?next=1" });
		await runs.get("run/1", options);
		await runs.compare("baseline/1", "candidate?2", options);
		const urls = fetch.mock.calls.map(([url]) => new URL(String(url)));
		expect(urls.map((url) => url.pathname)).toEqual([
			"/api/v1/projects/project%2F1/context-quality/runs/capabilities",
			"/api/v1/projects/project%2F1/context-quality/runs",
			"/api/v1/projects/project%2F1/context-quality/runs/run%2F1",
			"/api/v1/projects/project%2F1/context-quality/runs/compare",
		]);
		for (const [index, url] of urls.entries()) {
			expect(url.searchParams.get("org")).toBe("example org");
			expect(fetch.mock.calls[index]?.[1]?.method).toBe("GET");
			expect(fetch.mock.calls[index]?.[1]?.body).toBeUndefined();
		}
		expect(urls[1]?.searchParams.get("cursor")).toBe("run/older?next=1");
		expect(urls[1]?.searchParams.get("limit")).toBe("25");
		expect(urls[3]?.searchParams.get("baselineId")).toBe("baseline/1");
		expect(urls[3]?.searchParams.get("candidateId")).toBe("candidate?2");
	});

	it("preserves withheld evidence and an incompatible nullable comparison", async () => {
		const comparison = {
			baseline: {
				id: "baseline",
				report: null,
				evidenceAvailable: false,
			},
			candidate: {
				id: "candidate",
				report: null,
				evidenceAvailable: false,
			},
			compatible: false,
			differences: { dataset: true, configuration: false, scorer: true },
			passedDelta: null,
		};
		const { client } = fixture(200, comparison);
		await expect(
			client
				.withProject("example-project")
				.contextQuality.runs.compare("baseline", "candidate"),
		).resolves.toEqual(comparison);
	});

	it("rejects missing projects and personal defaults for every saved operation", () => {
		const { client, fetch } = fixture();
		for (const target of [
			client,
			client.withPersonal().withProject("example-project"),
		]) {
			for (const call of [
				() => target.contextQuality.runs.capabilities(),
				() => target.contextQuality.runs.create(createInput),
				() => target.contextQuality.runs.list(),
				() => target.contextQuality.runs.get("example-run"),
				() => target.contextQuality.runs.cancel("example-run"),
				() =>
					target.contextQuality.runs.compare("baseline", "candidate"),
			]) {
				expect(call).toThrow(FabricError);
			}
		}
		expect(fetch).not.toHaveBeenCalled();
	});

	it("honors an aborted caller signal on saved requests before dispatch", async () => {
		const { client, fetch } = fixture();
		const runs = client.withProject("example-project").contextQuality.runs;
		const signal = AbortSignal.abort(new Error("caller cancelled"));
		for (const call of [
			() => runs.capabilities({ signal }),
			() => runs.create(createInput, { signal }),
			() => runs.list({ signal }),
			() => runs.get("example-run", { signal }),
			() => runs.cancel("example-run", { signal }),
			() => runs.compare("baseline", "candidate", { signal }),
		]) {
			await expect(call()).rejects.toBe(signal.reason);
		}
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe("contextQuality recorded-output evaluation", () => {
	it("sends revision references and recorded cases without request options in the body", async () => {
		const { client, fetch } = fixture();
		const controller = new AbortController();
		await expect(
			client.withProject("project-1").contextQuality.evaluate(input, {
				org: "example-org",
				signal: controller.signal,
			}),
		).resolves.toEqual({ status: "passed" });
		const [url, init] = fetch.mock.calls[0] ?? [];
		expect(url).toBe(
			"https://example.com/api/v1/projects/project-1/context-quality/evaluate?org=example-org",
		);
		expect(init?.method).toBe("POST");
		expect(JSON.parse(String(init?.body))).toEqual(input);
		expect(init?.signal).toBeInstanceOf(AbortSignal);
	});

	it("never retries evaluation on 503 despite the client's retry defaults", async () => {
		const { client, fetch } = fixture(503);
		await expect(
			client.contextQuality.evaluate(input, { projectId: "project-1" }),
		).rejects.toBeInstanceOf(FabricError);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("never retries evaluation after a lost response", async () => {
		const { client, fetch } = fixture();
		fetch.mockRejectedValueOnce(new TypeError("connection lost"));
		await expect(
			client.contextQuality.evaluate(input, { projectId: "project-1" }),
		).rejects.toBeInstanceOf(FabricError);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("preserves a stale revision conflict for the caller", async () => {
		const { client, fetch } = fixture(409);
		await expect(
			client.contextQuality.evaluate(input, { projectId: "project-1" }),
		).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("rejects personal and missing-project evaluations before dispatch", () => {
		const { client, fetch } = fixture();
		expect(() => client.contextQuality.evaluate(input)).toThrow(
			"A project ID is required",
		);
		expect(() =>
			client
				.withPersonal()
				.withProject("project-1")
				.contextQuality.evaluate(input),
		).toThrow("requires an organization project");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("honors cancellation before sending the recorded answers", async () => {
		const { client, fetch } = fixture();
		const signal = AbortSignal.abort(new Error("cancelled"));
		await expect(
			client.contextQuality.evaluate(input, {
				projectId: "project-1",
				signal,
			}),
		).rejects.toBe(signal.reason);
		expect(fetch).not.toHaveBeenCalled();
	});
});
