import { inflateRawSync } from "node:zlib";
import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	source: vi.fn(),
	pin: vi.fn(),
	current: vi.fn(),
	list: vi.fn(),
	read: vi.fn(),
}));
vi.mock("../direct-source", () => ({
	loadDirectRepositorySource: m.source,
	assertDirectRepositoryPin: m.pin,
	assertDirectRepositorySourceCurrent: m.current,
	directRepositoryPath: (_source: object, path: string) => path,
}));
vi.mock("../direct-read", () => ({ listDirectRepositoryFiles: m.list }));
vi.mock("@repo/connectors", () => ({ readRepositoryFileAtCommit: m.read }));
import { downloadDirectRepository } from "../download";

const input = {
	projectId: "project_example",
	userId: "user_example",
	generation: 1,
	commitSha: "a".repeat(40),
	signal: new AbortController().signal,
};
const binary = Buffer.from([0, 255, 13, 10]);
beforeEach(() => {
	vi.clearAllMocks();
	m.source.mockResolvedValue({ repository: {} });
	m.list.mockResolvedValue({
		incomplete: false,
		refusal: null,
		files: [{ path: "test.bin", mode: "100755" }],
	});
	m.read.mockResolvedValue({ ok: true, state: "found", bytes: binary });
});

it("streams a real ZIP with exact bytes and executable mode without persistent storage", async () => {
	const response = await downloadDirectRepository(input);
	const zip = Buffer.from(await response.arrayBuffer());
	expect(response.headers.get("content-type")).toBe("application/zip");
	const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
	expect(central).toBeGreaterThan(0);
	const local = zip.readUInt32LE(central + 42);
	const offset =
		local +
		30 +
		zip.readUInt16LE(local + 26) +
		zip.readUInt16LE(local + 28);
	const compressed = zip.subarray(
		offset,
		offset + zip.readUInt32LE(central + 20),
	);
	expect(inflateRawSync(compressed)).toEqual(binary);
	expect((zip.readUInt32LE(central + 38) >>> 16) & 0o777).toBe(0o755);
	expect(m.read).toHaveBeenCalledWith(
		expect.objectContaining({ sha: input.commitSha, path: "test.bin" }),
	);
});

it("downloads an allowed single file and refuses excluded paths", async () => {
	const response = await downloadDirectRepository({
		...input,
		path: "test.bin",
	});
	expect(Buffer.from(await response.arrayBuffer())).toEqual(binary);
	await expect(
		downloadDirectRepository({ ...input, path: ".env" }),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
});

it("bounds parallel ZIP reads while authorizing each file before emission", async () => {
	m.list.mockResolvedValue({
		incomplete: false,
		refusal: null,
		files: Array.from({ length: 9 }, (_, index) => ({
			path: `${index}.bin`,
		})),
	});
	let active = 0;
	let peak = 0;
	m.read.mockImplementation(async () => {
		active++;
		peak = Math.max(peak, active);
		await new Promise((resolve) => setTimeout(resolve, 1));
		active--;
		return { ok: true, state: "found", bytes: binary };
	});
	const response = await downloadDirectRepository(input);
	await response.arrayBuffer();
	expect(peak).toBe(4);
	expect(m.read).toHaveBeenCalledTimes(9);
	expect(m.current).toHaveBeenCalledTimes(10);
});

it("refuses incomplete trees and a revoked source", async () => {
	m.list.mockResolvedValue({ incomplete: true, refusal: null, files: [] });
	await expect(downloadDirectRepository(input)).rejects.toMatchObject({
		code: "PRECONDITION_FAILED",
	});
	expect(m.read).not.toHaveBeenCalled();
	m.list.mockResolvedValue({
		incomplete: false,
		refusal: null,
		files: [{ path: "test.bin" }],
	});
	m.current.mockRejectedValueOnce(new Error("revoked"));
	await expect(downloadDirectRepository(input)).rejects.toThrow("revoked");
});

it("releases a cancelled streaming export so later downloads work", async () => {
	for (let attempt = 0; attempt < 5; attempt++) {
		const response = await downloadDirectRepository(input);
		await response.body?.cancel();
	}
	const response = await downloadDirectRepository({
		...input,
		path: "test.bin",
	});
	expect(response.status).toBe(200);
});

it("aborts the current batch on cancellation and never starts the next one", async () => {
	m.list.mockResolvedValue({
		incomplete: false,
		refusal: null,
		files: Array.from({ length: 9 }, (_, index) => ({
			path: `${index}.bin`,
		})),
	});
	const signals: AbortSignal[] = [];
	m.read.mockImplementation(
		({ signal }: { signal: AbortSignal }) =>
			new Promise((resolve) => {
				signals.push(signal);
				signal.addEventListener(
					"abort",
					() => resolve({ ok: false, outcome: "unreachable" }),
					{ once: true },
				);
			}),
	);
	const response = await downloadDirectRepository(input);
	expect(m.read).toHaveBeenCalledTimes(4);
	await response.body?.cancel();
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(signals.every((signal) => signal.aborted)).toBe(true);
	expect(m.read).toHaveBeenCalledTimes(4);
});

it("emits no prefetched bytes after the source grant is revoked", async () => {
	m.list.mockResolvedValue({
		incomplete: false,
		refusal: null,
		files: Array.from({ length: 9 }, (_, index) => ({
			path: `${index}.bin`,
		})),
	});
	m.current
		.mockResolvedValueOnce(undefined)
		.mockRejectedValueOnce(new Error("revoked"));
	const response = await downloadDirectRepository(input);
	await expect(response.body?.getReader().read()).rejects.toThrow(
		"Repository download failed",
	);
	expect(m.read).toHaveBeenCalledTimes(4);
});
