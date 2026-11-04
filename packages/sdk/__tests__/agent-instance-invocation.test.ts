import { describe, expect, it, vi } from "vitest";
import { createFabric, FabricError } from "../src/index.js";

const receipt = {
	executionId: "example-execution",
	deploymentId: "example-deployment",
	workflowId: "example-workflow",
	runId: "example-run",
	status: "PENDING",
	admissionStatus: "CONFIRMED",
	idempotent: false,
};
function fixture(body: unknown = { data: receipt }, status = 202) {
	const fetch = vi.fn<typeof globalThis.fetch>(
		async () =>
			new Response(JSON.stringify(body), {
				status,
				headers: { "content-type": "application/json" },
			}),
	);
	return {
		fetch,
		client: createFabric({
			apiKey: "example-key",
			baseUrl: "https://example.com",
			fetch,
			retry: { maxRetries: 3, initialDelayMs: 1, maxDelayMs: 1 },
		}),
	};
}
describe("saved agent instance SDK invocation", () => {
	it("binds the same explicit request key in body/header with organization, priority and encoded instance ID", async () => {
		const { client, fetch } = fixture();
		expect(
			await client.agents.invokeInstance("example/instance", {
				org: "example-org",
				input: { message: "Create report" },
				priority: "HIGH",
				idempotencyKey: "example-request",
			}),
		).toEqual(receipt);
		const [url, init] = fetch.mock.calls[0];
		expect(String(url)).toBe(
			"https://example.com/api/v1/agent-instances/example%2Finstance/invoke?org=example-org",
		);
		expect(JSON.parse(String(init?.body))).toEqual({
			input: { message: "Create report" },
			priority: "HIGH",
			idempotencyKey: "example-request",
		});
		expect(new Headers(init?.headers).get("Idempotency-Key")).toBe(
			"example-request",
		);
	});
	it("preserves completed replay output and truthful replay/admission state", async () => {
		const replay = {
			...receipt,
			status: "COMPLETED",
			idempotent: true,
			output: { summary: "Completed report" },
		};
		const { client } = fixture({ data: replay }, 200);
		expect(
			await client.agents.invokeInstance("example-instance", {
				idempotencyKey: "example-request",
			}),
		).toEqual(replay);
	});

	it("requires a caller-retained key even from untyped JavaScript callers", async () => {
		const { client, fetch } = fixture();
		// @ts-expect-error Exercise the JavaScript runtime boundary as well as the required public option.
		await expect(
			client.agents.invokeInstance("example-instance", {}),
		).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED" });
		expect(fetch).not.toHaveBeenCalled();
	});

	it("does not retry a network failure automatically and lets the caller recover using the same key", async () => {
		const { client, fetch } = fixture();
		fetch.mockRejectedValueOnce(new TypeError("Connection closed"));
		const options = {
			org: "example-org",
			input: { message: "Create report" },
			idempotencyKey: "example-request",
		};
		await expect(
			client.agents.invokeInstance("example-instance", options),
		).rejects.toMatchObject({ code: "NETWORK_ERROR" });
		expect(fetch).toHaveBeenCalledTimes(1);
		await client.agents.invokeInstance("example-instance", options);
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(
			fetch.mock.calls.map(([, init]) =>
				new Headers(init?.headers).get("Idempotency-Key"),
			),
		).toEqual(["example-request", "example-request"]);
		expect(fetch.mock.calls[0][1]?.body).toBe(fetch.mock.calls[1][1]?.body);
	});
	it.each([
		[
			503,
			"ADMISSION_UNRESOLVED",
			{
				executionId: "example-execution",
				deploymentId: "example-deployment",
				workflowId: "example-workflow",
				retryable: true,
			},
		],
		[409, "IDEMPOTENCY_CONFLICT", { executionId: "example-execution" }],
	] as const)(
		"retains %s recovery metadata without a blind retry",
		async (status, code, data) => {
			const { client, fetch } = fixture(
				{
					error: {
						message: "Review the existing execution",
						code,
						data,
					},
				},
				status,
			);
			const result = await client.agents
				.invokeInstance("example-instance", {
					idempotencyKey: "example-request",
				})
				.catch((error) => error);
			expect(result).toBeInstanceOf(FabricError);
			expect(result).toMatchObject({ status, code, data });
			expect(fetch).toHaveBeenCalledTimes(1);
		},
	);
	it.each(["invoke", "execute"] as const)(
		"preserves the unsupported generic %s error and disables automatic mutation retries",
		async (method) => {
			const { client, fetch } = fixture(
				{
					error: {
						code: "AGENT_EXECUTION_UNSUPPORTED",
						message:
							"Use a saved agent instance or interactive workspace",
					},
				},
				409,
			);
			await expect(
				client.agents[method]("example-agent", {
					org: "example-org",
					input: { message: "Create report" },
					idempotencyKey: "example-request",
				}),
			).rejects.toMatchObject({ code: "AGENT_EXECUTION_UNSUPPORTED" });
			expect(fetch).toHaveBeenCalledTimes(1);
		},
	);
	it("does not retry generic execution on an ambiguous service failure", async () => {
		const { client, fetch } = fixture(
			{ error: { message: "Unavailable" } },
			503,
		);
		await expect(
			client.agents.invoke("example-agent"),
		).rejects.toMatchObject({ status: 503 });
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});

it("reads execution status and actual output from the owner-scoped polling route", async () => {
	const result = {
		...receipt,
		idempotent: undefined,
		status: "COMPLETED",
		output: { summary: "Cited result" },
		error: null,
	};
	const { client, fetch } = fixture({ data: result }, 200);
	expect(
		await client.agents.getInstanceExecution("example/execution", {
			org: "example-org",
		}),
	).toEqual(result);
	expect(String(fetch.mock.calls[0][0])).toBe(
		"https://example.com/api/v1/agent-executions/example%2Fexecution?org=example-org",
	);
	expect(fetch.mock.calls[0][1]?.method).toBe("GET");
});
