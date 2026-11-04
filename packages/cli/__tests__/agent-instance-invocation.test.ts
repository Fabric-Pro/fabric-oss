import { Command, CommanderError } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildAgentsCommand } from "../src/commands/agents/index.js";

const m = vi.hoisted(() => ({
	invoke: vi.fn(),
	get: vi.fn(),
	context: {
		value: { type: "org", slug: "example-org" } as
			| { type: string; slug?: string }
			| undefined,
	},
}));
vi.mock("../src/lib/client.js", () => ({
	getClient: () => ({
		agents: { invokeInstance: m.invoke, getInstanceExecution: m.get },
	}),
}));
vi.mock("../src/lib/config.js", () => ({
	getDefaultContext: () => m.context.value,
	getOutputFormat: () => "table",
}));
class ExitSignal extends Error {
	constructor(readonly code: number) {
		super("exit");
	}
}
async function run(args: string[]) {
	let stdout = "";
	let stderr = "";
	let code = 0;
	const out = vi
		.spyOn(process.stdout, "write")
		.mockImplementation((chunk) => {
			stdout += String(chunk);
			return true;
		});
	const err = vi
		.spyOn(process.stderr, "write")
		.mockImplementation((chunk) => {
			stderr += String(chunk);
			return true;
		});
	const exit = vi.spyOn(process, "exit").mockImplementation((value) => {
		throw new ExitSignal(Number(value ?? 0));
	});
	try {
		await new Command("fabric")
			.exitOverride()
			.addCommand(buildAgentsCommand())
			.parseAsync(args, { from: "user" });
	} catch (error) {
		if (error instanceof ExitSignal) {
			code = error.code;
		} else if (error instanceof CommanderError) {
			code = error.exitCode;
		} else {
			throw error;
		}
	} finally {
		out.mockRestore();
		err.mockRestore();
		exit.mockRestore();
	}
	return { stdout, stderr, code };
}
const receipt = {
	executionId: "example-execution",
	deploymentId: "example-deployment",
	workflowId: "example-workflow",
	runId: "example-run",
	status: "PENDING",
	admissionStatus: "CONFIRMED",
	idempotent: false,
};
beforeEach(() => {
	vi.resetAllMocks();
	m.context.value = { type: "org", slug: "example-org" };
	m.invoke.mockResolvedValue(receipt);
	m.get.mockResolvedValue({
		...receipt,
		status: "COMPLETED",
		output: { summary: "Cited result" },
	});
});
describe("saved agent invocation CLI", () => {
	it("sends an explicit stable key, unchanged input and organization", async () => {
		const result = await run([
			"agents",
			"invoke-instance",
			"example-instance",
			"--org",
			"example-team",
			"--input",
			'{"message":"Create report"}',
			"--priority",
			"HIGH",
			"--idempotency-key",
			"example-request",
			"--format",
			"json",
		]);
		expect(result.code).toBe(0);
		expect(m.invoke).toHaveBeenCalledWith("example-instance", {
			org: "example-team",
			input: { message: "Create report" },
			priority: "HIGH",
			idempotencyKey: "example-request",
		});
		expect(JSON.parse(result.stdout)).toEqual({
			...receipt,
			idempotencyKey: "example-request",
		});
	});
	it("generates a recoverable request ID and displays it on a network failure", async () => {
		m.invoke.mockRejectedValueOnce(new Error("Connection closed"));
		const first = await run([
			"agents",
			"invoke-instance",
			"example-instance",
			"--input",
			'{"message":"Create report"}',
		]);
		expect(first.code).toBe(1);
		const key = m.invoke.mock.calls[0][1].idempotencyKey;
		expect(key).toMatch(/^[a-f0-9-]{36}$/);
		expect(first.stderr).toContain(`--idempotency-key ${key}`);
		expect(m.invoke).toHaveBeenCalledTimes(1);
		const second = await run([
			"agents",
			"invoke-instance",
			"example-instance",
			"--input",
			'{"message":"Create report"}',
			"--request-id",
			key,
		]);
		expect(second.code).toBe(0);
		expect(m.invoke.mock.calls[1]).toEqual(m.invoke.mock.calls[0]);
	});
	it("includes known unresolved receipt IDs and never retries automatically", async () => {
		m.invoke.mockRejectedValue(
			Object.assign(new Error("Admission unresolved"), {
				data: {
					executionId: "example-execution",
					workflowId: "example-workflow",
					deploymentId: "example-deployment",
					retryable: true,
				},
			}),
		);
		const result = await run([
			"agents",
			"invoke-instance",
			"example-instance",
			"--idempotency-key",
			"example-request",
		]);
		expect(result.stderr).toContain("executionId: example-execution");
		expect(result.stderr).toContain("workflowId: example-workflow");
		expect(result.stderr).toContain("Do not use a new key");
		expect(m.invoke).toHaveBeenCalledTimes(1);
	});
	it.each([
		["--input", "[]"],
		["--input", "null"],
		["--input", "{invalid"],
		["--priority", "URGENT"],
		["--idempotency-key", "unsafe request id"],
		["--format", "csv"],
	])(
		"rejects invalid invocation options %s %s before mutation",
		async (flag, value) => {
			const result = await run([
				"agents",
				"invoke-instance",
				"example-instance",
				flag,
				value,
			]);
			expect(result.code).toBe(2);
			expect(m.invoke).not.toHaveBeenCalled();
		},
	);
	it("rejects conflicting request-key aliases", async () => {
		const result = await run([
			"agents",
			"invoke-instance",
			"example-instance",
			"--request-id",
			"one",
			"--idempotency-key",
			"two",
		]);
		expect(result.code).toBe(2);
		expect(m.invoke).not.toHaveBeenCalled();
	});
	it("requires an organization context and refuses retired personal defaults", async () => {
		m.context.value = undefined;
		expect(
			(await run(["agents", "invoke-instance", "example-instance"])).code,
		).toBe(2);
		m.context.value = { type: "personal" };
		expect(
			(await run(["agents", "invoke-instance", "example-instance"])).code,
		).toBe(2);
		expect(m.invoke).not.toHaveBeenCalled();
	});
	it("reads actual execution output with one authorized polling request", async () => {
		const result = await run([
			"agents",
			"instance-execution",
			"example-execution",
		]);
		expect(result.code).toBe(0);
		expect(m.get).toHaveBeenCalledWith("example-execution", {
			org: "example-org",
		});
		expect(m.get).toHaveBeenCalledTimes(1);
		expect(JSON.parse(result.stdout)).toMatchObject({
			status: "COMPLETED",
			output: { summary: "Cited result" },
		});
	});
});
