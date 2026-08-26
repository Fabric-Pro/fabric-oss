import { DeleteObjectsCommand, S3Client } from "@aws-sdk/client-s3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/observability", () => ({
	withProviderBreaker: (_service: string, _op: string, fn: () => unknown) =>
		fn(),
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
}));

import { deleteObjects, mapDeleteObjectsResult } from "../index";

describe("mapDeleteObjectsResult", () => {
	it("counts Deleted entries and maps Errors", () => {
		const res = mapDeleteObjectsResult({
			Deleted: [{ Key: "a" }, { Key: "b" }],
			Errors: [{ Key: "c", Message: "AccessDenied" }],
		});
		expect(res.deleted).toBe(2);
		expect(res.errors).toEqual([{ key: "c", message: "AccessDenied" }]);
	});

	it("falls back to Code, then a generic message, for an error missing Message", () => {
		expect(
			mapDeleteObjectsResult({ Errors: [{ Key: "c", Code: "Slow" }] })
				.errors[0].message,
		).toBe("Slow");
		expect(
			mapDeleteObjectsResult({ Errors: [{ Key: "c" }] }).errors[0]
				.message,
		).toBe("unknown error");
	});

	it("handles absent Deleted/Errors arrays", () => {
		expect(mapDeleteObjectsResult({})).toEqual({ deleted: 0, errors: [] });
	});
});

describe("deleteObjects", () => {
	beforeEach(() => {
		process.env.S3_ENDPOINT = "http://localhost:9000";
		process.env.S3_ACCESS_KEY_ID = "test";
		process.env.S3_SECRET_ACCESS_KEY = "test";
	});
	afterEach(() => vi.restoreAllMocks());

	it("is a no-op on empty input (no command sent)", async () => {
		const sendSpy = vi.spyOn(S3Client.prototype, "send");
		const res = await deleteObjects([], { bucket: "b" });
		expect(sendSpy).not.toHaveBeenCalled();
		expect(res).toEqual({ deleted: 0, errors: [] });
	});

	it("builds one DeleteObjectsCommand for <=1000 keys and maps the result", async () => {
		const sendSpy = vi.spyOn(S3Client.prototype, "send").mockResolvedValue({
			Deleted: [{ Key: "k1" }, { Key: "k2" }],
		} as never);
		const res = await deleteObjects(["k1", "k2"], { bucket: "b" });
		expect(sendSpy).toHaveBeenCalledTimes(1);
		const cmd = sendSpy.mock.calls[0][0] as DeleteObjectsCommand;
		expect(cmd).toBeInstanceOf(DeleteObjectsCommand);
		expect(cmd.input.Bucket).toBe("b");
		// EXACT shape — pins verbose mode. `toEqual` fails if anyone adds `Quiet: true`,
		// which would make S3 omit successful `Deleted` entries and zero the count.
		expect(cmd.input.Delete).toEqual({
			Objects: [{ Key: "k1" }, { Key: "k2" }],
		});
		expect(res.deleted).toBe(2);
		expect(res.errors).toEqual([]);
	});

	it("splits >1000 keys into multiple commands (1500 -> 1000 + 500)", async () => {
		const sendSpy = vi
			.spyOn(S3Client.prototype, "send")
			.mockResolvedValue({ Deleted: [] } as never);
		const keys = Array.from({ length: 1500 }, (_, i) => `k${i}`);
		await deleteObjects(keys, { bucket: "b" });
		expect(sendSpy).toHaveBeenCalledTimes(2);
		const first = sendSpy.mock.calls[0][0] as DeleteObjectsCommand;
		const second = sendSpy.mock.calls[1][0] as DeleteObjectsCommand;
		expect(first.input.Delete?.Objects).toHaveLength(1000);
		expect(second.input.Delete?.Objects).toHaveLength(500);
	});

	it("accumulates per-object S3 Errors without throwing", async () => {
		vi.spyOn(S3Client.prototype, "send").mockResolvedValue({
			Deleted: [{ Key: "k1" }],
			Errors: [{ Key: "k2", Message: "denied" }],
		} as never);
		const res = await deleteObjects(["k1", "k2"], { bucket: "b" });
		expect(res.deleted).toBe(1);
		expect(res.errors).toEqual([{ key: "k2", message: "denied" }]);
	});

	it("records every key of a chunk whose send rejects, and continues to the next chunk", async () => {
		const keys = Array.from({ length: 1500 }, (_, i) => `k${i}`);
		vi.spyOn(S3Client.prototype, "send")
			.mockRejectedValueOnce(new Error("network") as never)
			.mockResolvedValueOnce({
				Deleted: Array(500).fill({ Key: "x" }),
			} as never);
		const res = await deleteObjects(keys, { bucket: "b" });
		expect(res.errors).toHaveLength(1000);
		expect(res.errors[0]).toEqual({ key: "k0", message: "network" });
		expect(res.deleted).toBe(500);
	});
});

describe("deleteObjects — client build failure", () => {
	const ENV_KEYS = [
		"S3_ENDPOINT",
		"S3_ACCESS_KEY_ID",
		"S3_SECRET_ACCESS_KEY",
	] as const;
	let saved: Record<string, string | undefined>;

	beforeEach(() => {
		saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
	});
	afterEach(() => {
		for (const k of ENV_KEYS) {
			if (saved[k] === undefined) {
				delete process.env[k];
			} else {
				process.env[k] = saved[k];
			}
		}
		vi.resetModules();
	});

	it("never throws when the S3 client cannot be built (missing env) — records every key as an error", async () => {
		// getS3Client() memoises the client at module scope, so reset + re-import
		// to get a fresh module whose client has NOT been built yet, then make the
		// build fail by clearing S3_ENDPOINT.
		vi.resetModules();
		process.env.S3_ENDPOINT = "";
		const fresh = await import("../index");
		const res = await fresh.deleteObjects(["k1", "k2"], { bucket: "b" });
		expect(res.deleted).toBe(0);
		expect(res.errors.map((e) => e.key)).toEqual(["k1", "k2"]);
		expect(res.errors[0].message).toMatch(/S3_ENDPOINT/);
	});
});
