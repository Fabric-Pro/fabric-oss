import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// withProviderBreaker just wraps the call; pass it through so the spy on
// S3Client.send is what we assert against. logger is silenced.
vi.mock("@repo/observability", () => ({
	withProviderBreaker: (_service: string, _op: string, fn: () => unknown) =>
		fn(),
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
}));

import { listObjects, mapListObjectsV2Page } from "../index";

describe("mapListObjectsV2Page", () => {
	it("maps Contents to objects and preserves the continuation token", () => {
		const d = new Date("2026-06-01T00:00:00.000Z");
		const res = mapListObjectsV2Page({
			Contents: [
				{
					Key: "story-attachments-tmp/a.png",
					LastModified: d,
					Size: 42,
				},
			],
			NextContinuationToken: "tok",
		});
		expect(res.objects).toEqual([
			{ key: "story-attachments-tmp/a.png", lastModified: d, size: 42 },
		]);
		expect(res.nextContinuationToken).toBe("tok");
	});

	it("returns undefined token for the final page (never empty string)", () => {
		expect(
			mapListObjectsV2Page({ Contents: [], NextContinuationToken: "" })
				.nextContinuationToken,
		).toBeUndefined();
		expect(
			mapListObjectsV2Page({ Contents: [] }).nextContinuationToken,
		).toBeUndefined();
	});

	it("omits entries missing a Key", () => {
		const d = new Date();
		const res = mapListObjectsV2Page({
			Contents: [
				{ LastModified: d, Size: 1 },
				{ Key: "k", LastModified: d, Size: 1 },
			],
		});
		expect(res.objects.map((o) => o.key)).toEqual(["k"]);
	});

	it("omits entries missing LastModified (undateable -> never a deletion candidate)", () => {
		const res = mapListObjectsV2Page({
			Contents: [
				{ Key: "k1", Size: 1 },
				{ Key: "k2", LastModified: new Date(), Size: 1 },
			],
		});
		expect(res.objects.map((o) => o.key)).toEqual(["k2"]);
	});

	it("defaults a missing Size to 0", () => {
		const d = new Date();
		expect(
			mapListObjectsV2Page({ Contents: [{ Key: "k", LastModified: d }] })
				.objects[0].size,
		).toBe(0);
	});

	it("handles an empty/absent Contents array", () => {
		expect(mapListObjectsV2Page({}).objects).toEqual([]);
	});
});

describe("listObjects (ListObjectsV2Command construction)", () => {
	beforeEach(() => {
		process.env.S3_ENDPOINT = "http://localhost:9000";
		process.env.S3_ACCESS_KEY_ID = "test";
		process.env.S3_SECRET_ACCESS_KEY = "test";
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("passes bucket/prefix/continuationToken/maxKeys to the command and maps the response", async () => {
		const d = new Date("2026-06-01T00:00:00.000Z");
		const sendSpy = vi.spyOn(S3Client.prototype, "send").mockResolvedValue({
			Contents: [
				{
					Key: "story-attachments-tmp/a.png",
					LastModified: d,
					Size: 5,
				},
			],
			NextContinuationToken: "n",
		} as never);

		const res = await listObjects({
			bucket: "b",
			prefix: "story-attachments-tmp/",
			continuationToken: "c",
			maxKeys: 500,
		});

		expect(sendSpy).toHaveBeenCalledTimes(1);
		const command = sendSpy.mock.calls[0][0] as ListObjectsV2Command;
		expect(command).toBeInstanceOf(ListObjectsV2Command);
		expect(command.input).toMatchObject({
			Bucket: "b",
			Prefix: "story-attachments-tmp/",
			ContinuationToken: "c",
			MaxKeys: 500,
		});
		expect(res.objects).toEqual([
			{ key: "story-attachments-tmp/a.png", lastModified: d, size: 5 },
		]);
		expect(res.nextContinuationToken).toBe("n");
	});

	it("defaults MaxKeys to 1000 when omitted", async () => {
		const sendSpy = vi
			.spyOn(S3Client.prototype, "send")
			.mockResolvedValue({ Contents: [] } as never);
		await listObjects({ bucket: "b", prefix: "p/" });
		const command = sendSpy.mock.calls[0][0] as ListObjectsV2Command;
		expect(command.input.MaxKeys).toBe(1000);
	});

	it("wraps SDK errors in a generic message", async () => {
		vi.spyOn(S3Client.prototype, "send").mockRejectedValue(
			new Error("boom") as never,
		);
		await expect(
			listObjects({ bucket: "b", prefix: "p/" }),
		).rejects.toThrow("Could not list objects in S3");
	});
});
