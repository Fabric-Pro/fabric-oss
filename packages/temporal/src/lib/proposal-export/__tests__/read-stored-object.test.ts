/**
 * Reading a stored object for a Proposal export (Fizzy #2946): the object is
 * streamed and the read abandoned once it passes the cap, so an object
 * replaced by a larger one after any size check still never fills memory.
 * Storage is a mock that hands back a stream.
 */

import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({ getObjectStream: vi.fn() }));

vi.mock("@repo/storage", () => storage);

import { readStoredObjectWithin } from "../read-stored-object";

const LOCATION = {
	bucket: "example-bucket",
	key: "document-media/project-example/document-example/x.png",
};

beforeEach(() => {
	storage.getObjectStream.mockReset();
});

describe("readStoredObjectWithin", () => {
	it("reads an object within the cap", async () => {
		storage.getObjectStream.mockResolvedValue(
			Readable.from([Buffer.from("by"), Buffer.from("tes")]),
		);

		await expect(readStoredObjectWithin(LOCATION, 10)).resolves.toEqual(
			Buffer.from("bytes"),
		);
		expect(storage.getObjectStream).toHaveBeenCalledWith(LOCATION.key, {
			bucket: LOCATION.bucket,
		});
	});

	it("abandons an object past the cap without reading the rest of it", async () => {
		let produced = 0;
		const endless = Readable.from(
			(function* () {
				for (;;) {
					produced++;
					yield Buffer.alloc(1024);
				}
			})(),
		);
		storage.getObjectStream.mockResolvedValue(endless);

		await expect(
			readStoredObjectWithin(LOCATION, 10_000),
		).rejects.toThrow();
		expect(produced).toBeLessThan(20);
		expect(endless.destroyed).toBe(true);
	});

	it("rejects when the object cannot be opened", async () => {
		storage.getObjectStream.mockRejectedValue(new Error("NoSuchKey"));

		await expect(readStoredObjectWithin(LOCATION, 10)).rejects.toThrow(
			"NoSuchKey",
		);
	});
});
