import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import type {
	HarnessAdapterOptions,
	HarnessAdmission,
	HarnessFiniteRelease,
	QualifiedHarnessTarget,
} from "./index";
import { createHarnessFiniteAdapter, fingerprintHarnessRelease } from "./index";

const who = {
	organizationId: "example-org",
	actorId: "example-user",
	projectId: "example-project",
};
const release: HarnessFiniteRelease = {
	kind: "harness_finite",
	artifact: {
		digest: `sha256:${"a".repeat(64)}`,
		repository: {
			url: "https://example.com/agents.git",
			revision: "b".repeat(40),
		},
		packages: {
			sdk: {
				name: "@fabric-harness/sdk",
				version: "6.8.0",
				entrypoint: "strict",
			},
			node: { name: "@fabric-harness/node", version: "6.6.0" },
		},
		buildManifestVersion: 2,
	},
	entrypoint: {
		module: "dist/report.mjs",
		export: "reportJob",
		identity: "example-report",
	},
	protocol: { interface: "finite_job", generation: "example-http-v1" },
	schemas: {
		input: {
			path: "schemas/input.json",
			digest: `sha256:${"c".repeat(64)}`,
		},
		output: {
			path: "schemas/output.json",
			digest: `sha256:${"d".repeat(64)}`,
		},
	},
};
let baseUrl = "";
let mode = "normal";
let postCount = 0;
const requests: Array<{
	method: string;
	url: string;
	headers: Record<string, unknown>;
	body: string;
}> = [];
const admissions = new Map<string, HarnessAdmission>();
let failPersistReceipt = false;
let target: QualifiedHarnessTarget;
let options: HarnessAdapterOptions;
const server = createServer(async (req, res) => {
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		chunks.push(Buffer.from(chunk));
	}
	requests.push({
		method: req.method ?? "",
		url: req.url ?? "",
		headers: req.headers,
		body: Buffer.concat(chunks).toString(),
	});
	res.setHeader("content-type", "application/json");
	if (req.method === "POST" && req.url?.startsWith("/jobs/")) {
		postCount++;
		if (mode === "drop") {
			req.socket.destroy();
			return;
		}
		if (mode === "auth") {
			res.statusCode = 401;
			res.end(
				JSON.stringify({ error: { message: "secret-token-example" } }),
			);
			return;
		}
		if (mode === "delay") {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		if (mode === "redirect") {
			res.statusCode = 302;
			res.setHeader("location", "https://example.com/unsafe");
			res.end();
			return;
		}
		res.statusCode = 202;
		res.end(
			JSON.stringify({
				runId: "example-run",
				status: "queued",
				statusUrl: "https://example.com/untrusted",
				eventsUrl: "https://example.com/untrusted",
			}),
		);
		return;
	}
	if (req.url?.includes("/events")) {
		res.end(
			JSON.stringify({
				events:
					mode === "oversized"
						? [{ text: "x".repeat(10000) }]
						: mode === "too-many-events"
							? [{}, {}, {}]
							: [
									{
										type: "progress",
										authorization:
											"Bearer secret-token-example",
										text: "secret-token-example",
									},
								],
				nextOffset: "1",
				upToDate: true,
			}),
		);
		return;
	}
	if (req.url?.endsWith("/abort")) {
		res.end(
			JSON.stringify({
				runId: "example-run",
				aborted: false,
				status: "running",
			}),
		);
		return;
	}
	res.end(
		JSON.stringify({
			runId: "example-run",
			job: mode === "wrong-job" ? "another-job" : "example-report",
			tenantId: mode === "wrong-tenant" ? "other-org" : "example-org",
			status: "completed",
			output: { summary: "Cited result", apiKey: "secret-token-example" },
			error:
				mode === "error"
					? { type: "provider", message: "secret-token-example" }
					: undefined,
		}),
	);
});
beforeAll(async () => {
	await new Promise<void>((resolve) =>
		server.listen(0, "127.0.0.1", resolve),
	);
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
	server.closeAllConnections();
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
});
beforeEach(() => {
	mode = "normal";
	postCount = 0;
	requests.length = 0;
	admissions.clear();
	failPersistReceipt = false;
	target = {
		bindingId: "example-target",
		baseUrl,
		organizationId: "example-org",
		actorIds: ["example-user"],
		projectIds: ["example-project"],
		qualification: {
			authority: "operator",
			attestationReference: "example-operator-attestation",
			releaseFingerprint: fingerprintHarnessRelease(release),
			expiresAt: Date.now() + 60000,
			clientVersion: "6.3.0",
			identityPolicy: "fabric-broker-organization-actor-project-v1",
			effectPolicy: "read_only",
			readOnlyRecovery: true,
			finiteJobs: true,
			status: true,
			events: true,
			cancel: true,
		},
	};
	options = {
		allowLoopbackHttpForTests: true,
		resolveQualifiedTarget: vi.fn(async () => target),
		authorizeOperation: vi.fn(async () => true),
		brokerCredentials: vi.fn(async () => ({
			authorization: "Bearer secret-token-example",
			identityAssertion: "example-signed-identity",
		})),
		validateInput: vi.fn(
			async ({ payload }) =>
				!!payload && typeof payload === "object" && "topic" in payload,
		),
		validateOutput: vi.fn(
			async ({ output }) =>
				!!output && typeof output === "object" && "summary" in output,
		),
		admissions: {
			claim: async (intent) => {
				const current = admissions.get(intent.operationId);
				if (current) {
					return {
						created: false,
						admission: structuredClone(current),
					};
				}
				const created: HarnessAdmission = {
					intent: structuredClone(intent),
					state: "starting",
				};
				admissions.set(intent.operationId, created);
				return { created: true, admission: structuredClone(created) };
			},
			read: async (key) => {
				const found = admissions.get(key.operationId);
				return found?.intent.organizationId === key.organizationId
					? structuredClone(found)
					: null;
			},
			recordAccepted: async (key, receipt) => {
				if (failPersistReceipt) {
					throw new Error("secret-token-example");
				}
				const found = admissions.get(key.operationId);
				if (!found) {
					throw new Error("missing claim");
				}
				found.state = "accepted";
				found.receipt = receipt;
			},
			markNotStarted: async (key) => {
				const found = admissions.get(key.operationId);
				if (found) {
					found.state = "not_started";
				}
			},
			markUncertain: async (key) => {
				const found = admissions.get(key.operationId);
				if (found) {
					found.state = "uncertain";
				}
			},
		},
	};
});
const start = () => ({
	identity: who,
	operationId: "example-operation",
	targetBindingId: "example-target",
	release: structuredClone(release),
	payload: { topic: "Delivery report" },
});
const run = () => ({ identity: who, operationId: "example-operation" });

