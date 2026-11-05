import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	list: vi.fn(),
	history: vi.fn(),
	update: vi.fn(),
	restore: vi.fn(),
	startExport: vi.fn(),
	getExport: vi.fn(),
	cancelExport: vi.fn(),
	downloadExport: vi.fn(),
	sharing: vi.fn(),
	share: vi.fn(),
	revokeSharing: vi.fn(),
	read: vi.fn(),
	output: vi.fn(),
	error: vi.fn((message: string) => {
		throw Error(message);
	}),
}));
vi.mock("node:fs/promises", () => ({ readFile: m.read }));
vi.mock("../src/lib/client.js", () => ({
	getClient: () => ({
		frames: {
			list: m.list,
			history: m.history,
			update: m.update,
			restore: m.restore,
			startExport: m.startExport,
			getExport: m.getExport,
			cancelExport: m.cancelExport,
			downloadExport: m.downloadExport,
			sharing: m.sharing,
			share: m.share,
			revokeSharing: m.revokeSharing,
		},
	}),
}));
vi.mock("../src/lib/context.js", () => ({
	resolveContext: (_personal: unknown, org?: string) => ({
		type: "org",
		slug: org ?? "example-org",
	}),
}));
vi.mock("../src/lib/output.js", () => ({
	printOutput: m.output,
	printRecord: vi.fn(),
	printError: m.error,
}));

import { buildFramesCommand } from "../src/commands/frames/index.js";

const run = (args: string[]) =>
	buildFramesCommand().exitOverride().parseAsync(args, { from: "user" });
beforeEach(() => {
	vi.clearAllMocks();
	m.list.mockResolvedValue([]);
});
describe("Frames CLI discovery", () => {
	it("forwards conversation and pagination filters", async () => {
		await run([
			"list",
			"--org",
			"example-org",
			"--conversation",
			"example-thread",
			"--offset",
			"20",
			"--limit",
			"21",
		]);
		expect(m.list).toHaveBeenCalledWith({
			org: "example-org",
			conversationId: "example-thread",
			offset: 20,
			limit: 21,
		});
	});
	it.each([
		["--offset", "-1"],
		["--offset", "no"],
		["--limit", "0"],
		["--limit", "201"],
	])("refuses invalid pagination %j", async (...args) => {
		await expect(run(["list", ...args])).rejects.toThrow("Use --limit");
		expect(m.list).not.toHaveBeenCalled();
	});
});

it("forwards exact reviewed revisions and stable restore targets", async () => {
	const edit = {
		expectedUpdatedAt: "2026-11-01T00:00:00Z",
		title: "Example revised",
	};
	m.read.mockResolvedValue(JSON.stringify(edit));
	await run([
		"update",
		"example-frame",
		"example.json",
		"--org",
		"example-org",
	]);
	expect(m.update).toHaveBeenCalledWith("example-frame", edit, {
		org: "example-org",
	});
	await run([
		"restore",
		"example-frame",
		"example-entry",
		"--expected-updated-at",
		edit.expectedUpdatedAt,
		"--org",
		"example-org",
	]);
	expect(m.restore).toHaveBeenCalledWith(
		"example-frame",
		{
			historyEntryId: "example-entry",
			expectedUpdatedAt: edit.expectedUpdatedAt,
		},
		{ org: "example-org" },
	);
	await run(["history", "example-frame", "--org", "example-org"]);
	expect(m.history).toHaveBeenCalledWith("example-frame", {
		org: "example-org",
	});
});

it("forwards a durable export request and separate status/download/cancel actions", async () => {
	const revision = "2026-11-01T00:00:00Z";
	const requestId = "12345678-1234-4123-8123-123456789abc";
	await run([
		"exports",
		"start",
		"example-frame",
		"--expected-updated-at",
		revision,
		"--request-id",
		requestId,
	]);
	expect(m.startExport).toHaveBeenCalledWith(
		"example-frame",
		{ expectedUpdatedAt: revision, requestId, orientation: "portrait" },
		{ org: "example-org" },
	);
	for (const action of ["status", "download", "cancel"]) {
		await run(["exports", action, "example-frame", "example-export"]);
	}
	expect(m.getExport).toHaveBeenCalledWith(
		"example-frame",
		"example-export",
		{ org: "example-org" },
	);
	expect(m.downloadExport).toHaveBeenCalledOnce();
	expect(m.cancelExport).toHaveBeenCalledOnce();
});
it("requires deliberate revoke modes and forwards explicit sharing JSON", async () => {
	const expectedUpdatedAt = "2026-11-01T00:00:00Z";
	m.read.mockResolvedValue(
		JSON.stringify({ scope: "PUBLIC", expectedUpdatedAt }),
	);
	await run(["share", "example-frame", "example.json"]);
	expect(m.share).toHaveBeenCalledWith(
		"example-frame",
		{ scope: "PUBLIC", expectedUpdatedAt },
		{ org: "example-org" },
	);
	await run([
		"revoke-sharing",
		"example-frame",
		"--mode",
		"invitation",
		"--email",
		"reader@example.com",
		"--expected-updated-at",
		expectedUpdatedAt,
	]);
	expect(m.revokeSharing).toHaveBeenCalledWith(
		"example-frame",
		{ mode: "invitation", email: "reader@example.com", expectedUpdatedAt },
		{ org: "example-org" },
	);
	await expect(
		run([
			"revoke-sharing",
			"example-frame",
			"--mode",
			"invitation",
			"--expected-updated-at",
			expectedUpdatedAt,
		]),
	).rejects.toThrow("Choose public-link");
});
