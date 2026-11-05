import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
	computeDatabricksEvaluationPrincipalFingerprint,
	DatabricksEvaluationClient,
	evaluationAdmissionKey,
	evaluationSnapshotPath,
	validateEvaluationJobBinding,
} from "../src/evaluation-job";

const notebook = "print('example evaluator')\n";
const binding = {
	workspaceOrigin: "https://example.cloud.databricks.com",
	jobId: "123",
	experimentId: "456",
	volumePath: "/Volumes/example_catalog/example_schema/example_volume",
	notebookPath: "/Shared/example-evaluator",
	notebookSha256: createHash("sha256").update(notebook).digest("hex"),
};
const payload = JSON.stringify({ example: "private source text" });
const identity = {
	fabricRunId: "example-run",
	payloadHash: createHash("sha256").update(payload).digest("hex"),
	snapshotPath: evaluationSnapshotPath(binding, "example-run"),
	experimentId: binding.experimentId,
};
const signal = () => AbortSignal.timeout(5000);
const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status });
function client(responses: (Response | Error)[]) {
	const fetchImpl = vi.fn<typeof fetch>(async () => {
		const value = responses.shift();
		if (value instanceof Error) {
			throw value;
		}
		if (!value) {
			throw new Error("Unexpected request");
		}
		return value;
	});
	return {
		transport: new DatabricksEvaluationClient({
			binding,
			tokenProvider: {
				getToken: async () => "example-token",
				invalidate: () => {},
			},
			fetchImpl,
		}),
		fetchImpl,
	};
}
function job(
	taskOverrides: Record<string, unknown> = {},
	settingsOverrides: Record<string, unknown> = {},
) {
	return {
		settings: {
			tasks: [
				{
					task_key: "evaluate_context_snapshot",
					max_retries: 0,
					timeout_seconds: 900,
					notebook_task: { notebook_path: binding.notebookPath },
					...taskOverrides,
				},
			],
			timeout_seconds: 1200,
			max_concurrent_runs: 1,
			...settingsOverrides,
		},
	};
}
function run(overrides: Record<string, unknown> = {}) {
	return {
		run_id: 789,
		job_id: 123,
		state: { life_cycle_state: "TERMINATED", result_state: "SUCCESS" },
		tasks: [{ task_key: "evaluate_context_snapshot", run_id: 790 }],
		job_parameters: Object.entries({
			fabric_run_id: identity.fabricRunId,
			payload_hash: identity.payloadHash,
			snapshot_path: identity.snapshotPath,
			experiment_id: identity.experimentId,
		}).map(([name, value]) => ({ name, value })),
		...overrides,
	};
}
describe("bound Databricks evaluation transport", () => {
	it("uploads exact bytes through Files 2.0 with overwrite explicitly disabled", async () => {
		const { transport, fetchImpl } = client([
			new Response(null, { status: 204 }),
		]);
		await transport.uploadSnapshot(identity, payload, signal());
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init] = fetchImpl.mock.calls[0]!;
		expect(String(url)).toBe(
			`${binding.workspaceOrigin}/api/2.0/fs/files${identity.snapshotPath}?overwrite=false`,
		);
		expect(init?.method).toBe("PUT");
		expect(Buffer.from(init?.body as Uint8Array).toString()).toBe(payload);
		expect(init?.redirect).toBe("error");
	});
	it("reconciles a lost upload by exact SHA without overwriting", async () => {
		const { transport, fetchImpl } = client([
			new Error("lost"),
			new Response(payload),
		]);
		await expect(
			transport.uploadSnapshot(identity, payload, signal()),
		).resolves.toBeUndefined();
		expect(fetchImpl.mock.calls.map(([, init]) => init?.method)).toEqual([
			"PUT",
			"GET",
		]);
	});
	it("refuses an existing file with different bytes", async () => {
		const { transport } = client([
			json({ message: "private secret" }, 409),
			new Response("other"),
		]);
		await expect(
			transport.uploadSnapshot(identity, payload, signal()),
		).rejects.toMatchObject({ code: "SNAPSHOT_CONFLICT" });
	});
	it("qualifies the fixed task and pinned notebook source hash", async () => {
		const { transport } = client([
			json(job()),
			json({ content: Buffer.from(notebook).toString("base64") }),
		]);
		await expect(transport.qualifyJob(signal())).resolves.toBeUndefined();
	});
	it.each([
		{ max_retries: 1 },
		{ timeout_seconds: 901 },
		{ retry_on_timeout: true },
	])("rejects unsafe task execution settings %j", async (overrides) => {
		const { transport, fetchImpl } = client([json(job(overrides))]);
		await expect(transport.qualifyJob(signal())).rejects.toMatchObject({
			code: "JOB_NOT_QUALIFIED",
		});
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});
	it.each([
		{ schedule: { quartz_cron_expression: "0 0 * * * ?" } },
		{ max_concurrent_runs: 2 },
		{ continuous: {} },
	])("rejects unapproved execution shape %j", async (overrides) => {
		const { transport } = client([json(job({}, overrides))]);
		await expect(transport.qualifyJob(signal())).rejects.toMatchObject({
			code: "JOB_NOT_QUALIFIED",
		});
	});
	it("rejects notebook source changes", async () => {
		const { transport } = client([
			json(job()),
			json({ content: Buffer.from("changed").toString("base64") }),
		]);
		await expect(transport.qualifyJob(signal())).rejects.toMatchObject({
			code: "JOB_NOT_QUALIFIED",
		});
	});
	it("admits with a stable metadata-only native idempotency token", async () => {
		const { transport, fetchImpl } = client([
			json({ run_id: 789 }),
			json({ run_id: 789 }),
		]);
		await transport.admit(identity, signal());
		await transport.admit(identity, signal());
		const bodies = fetchImpl.mock.calls.map(([, init]) =>
			JSON.parse(String(init?.body)),
		);
		expect(bodies[0]).toEqual(bodies[1]);
		expect(bodies[0].idempotency_token).toBe(
			evaluationAdmissionKey(binding, identity),
		);
		expect(bodies[0].idempotency_token).toHaveLength(64);
		expect(Object.keys(bodies[0].job_parameters).sort()).toEqual([
			"experiment_id",
			"fabric_run_id",
			"payload_hash",
			"snapshot_path",
		]);
		expect(JSON.stringify(bodies)).not.toContain("private source text");
	});
	it("does not automatically repeat ambiguous job admission or leak provider bodies", async () => {
		const { transport, fetchImpl } = client([
			json({ message: "private provider token" }, 503),
		]);
		const error = await transport
			.admit(identity, signal())
			.catch((error) => error);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(error.message).not.toContain("private provider");
		expect(error.code).toBe("REMOTE_UNAVAILABLE");
	});
	it("performs only read-only lookup after ambiguous admission", async () => {
		const { transport, fetchImpl } = client([
			json({ runs: [run()] }),
			json(run()),
		]);
		await expect(
			transport.findAdmittedRun(identity, new Date(), signal()),
		).resolves.toBe("789");
		expect(
			fetchImpl.mock.calls.every(([, init]) => init?.method === "GET"),
		).toBe(true);
	});
	it("treats missing admission as unknown with bounded pagination", async () => {
		const { transport, fetchImpl } = client(
			Array.from({ length: 4 }, () =>
				json({ runs: [], next_page_token: "next" }),
			),
		);
		await expect(
			transport.findAdmittedRun(identity, new Date(), signal()),
		).resolves.toBeNull();
		expect(fetchImpl).toHaveBeenCalledTimes(4);
	});
	it("checks actual job parameters before trusting a native run", async () => {
		const { transport } = client([json(run({ job_id: 999 }))]);
		expect(
			(await transport.getRun("789", identity, signal())).parametersMatch,
		).toBe(false);
	});
	it("rejects truncated or excessive native receipts", async () => {
		const { transport } = client([
			json({ notebook_output: { result: "{}", truncated: true } }),
			json({ notebook_output: { result: "x".repeat(102401) } }),
		]);
		await expect(transport.output("790", signal())).rejects.toMatchObject({
			code: "REMOTE_PROTOCOL",
		});
		await expect(transport.output("790", signal())).rejects.toMatchObject({
			code: "REMOTE_PROTOCOL",
		});
	});
	it("bounds provider response bodies and sanitizes their content", async () => {
		const { transport } = client([new Response("secret".repeat(50000))]);
		await expect(transport.admit(identity, signal())).rejects.toMatchObject(
			{ code: "REMOTE_PROTOCOL" },
		);
	});
	it("deletes only the frozen run path, accepts already-erased files", async () => {
		const { transport, fetchImpl } = client([json({}, 404)]);
		await expect(
			transport.deleteSnapshot(identity, signal()),
		).resolves.toBeUndefined();
		expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe("DELETE");
		expect(String(fetchImpl.mock.calls[0]?.[0])).toContain(
			identity.snapshotPath,
		);
	});
	it("refuses traversal, foreign hosts, unsafe numeric IDs and cross-run file paths", async () => {
		for (const overrides of [
			{ volumePath: "/Volumes/a/b/../c" },
			{ workspaceOrigin: "https://example.com" },
			{ jobId: "9007199254740992" },
			{ notebookPath: "/Shared/../other" },
		]) {
			expect(() =>
				validateEvaluationJobBinding({ ...binding, ...overrides }),
			).toThrow();
		}
		const { transport, fetchImpl } = client([]);
		await expect(
			transport.uploadSnapshot(
				{
					...identity,
					snapshotPath: identity.snapshotPath.replace(
						"example-run",
						"other",
					),
				},
				payload,
				signal(),
			),
		).rejects.toMatchObject({ code: "INVALID_BINDING" });
		expect(fetchImpl).not.toHaveBeenCalled();
	});
	it("canonicalizes service-principal ID case for the tenant exclusion fingerprint", () => {
		expect(
			computeDatabricksEvaluationPrincipalFingerprint(
				binding.workspaceOrigin,
				" ABCD ",
			),
		).toBe(
			computeDatabricksEvaluationPrincipalFingerprint(
				binding.workspaceOrigin,
				"abcd",
			),
		);
	});
	it("accepts the documented no-retry default omitted by real Jobs responses", async () => {
		const { transport } = client([
			json(job({ max_retries: undefined })),
			json({ content: Buffer.from(notebook).toString("base64") }),
		]);
		await expect(transport.qualifyJob(signal())).resolves.toBeUndefined();
	});
	it("resumes bounded read-only lookup at page five instead of restarting forever", async () => {
		const pages = [1, 2, 3, 4].map((n) =>
			json({ runs: [], next_page_token: `example-page-${n}` }),
		);
		const { transport, fetchImpl } = client([
			...pages,
			json({ runs: [run()] }),
			json(run()),
		]);
		const checkpoint = vi.fn().mockResolvedValue(undefined);
		expect(
			await transport.findAdmittedRun(identity, new Date(0), signal(), {
				checkpoint,
			}),
		).toBeNull();
		expect(checkpoint).toHaveBeenLastCalledWith("example-page-4");
		expect(
			await transport.findAdmittedRun(identity, new Date(0), signal(), {
				pageToken: "example-page-4",
				checkpoint,
			}),
		).toBe("789");
		expect(String(fetchImpl.mock.calls[4]?.[0])).toContain(
			"page_token=example-page-4",
		);
		expect(checkpoint).toHaveBeenLastCalledWith(null);
	});

	it.each(["git-source", "git-notebook"])(
		"rejects %s rather than hashing unrelated Workspace code",
		async (variant) => {
			const tasks =
				variant === "git-notebook"
					? {
							notebook_task: {
								notebook_path: binding.notebookPath,
								source: "GIT",
							},
						}
					: {};
			const settings =
				variant === "git-source"
					? {
							git_source: {
								git_url: "https://example.com/evaluator.git",
								git_provider: "gitHub",
							},
						}
					: {};
			const { transport, fetchImpl } = client([
				json(job(tasks, settings)),
			]);
			await expect(transport.qualifyJob(signal())).rejects.toMatchObject({
				code: "JOB_NOT_QUALIFIED",
			});
			expect(fetchImpl).toHaveBeenCalledTimes(1);
		},
	);
});
