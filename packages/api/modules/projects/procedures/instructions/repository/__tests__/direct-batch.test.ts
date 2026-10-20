import { ORPCError } from "@orpc/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	load: vi.fn(),
	head: vi.fn(),
	pin: vi.fn(),
	fence: vi.fn(),
	list: vi.fn(),
	file: vi.fn(),
	ignore: vi.fn(),
}));
vi.mock("../direct-source", () => ({
	loadDirectRepositorySource: m.load,
	resolveDirectRepositoryHead: m.head,
	assertDirectRepositoryPin: m.pin,
	assertDirectRepositorySourceCurrent: m.fence,
	resolveDirectRepositoryIgnore: m.ignore,
}));
vi.mock("../direct-read", () => ({
	listDirectRepositoryFiles: m.list,
	readDirectRepositoryFile: m.file,
}));

import { readDirectRepositoryFilesForApi } from "../direct-batch";

const pin = { generation: 7, commitSha: "a".repeat(40) };
const paths = Array.from(
	{ length: 12 },
	(_, index) => `.claude/skills/example-${index}/SKILL.md`,
);
const input = { projectId: "project-1", userId: "reader-1", ...pin, paths };
const found = (text: string) => ({
	state: "found",
	text,
	size: Buffer.byteLength(text),
	textLength: Array.from(text).length,
});

beforeEach(() => {
	vi.resetAllMocks();
	m.load.mockImplementation(async (read) => ({
		repository: { signal: read.signal },
	}));
	m.pin.mockResolvedValue(undefined);
	m.fence.mockResolvedValue(undefined);
	m.ignore.mockResolvedValue({ globs: [], layer: "project" });
	m.list.mockResolvedValue({
		files: paths.map((path) => ({ path })),
		incomplete: false,
		refusal: null,
	});
	m.file.mockResolvedValue(found("example\n"));
});
afterEach(() => vi.restoreAllMocks());

describe("bounded pinned repository batches", () => {
	it("returns ordered paths with at most four concurrent content reads", async () => {
		let active = 0;
		let peak = 0;
		m.ignore.mockImplementation(async () => {
			active++;
			peak = Math.max(peak, active);
			await Promise.resolve();
			active--;
			return { globs: [], layer: "project" };
		});
		m.file.mockImplementation(async ({ ignore }) => {
			expect(ignore).toEqual({ globs: [], layer: "project" });
			active++;
			peak = Math.max(peak, active);
			await Promise.resolve();
			active--;
			return found("example\n");
		});
		const page = await readDirectRepositoryFilesForApi(input);
		expect(page).toMatchObject({ ...pin, nextIndex: null });
		expect(page.files.map((file) => file.path)).toEqual(paths);
		expect(peak).toBe(4);
		expect(m.ignore).toHaveBeenCalledOnce();
		expect(m.fence).toHaveBeenCalledOnce();
	});

	it("continues at the next complete file when decoded bytes reach two MiB", async () => {
		m.file.mockResolvedValue(found("x".repeat(256 * 1024)));
		const page = await readDirectRepositoryFilesForApi(input);
		expect(page.files).toHaveLength(8);
		expect(page.nextIndex).toBe(8);
		const next = await readDirectRepositoryFilesForApi({
			...input,
			startIndex: 8,
		});
		expect(next.files.map((file) => file.path)).toEqual(paths.slice(8));
		expect(next.nextIndex).toBeNull();
	});

	it("also bounds JSON escaping independently of decoded bytes", async () => {
		m.file.mockResolvedValue(found("\u0001".repeat(256 * 1024)));
		const page = await readDirectRepositoryFilesForApi(input);
		expect(page.files).toHaveLength(2);
		expect(page.nextIndex).toBe(2);
		expect(Buffer.byteLength(JSON.stringify({ data: page }))).toBeLessThan(
			4 * 1024 * 1024,
		);
	});

	it("stops launching work at its soft deadline and guarantees progress", async () => {
		let now = 0;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		m.file.mockImplementation(async () => {
			now = 11_000;
			return found("example");
		});
		const page = await readDirectRepositoryFilesForApi(input);
		expect(page.nextIndex).toBe(4);
		expect(m.file).toHaveBeenCalledTimes(4);
	});

	it("refuses a file that cannot fit rather than returning a stationary continuation", async () => {
		m.file.mockResolvedValue(found("x".repeat(3 * 1024 * 1024)));
		await expect(
			readDirectRepositoryFilesForApi(input),
		).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
	});

	it.each([
		{ requested: [] },
		{ requested: ["../secret"] },
		{ requested: ["AGENTS.md", "AGENTS.md"] },
		{ requested: [".env"] },
		{ requested: Array.from({ length: 201 }, (_, i) => `file-${i}`) },
	])(
		"refuses invalid, duplicate, excessive or unlisted paths before content reads: $requested",
		async ({ requested }) => {
			await expect(
				readDirectRepositoryFilesForApi({ ...input, paths: requested }),
			).rejects.toBeInstanceOf(ORPCError);
			expect(m.file).not.toHaveBeenCalled();
		},
	);

	it("awaits the pin check before any content reads", async () => {
		m.pin.mockRejectedValue(
			new ORPCError("CONFLICT", { message: "Stale pin" }),
		);
		await expect(
			readDirectRepositoryFilesForApi(input),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(m.list).not.toHaveBeenCalled();
		expect(m.file).not.toHaveBeenCalled();
		expect(m.fence).toHaveBeenCalledOnce();
	});

	it.each(["FORBIDDEN", "CONFLICT"])(
		"withholds results when authority or source changes: %s",
		async (code) => {
			m.fence.mockRejectedValue(
				new ORPCError(code, { message: "Changed" }),
			);
			await expect(
				readDirectRepositoryFilesForApi(input),
			).rejects.toMatchObject({ code });
		},
	);

	it("propagates cancellation to providers and stops subsequent groups", async () => {
		const controller = new AbortController();
		const reason = new Error("Caller stopped");
		m.file.mockImplementation(async ({ source }) => {
			controller.abort(reason);
			expect(source.repository.signal.aborted).toBe(true);
			return found("example");
		});
		await expect(
			readDirectRepositoryFilesForApi({
				...input,
				signal: controller.signal,
			}),
		).rejects.toBe(reason);
		expect(m.file).toHaveBeenCalledTimes(4);
		expect(m.fence).toHaveBeenCalledOnce();
	});

	it("refuses an incomplete or invalid filtered tree", async () => {
		m.list.mockResolvedValue({
			files: [],
			incomplete: true,
			refusal: "invalid_tree",
		});
		await expect(
			readDirectRepositoryFilesForApi(input),
		).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
		expect(m.file).not.toHaveBeenCalled();
	});

	it("applies the twenty-second provider deadline and rejects after it aborts", async () => {
		const deadline = new AbortController();
		const reason = new Error("Operation deadline");
		const timeout = vi
			.spyOn(AbortSignal, "timeout")
			.mockReturnValue(deadline.signal);
		m.file.mockImplementation(async ({ source }) => {
			deadline.abort(reason);
			expect(source.repository.signal.aborted).toBe(true);
			return found("example");
		});
		await expect(readDirectRepositoryFilesForApi(input)).rejects.toBe(
			reason,
		);
		expect(timeout).toHaveBeenCalledWith(20_000);
		expect(m.file).toHaveBeenCalledTimes(4);
		expect(m.fence).toHaveBeenCalledOnce();
	});
});