describe("published Harness finite client boundary", () => {
	it("uses the actual public client to admit once, reattach, inspect bounded results/events and request cancellation", async () => {
		const adapter = createHarnessFiniteAdapter(options);
		expect(await adapter.start(start())).toEqual({
			runId: "example-run",
			status: "queued",
			attached: false,
		});
		expect(requests[0]).toMatchObject({
			method: "POST",
			url: "/jobs/example-report?wait=false",
			body: JSON.stringify({ topic: "Delivery report" }),
		});
		expect(requests[0].headers).toMatchObject({
			authorization: "Bearer secret-token-example",
			"x-fabric-identity-assertion": "example-signed-identity",
		});
		expect(requests[0].headers["idempotency-key"]).toMatch(
			/^fabric:[a-f0-9]{64}$/,
		);
		expect(await adapter.start(start())).toMatchObject({ attached: true });
		expect(postCount).toBe(1);
		expect(await adapter.status(run())).toEqual({
			runId: "example-run",
			job: "example-report",
			status: "completed",
			output: { summary: "Cited result", apiKey: "[redacted]" },
		});
		expect(
			await adapter.events({ ...run(), offset: "0", limit: 2 }),
		).toEqual({
			events: [
				{
					type: "progress",
					authorization: "[redacted]",
					text: "[redacted]",
				},
			],
			nextOffset: "1",
			upToDate: true,
		});
		expect(await adapter.cancel(run())).toEqual({
			runId: "example-run",
			requested: true,
			aborted: false,
			status: "running",
		});
		expect(
			requests.every((request) => !request.url.includes("untrusted")),
		).toBe(true);
	});
	it.each(["drop", "auth", "redirect"])(
		"fences repeated start after an ambiguous %s response, including public-client auth retries",
		async (failure) => {
			mode = failure;
			const adapter = createHarnessFiniteAdapter(options);
			await expect(adapter.start(start())).rejects.toMatchObject({
				code: "ADMISSION_UNCERTAIN",
				recovery: { operationId: "example-operation" },
			});
			await expect(adapter.start(start())).rejects.toMatchObject({
				code: "ADMISSION_UNCERTAIN",
			});
			expect(postCount).toBe(1);
		},
	);
	it("preserves recovery run identity if receipt persistence fails and never replays the job", async () => {
		failPersistReceipt = true;
		const adapter = createHarnessFiniteAdapter(options);
		await expect(adapter.start(start())).rejects.toMatchObject({
			code: "ADMISSION_UNCERTAIN",
			recovery: { runId: "example-run" },
		});
		await expect(adapter.start(start())).rejects.toMatchObject({
			code: "ADMISSION_UNCERTAIN",
		});
		expect(postCount).toBe(1);
	});
	it("rejects changed payload under the same operation identity", async () => {
		const adapter = createHarnessFiniteAdapter(options);
		await adapter.start(start());
		await expect(
			adapter.start({
				...start(),
				payload: { topic: "Different report" },
			}),
		).rejects.toMatchObject({ code: "ADMISSION_CONFLICT" });
		expect(postCount).toBe(1);
	});
	it("does not create duplicate POSTs during concurrent admission", async () => {
		const adapter = createHarnessFiniteAdapter(options);
		const results = await Promise.allSettled([
			adapter.start(start()),
			adapter.start(start()),
		]);
		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(postCount).toBe(1);
	});
	it.each(["artifact", "identity", "schema"])(
		"requires a separately qualified exact %s pin",
		async (change) => {
			const input = start();
			if (change === "artifact") {
				input.release.artifact.digest = `sha256:${"e".repeat(64)}`;
			}
			if (change === "identity") {
				input.release.entrypoint.identity = "other-agent-same-bundle";
			}
			if (change === "schema") {
				input.release.schemas.output.digest = `sha256:${"f".repeat(64)}`;
			}
			await expect(
				createHarnessFiniteAdapter(options).start(input),
			).rejects.toMatchObject({ code: "UNQUALIFIED_TARGET" });
			expect(postCount).toBe(0);
		},
	);
	it.each(["organization", "actor", "project"])(
		"rejects mismatched %s scope before transport",
		async (scope) => {
			const input = start();
			input.identity = {
				...who,
				...(scope === "organization"
					? { organizationId: "other-org" }
					: scope === "actor"
						? { actorId: "other-user" }
						: { projectId: "other-project" }),
			};
			await expect(
				createHarnessFiniteAdapter(options).start(input),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(requests).toHaveLength(0);
		},
	);
	it.each(["effectful", "recovery", "identity-policy", "expired"])(
		"keeps unsupported %s targets unavailable",
		async (capability) => {
			if (capability === "effectful") {
				target.qualification.effectPolicy = "effectful";
			}
			if (capability === "recovery") {
				target.qualification.readOnlyRecovery = false;
			}
			if (capability === "identity-policy") {
				Object.assign(target.qualification, {
					identityPolicy: "unsigned-headers",
				});
			}
			if (capability === "expired") {
				target.qualification.expiresAt = Date.now() - 1;
			}
			await expect(
				createHarnessFiniteAdapter(options).start(start()),
			).rejects.toMatchObject({ code: "UNQUALIFIED_TARGET" });
			expect(requests).toHaveLength(0);
		},
	);
	it("rechecks current permission on observe and cancel after revocation", async () => {
		const adapter = createHarnessFiniteAdapter(options);
		await adapter.start(start());
		options.authorizeOperation = vi.fn(async () => false);
		for (const method of [adapter.status, adapter.events, adapter.cancel]) {
			await expect(method(run())).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
		}
		expect(requests).toHaveLength(1);
	});
	it("prevents receipt use by another actor or project", async () => {
		const adapter = createHarnessFiniteAdapter(options);
		await adapter.start(start());
		await expect(
			adapter.status({
				...run(),
				identity: { ...who, actorId: "other-user" },
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			adapter.cancel({
				...run(),
				identity: { ...who, projectId: "other-project" },
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(requests).toHaveLength(1);
	});
	it.each(["wrong-job", "wrong-tenant"])(
		"rejects %s status responses instead of trusting a run ID alone",
		async (failure) => {
			const adapter = createHarnessFiniteAdapter(options);
			await adapter.start(start());
			mode = failure;
			await expect(adapter.status(run())).rejects.toMatchObject({
				code: "REMOTE_FAILURE",
			});
		},
	);
	it("validates the pinned input/output contract and payload bounds", async () => {
		const adapter = createHarnessFiniteAdapter(options);
		await expect(
			adapter.start({ ...start(), payload: { wrong: "field" } }),
		).rejects.toMatchObject({ code: "INVALID_INPUT" });
		await expect(
			adapter.start({
				...start(),
				payload: { topic: "x".repeat(260000) },
			}),
		).rejects.toMatchObject({ code: "INVALID_INPUT" });
		expect(requests).toHaveLength(0);
		await adapter.start(start());
		options.validateOutput = vi.fn(async () => false);
		await expect(adapter.status(run())).rejects.toMatchObject({
			code: "REMOTE_FAILURE",
		});
	});
	it("bounds response bodies and event counts and sanitizes error text", async () => {
		const adapter = createHarnessFiniteAdapter({
			...options,
			limits: { maxResponseBytes: 1000 },
		});
		await adapter.start(start());
		mode = "oversized";
		await expect(adapter.events(run())).rejects.toMatchObject({
			code: "REMOTE_FAILURE",
		});
		mode = "too-many-events";
		await expect(
			adapter.events({ ...run(), limit: 2 }),
		).rejects.toMatchObject({ code: "REMOTE_FAILURE" });
		mode = "error";
		expect((await adapter.status(run())).error?.message).not.toContain(
			"secret-token-example",
		);
	});
	it("supports cancellation before admission without a request", async () => {
		const signal = AbortSignal.abort();
		await expect(
			createHarnessFiniteAdapter(options).start({ ...start(), signal }),
		).rejects.toMatchObject({ code: "CANCELLED" });
		expect(requests).toHaveLength(0);
	});
	it("bounds a stalled start and exposes uncertainty rather than retrying", async () => {
		mode = "delay";
		const adapter = createHarnessFiniteAdapter({
			...options,
			limits: { timeoutMs: 30 },
		});
		await expect(adapter.start(start())).rejects.toMatchObject({
			code: "ADMISSION_UNCERTAIN",
		});
		await expect(adapter.start(start())).rejects.toMatchObject({
			code: "ADMISSION_UNCERTAIN",
		});
		expect(postCount).toBe(1);
	});
});

describe("trusted runtime configuration validation", () => {
	it.each([
		[
			"actorIds string",
			() =>
				Object.assign(target, {
					actorIds: "prefix-example-user-suffix",
				}),
		],
		[
			"projectIds string",
			() =>
				Object.assign(target, {
					projectIds: "prefix-example-project-suffix",
				}),
		],
		["non-string actor", () => Object.assign(target, { actorIds: [17] })],
		[
			"mixed project array",
			() =>
				Object.assign(target, {
					projectIds: ["example-project", false],
				}),
		],
		[
			"truthy capability",
			() => Object.assign(target.qualification, { finiteJobs: "true" }),
		],
		[
			"missing capability",
			() => Reflect.deleteProperty(target.qualification, "cancel"),
		],
		[
			"unexpected target field",
			() => Object.assign(target, { sharedSecret: "example-secret" }),
		],
		[
			"invalid proof reference",
			() =>
				Object.assign(target.qualification, {
					attestationReference: 42,
				}),
		],
	] as const)(
		"rejects malformed %s before authorization or admission",
		async (_, mutate) => {
			mutate();
			await expect(
				createHarnessFiniteAdapter(options).start(start()),
			).rejects.toMatchObject({ code: "UNQUALIFIED_TARGET" });
			expect(options.authorizeOperation).not.toHaveBeenCalled();
			expect(admissions.size).toBe(0);
			expect(requests).toHaveLength(0);
		},
	);
	it("does not create an unknown admission for invalid local broker credentials", async () => {
		options.brokerCredentials = vi.fn(async () => ({
			authorization: "invalid local credential",
			identityAssertion: "example-identity",
		}));
		await expect(
			createHarnessFiniteAdapter(options).start(start()),
		).rejects.toMatchObject({ code: "UNQUALIFIED_TARGET" });
		expect(admissions.size).toBe(0);
		expect(requests).toHaveLength(0);
		options.brokerCredentials = vi.fn(async () => ({
			authorization: "Bearer secret-token-example",
			identityAssertion: "example-signed-identity",
		}));
		expect(
			await createHarnessFiniteAdapter(options).start(start()),
		).toMatchObject({ attached: false });
		expect(postCount).toBe(1);
	});
	it("does not classify a broker setup exception as a remote unknown outcome", async () => {
		options.brokerCredentials = vi.fn(async () => {
			throw new Error("example-local-secret");
		});
		await expect(
			createHarnessFiniteAdapter(options).start(start()),
		).rejects.toMatchObject({ code: "UNQUALIFIED_TARGET" });
		expect(admissions.size).toBe(0);
		expect(requests).toHaveLength(0);
	});
	it("records a local abort after claim as not_started, retaining a known no-dispatch outcome", async () => {
		const controller = new AbortController();
		const original = options.admissions.claim;
		options.admissions.claim = async (intent) => {
			const result = await original(intent);
			controller.abort();
			return result;
		};
		const adapter = createHarnessFiniteAdapter(options);
		await expect(
			adapter.start({ ...start(), signal: controller.signal }),
		).rejects.toMatchObject({ code: "CANCELLED" });
		await vi.waitFor(() =>
			expect(admissions.get("example-operation")?.state).toBe(
				"not_started",
			),
		);
		expect(postCount).toBe(0);
		await expect(adapter.start(start())).rejects.toMatchObject({
			code: "NOT_STARTED",
		});
		await expect(adapter.status(run())).rejects.toMatchObject({
			code: "NOT_STARTED",
		});
	});
});

it("requires literal boolean approval from the schema validation callbacks", async () => {
	Object.assign(options, { validateInput: async () => "false" });
	const adapter = createHarnessFiniteAdapter(options);
	await expect(adapter.start(start())).rejects.toMatchObject({
		code: "INVALID_INPUT",
	});
	expect(requests).toHaveLength(0);
	Object.assign(options, { validateInput: async () => true });
	await adapter.start(start());
	Object.assign(options, { validateOutput: async () => ({ valid: false }) });
	await expect(adapter.status(run())).rejects.toMatchObject({
		code: "REMOTE_FAILURE",
	});
});
