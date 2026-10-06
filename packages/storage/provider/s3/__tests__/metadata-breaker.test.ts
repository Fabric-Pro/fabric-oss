import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { __resetBreakersForTests } from "@repo/observability/breakers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../../observability/lib/integration-providers";
import { getFileMetadata } from "../index";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@aws-sdk/client-s3")>();
	return {
		...actual,
		S3Client: class {
			send = send;
			middlewareStack = { add: vi.fn() };
		},
	};
});
vi.mock("@repo/observability", () => import("@repo/observability/breakers"));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
}));

describe("S3 metadata circuit breaker", () => {
	beforeEach(() => {
		__resetBreakersForTests();
		send.mockReset();
		vi.stubEnv("S3_ENDPOINT", "https://storage.example.com");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		__resetBreakersForTests();
	});

	it("keeps expected missing-object probes from blocking an existing object", async () => {
		send.mockRejectedValue(
			Object.assign(new Error("missing"), { name: "NotFound" }),
		);
		for (let index = 0; index < 6; index++) {
			await expect(
				getFileMetadata(`missing-${index}`, { bucket: "instructions" }),
			).resolves.toBeNull();
		}
		send.mockResolvedValue({
			ContentLength: 12,
			ContentType: "text/plain",
		});
		await expect(
			getFileMetadata("existing", { bucket: "instructions" }),
		).resolves.toMatchObject({ size: 12, pathname: "existing" });
		expect(send).toHaveBeenCalledTimes(7);
		expect(send.mock.calls[6][0]).toBeInstanceOf(HeadObjectCommand);
	});

	it("still opens the circuit after genuine provider failures", async () => {
		send.mockRejectedValue(new Error("provider unavailable"));
		for (let index = 0; index < 5; index++) {
			await expect(
				getFileMetadata("existing", { bucket: "instructions" }),
			).rejects.toThrow("Could not get file metadata from S3");
		}
		send.mockResolvedValue({ ContentLength: 12 });
		await expect(
			getFileMetadata("existing", { bucket: "instructions" }),
		).rejects.toThrow("Could not get file metadata from S3");
		expect(send).toHaveBeenCalledTimes(5);
	});
});
