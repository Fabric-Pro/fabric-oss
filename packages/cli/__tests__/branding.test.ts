import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	get: vi.fn(),
	getStyle: vi.fn(),
	updateStyle: vi.fn(),
	clientOptions: vi.fn(),
	company: vi.fn(),
	client: vi.fn(),
	read: vi.fn(),
	output: vi.fn(),
	error: vi.fn((message: string) => {
		throw new Error(message);
	}),
}));
vi.mock("node:fs/promises", () => ({ readFile: m.read }));
vi.mock("../src/lib/client.js", () => ({
	getClient: (options: unknown) => {
		m.clientOptions(options);
		return {
			branding: {
				get: m.get,
				getProposalStyle: m.getStyle,
				updateProposalStyle: m.updateStyle,
				updateCompany: m.company,
				updateClient: m.client,
			},
		};
	},
}));
vi.mock("../src/lib/output.js", () => ({
	printOutput: m.output,
	printError: m.error,
}));

import { buildBrandingCommand } from "../src/commands/branding/index.js";

const run = (args: string[]) =>
	buildBrandingCommand().exitOverride().parseAsync(args, { from: "user" });
beforeEach(() => {
	vi.clearAllMocks();
	m.company.mockResolvedValue({ outcome: "applied", version: 3 });
	m.client.mockResolvedValue({ outcome: "applied", version: 3 });
});
describe("branding CLI", () => {
	it("reads project-scoped branding", async () => {
		await run([
			"show",
			"--project",
			"example-project",
			"--org",
			"example-org",
		]);
		expect(m.get).toHaveBeenCalledWith({
			projectId: "example-project",
			org: "example-org",
		});
		expect(m.clientOptions).toHaveBeenCalledWith({
			project: "example-project",
		});
	});
	it("passes reviewed version and text to company save", async () => {
		const input = { expectedVersion: 2, guidance: "Reviewed" };
		m.read.mockResolvedValue(JSON.stringify(input));
		await run(["update-company", "--file", "example.json"]);
		expect(m.company).toHaveBeenCalledWith(input, { org: undefined });
	});
	it("refuses unversioned writes before making a request", async () => {
		m.read.mockResolvedValue(JSON.stringify({ name: "Example" }));
		await expect(
			run([
				"update-client",
				"--project",
				"example-project",
				"--file",
				"example.json",
			]),
		).rejects.toThrow("expectedVersion");
		expect(m.client).not.toHaveBeenCalled();
	});
	it("reports concurrency conflicts as unsuccessful", async () => {
		m.read.mockResolvedValue(
			JSON.stringify({
				expectedVersion: 2,
				name: "Example",
				colors: [],
				website: null,
			}),
		);
		m.client.mockResolvedValue({ outcome: "conflict" });
		await expect(
			run([
				"update-client",
				"--project",
				"example-project",
				"--file",
				"example.json",
			]),
		).rejects.toThrow("Brand changed");
	});
});

it("reads a specific Proposal and saves reviewed catalog branding without changing the timestamp", async () => {
	await run([
		"show-proposal-style",
		"--project",
		"example-project",
		"--document",
		"example-document",
	]);
	expect(m.getStyle).toHaveBeenCalledWith(
		"example-project",
		"example-document",
		{ org: undefined },
	);
	const input = {
		expectedUpdatedAt: null,
		brandSource: "CLIENT",
		coverStyle: "MINIMAL",
	};
	m.read.mockResolvedValue(JSON.stringify(input));
	await run([
		"update-proposal-style",
		"--project",
		"example-project",
		"--document",
		"example-document",
		"--file",
		"example.json",
	]);
	expect(m.updateStyle).toHaveBeenCalledWith(
		"example-project",
		"example-document",
		input,
		{ org: undefined },
	);
});
it("refuses unreviewed proposal Style updates before making a request", async () => {
	m.read.mockResolvedValue(JSON.stringify({ brandSource: "CLIENT" }));
	await expect(
		run([
			"update-proposal-style",
			"--project",
			"example-project",
			"--document",
			"example-document",
			"--file",
			"example.json",
		]),
	).rejects.toThrow("expectedUpdatedAt");
	expect(m.updateStyle).not.toHaveBeenCalled();
});
