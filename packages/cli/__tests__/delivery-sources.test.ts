import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	getClient: vi.fn(),
	output: vi.fn(),
	error: vi.fn(),
	listDeliverySources: vi.fn(),
	testDeliverySource: vi.fn(),
	configureDeliverySource: vi.fn(),
	pauseDeliverySource: vi.fn(),
	resumeDeliverySource: vi.fn(),
	disconnectDeliverySource: vi.fn(),
	startDeliverySourceCapture: vi.fn(),
	getDeliverySourceCapture: vi.fn(),
	cancelDeliverySourceCapture: vi.fn(),
	listDeliverySourceObservations: vi.fn(),
	getDeliverySourceEvidence: vi.fn(),
}));
vi.mock("../src/lib/client.js", () => ({ getClient: m.getClient }));
vi.mock("../src/lib/context.js", () => ({
	resolveContext: () => ({ type: "org", slug: "example-org" }),
}));
vi.mock("../src/lib/output.js", () => ({
	printOutput: m.output,
	printError: m.error,
}));

import { FabricError } from "@fabricorg/sdk";
import { registerProjectSourceCommands } from "../src/commands/projects/sources";

function run(args: string[]) {
	const c = new Command("projects")
		.exitOverride()
		.option("--format <format>");
	registerProjectSourceCommands(c);
	return c.parseAsync(args, { from: "user" });
}
beforeEach(() => {
	vi.clearAllMocks();
	m.getClient.mockReturnValue({ projects: m });
});
describe("private source CLI", () => {
	it("uses project credentials and preserves the original request for a capture retry", async () => {
		await run([
			"sources",
			"capture",
			"example-project",
			"--watch",
			"example-watch",
			"--expected-version",
			"4",
			"--request-id",
			"11111111-1111-4111-8111-111111111111",
			"--mode",
			"CONTINUE",
		]);
		expect(m.getClient).toHaveBeenCalledWith({
			project: "example-project",
		});
		expect(m.startDeliverySourceCapture).toHaveBeenCalledWith(
			"example-project",
			"example-watch",
			{
				org: "example-org",
				requestId: "11111111-1111-4111-8111-111111111111",
				expectedVersion: 4,
				mode: "CONTINUE",
			},
		);
	});
	it("generates an initial mutation id and preserves it with coded errors", async () => {
		m.configureDeliverySource.mockRejectedValue(
			new FabricError("Private source changed.", 409, "SOURCE_CHANGED"),
		);
		const exit = vi.spyOn(process, "exit").mockImplementation(() => {
			throw Error("example-exit");
		});
		try {
			await expect(
				run([
					"sources",
					"connect",
					"example-project",
					"--integration",
					"example-integration",
					"--channel",
					"example-channel",
					"--format",
					"yaml",
				]),
			).rejects.toThrow("example-exit");
			const input = m.configureDeliverySource.mock.calls[0][1];
			expect(input.requestId).toMatch(/^[0-9a-f-]{36}$/);
			expect(m.output).toHaveBeenCalledWith(
				{
					error: {
						code: "SOURCE_CHANGED",
						message: "Private source changed.",
						status: 409,
						requestId: input.requestId,
					},
				},
				{ format: "yaml" },
			);
		} finally {
			exit.mockRestore();
		}
	});
	it("separates metadata from explicit evidence reads", async () => {
		await run([
			"sources",
			"observations",
			"example-project",
			"--watch",
			"example-watch",
			"--limit",
			"5",
			"--cursor",
			"opaque-cursor",
		]);
		expect(m.listDeliverySourceObservations).toHaveBeenCalledWith(
			"example-project",
			"example-watch",
			{ org: "example-org", limit: 5, cursor: "opaque-cursor" },
		);
		expect(m.getDeliverySourceEvidence).not.toHaveBeenCalled();
		await run([
			"sources",
			"evidence",
			"example-project",
			"--watch",
			"example-watch",
			"--observation",
			"example-observation",
		]);
		expect(m.getDeliverySourceEvidence).toHaveBeenCalledWith(
			"example-project",
			"example-watch",
			"example-observation",
			{ org: "example-org" },
		);
	});
});

it("prints honest deployment availability from the project-scoped list", async () => {
	const result = {
		version: 1,
		availability: { state: "UNAVAILABLE", reason: "STORAGE_UNAVAILABLE" },
		watches: [],
		connections: [],
	};
	m.listDeliverySources.mockResolvedValueOnce(result);
	await run(["sources", "list", "example-project"]);
	expect(m.getClient).toHaveBeenCalledWith({ project: "example-project" });
	expect(m.output).toHaveBeenCalledWith(result, { format: "json" });
});
it("preserves coded deployment refusal for capture in machine-readable output", async () => {
	m.startDeliverySourceCapture.mockRejectedValueOnce(
		new FabricError(
			"Private capture is unavailable.",
			503,
			"PRIVATE_SOURCE_CAPTURE_UNAVAILABLE",
		),
	);
	const exit = vi.spyOn(process, "exit").mockImplementation(() => {
		throw Error("example-exit");
	});
	try {
		await expect(
			run([
				"sources",
				"capture",
				"example-project",
				"--watch",
				"example-watch",
				"--expected-version",
				"3",
				"--request-id",
				"11111111-1111-4111-8111-111111111111",
				"--format",
				"json",
			]),
		).rejects.toThrow("example-exit");
		expect(m.output).toHaveBeenCalledWith(
			{
				error: {
					code: "PRIVATE_SOURCE_CAPTURE_UNAVAILABLE",
					message: "Private capture is unavailable.",
					status: 503,
					requestId: "11111111-1111-4111-8111-111111111111",
				},
			},
			{ format: "json" },
		);
	} finally {
		exit.mockRestore();
	}
});

it("forwards an explicitly reviewed history window through the SDK", async () => {
	await run([
		"sources",
		"capture",
		"example-project",
		"--watch",
		"example-watch",
		"--expected-version",
		"4",
		"--request-id",
		"11111111-1111-4111-8111-111111111111",
		"--mode",
		"BACKFILL",
		"--from",
		"2026-10-05T00:00:00.000Z",
		"--to",
		"2026-10-07T00:00:00.000Z",
	]);
	expect(m.startDeliverySourceCapture).toHaveBeenCalledWith(
		"example-project",
		"example-watch",
		expect.objectContaining({
			mode: "BACKFILL",
			window: {
				start: "2026-10-05T00:00:00.000Z",
				end: "2026-10-07T00:00:00.000Z",
			},
		}),
	);
});
