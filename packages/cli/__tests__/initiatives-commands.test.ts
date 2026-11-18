import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	createFeature: vi.fn(),
	listFeatures: vi.fn(),
	output: vi.fn(),
	record: vi.fn(),
	success: vi.fn(),
	error: vi.fn((message: string, code: number) => {
		throw Object.assign(new Error(message), { code });
	}),
}));

vi.mock("../src/lib/client.js", () => ({
	getClient: () => ({
		projects: {
			createFeature: m.createFeature,
			listFeatures: m.listFeatures,
		},
	}),
}));

vi.mock("../src/lib/context.js", () => ({
	resolveContext: (_project: unknown, org: string | undefined) => ({
		type: "org",
		slug: org ?? "example-org",
	}),
}));

vi.mock("../src/lib/output.js", () => ({
	printOutput: m.output,
	printRecord: m.record,
	printSuccess: m.success,
	printError: m.error,
}));

import { buildFeaturesCommand } from "../src/commands/features/index.js";

const runFeatures = (args: string[]) =>
	buildFeaturesCommand().exitOverride().parseAsync(args, { from: "user" });

beforeEach(() => {
	vi.resetAllMocks();
	m.createFeature.mockResolvedValue({
		id: "f-1",
		identifier: "I-001",
		kind: "INITIATIVE",
		title: "Q3",
		priority: "P2_MEDIUM",
		projectId: "p1",
		createdAt: "2026-11-16T00:00:00.000Z",
	});
});

describe("CLI — initiatives commands", () => {
	it("features list -p p1 --kind bug passes kind: 'BUG' to listFeatures", async () => {
		m.listFeatures.mockResolvedValue([]);
		await runFeatures(["list", "-p", "p1", "--kind", "bug"]);
		expect(m.listFeatures).toHaveBeenCalledWith(
			"p1",
			expect.objectContaining({ kind: "BUG" }),
		);
	});

	it("features create 'Q3' -p p1 --kind initiative calls createFeature with kind: 'INITIATIVE'", async () => {
		await runFeatures(["create", "Q3", "-p", "p1", "--kind", "initiative"]);
		expect(m.createFeature).toHaveBeenCalledWith("p1", {
			title: "Q3",
			description: undefined,
			priority: undefined,
			kind: "INITIATIVE",
			org: "example-org",
		});
		expect(m.success).toHaveBeenCalledWith("Initiative I-001 created");
	});

	it("features create ... --kind epic exits 1 with the error", async () => {
		await expect(
			runFeatures(["create", "Q3", "-p", "p1", "--kind", "epic"]),
		).rejects.toMatchObject({
			message: "--kind must be one of: feature, initiative",
			code: 1,
		});
		expect(m.createFeature).not.toHaveBeenCalled();
	});
});
