import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { inflateRawSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getObjectStream: vi.fn(),
	putObjectStream: vi.fn(),
}));
vi.mock("@repo/storage", () => mocks);

import { streamInstructionZip } from "../../src/export/stream-zip";

const files = Array.from({ length: 40 }, (_, index) => ({
	path: `file-${index}.md`,
	storageKey: `key-${index}`,
	size: 1,
	mode: null,
}));
const input = {
	key: "export.zip",
	bucket: "skills",
	date: new Date("2026-01-01"),
	files,
};
beforeEach(() => {
	vi.resetAllMocks();
	mocks.getObjectStream.mockImplementation(async () =>
		Readable.from([Buffer.from("x")]),
	);
	mocks.putObjectStream.mockImplementation(async (_key, body: Readable) => {
		for await (const _chunk of body) {
			/* Consume the real archive. */
		}
	});
});

describe("streamed instruction exports", () => {
	it("round-trips every file in a 70 MiB tree through the real ZIP stream", async () => {
		const size = 5 * 1024 * 1024;
		const largeFiles = Array.from({ length: 14 }, (_, index) => ({
			path: `file-${index}.md`,
			storageKey: `key-${index}`,
			size,
			mode: 0o644,
		}));
		const chunk = Buffer.alloc(64 * 1024, "x");
		mocks.getObjectStream.mockImplementation(async () =>
			Readable.from(
				(function* () {
					for (let i = 0; i < 80; i++) yield chunk;
				})(),
			),
		);
		const chunks: Buffer[] = [];
		mocks.putObjectStream.mockImplementation(
			async (_key, body: Readable) => {
				for await (const data of body) chunks.push(data);
			},
		);
		await streamInstructionZip({ ...input, files: largeFiles });
		const zip = Buffer.concat(chunks);
		const end = zip.length - 22;
		expect(zip.readUInt32LE(end)).toBe(0x06054b50);
		expect(zip.readUInt16LE(end + 10)).toBe(14);
		let offset = zip.readUInt32LE(end + 16);
		const expectedHash = createHash("sha256")
			.update(Buffer.alloc(size, "x"))
			.digest("hex");
		for (const file of largeFiles) {
			expect(zip.readUInt32LE(offset)).toBe(0x02014b50);
			const nameLength = zip.readUInt16LE(offset + 28);
			expect(
				zip.toString("utf8", offset + 46, offset + 46 + nameLength),
			).toBe(file.path);
			const local = zip.readUInt32LE(offset + 42);
			const data =
				local +
				30 +
				zip.readUInt16LE(local + 26) +
				zip.readUInt16LE(local + 28);
			const bytes = inflateRawSync(
				zip.subarray(data, data + zip.readUInt32LE(offset + 20)),
			);
			expect(bytes.length).toBe(size);
			expect(createHash("sha256").update(bytes).digest("hex")).toBe(
				expectedHash,
			);
			offset +=
				46 +
				nameLength +
				zip.readUInt16LE(offset + 30) +
				zip.readUInt16LE(offset + 32);
		}
	});

	it("fails on a source error after the archive has started", async () => {
		mocks.getObjectStream.mockImplementation(async () =>
			Readable.from(
				(async function* () {
					yield Buffer.from("x");
					throw new Error("source failed");
				})(),
			),
		);
		await expect(streamInstructionZip(input)).rejects.toThrow(
			"source failed",
		);
	});
	it("opens at most sixteen unconsumed sources and writes a real ZIP", async () => {
		let opened = 0;
		let maximum = 0;
		mocks.getObjectStream.mockImplementation(async () => {
			opened++;
			maximum = Math.max(maximum, opened);
			const source = Readable.from([Buffer.from("x")]);
			source.once("end", () => opened--);
			return source;
		});
		let total = 0;
		let signature: Buffer | undefined;
		mocks.putObjectStream.mockImplementation(
			async (_key, body: Readable) => {
				for await (const chunk of body) {
					signature ??= chunk;
					total += chunk.length;
				}
			},
		);
		await streamInstructionZip(input);
		expect(maximum).toBeLessThanOrEqual(16);
		expect(maximum).toBeGreaterThan(1);
		expect(signature?.readUInt32LE(0)).toBe(0x04034b50);
		expect(total).toBeGreaterThan(40);
	});

	it("fails and destroys prefetched sources when storage exceeds the approved size", async () => {
		const sources: Readable[] = [];
		mocks.getObjectStream.mockImplementation(async () => {
			const source = Readable.from([Buffer.from("xx")]);
			sources.push(source);
			return source;
		});
		await expect(streamInstructionZip(input)).rejects.toThrow(
			"approved size",
		);
		expect(sources.every((source) => source.destroyed)).toBe(true);
	});

	it("fails and destroys prefetched sources if the upload fails", async () => {
		const sources: Readable[] = [];
		mocks.getObjectStream.mockImplementation(async () => {
			const source = Readable.from([Buffer.from("x")]);
			sources.push(source);
			return source;
		});
		mocks.putObjectStream.mockRejectedValue(new Error("upload failed"));
		await expect(streamInstructionZip(input)).rejects.toThrow(
			"upload failed",
		);
		expect(sources.every((source) => source.destroyed)).toBe(true);
	});
});
