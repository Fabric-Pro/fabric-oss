import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/observability", () => ({
	withProviderBreaker: (
		_service: string,
		_operation: string,
		fn: () => unknown,
	) => fn(),
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
}));

import { ensureBuckets } from "../index";

describe("ensureBuckets", () => {
	beforeEach(() => {
		vi.stubEnv("S3_ENDPOINT", "http://localhost:9000");
		vi.stubEnv("S3_ACCESS_KEY_ID", "test");
		vi.stubEnv("S3_SECRET_ACCESS_KEY", "test");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it("starts every bucket check before the first pending check resolves", async () => {
		// Arrange
		let resolveFirstCheck: (() => void) | undefined;
		const firstCheck = new Promise<void>((resolve) => {
			resolveFirstCheck = resolve;
		});
		const sendSpy = vi
			.spyOn(S3Client.prototype, "send")
			.mockImplementationOnce(() => firstCheck as never)
			.mockResolvedValue({} as never);

		// Act
		const bucketCheck = ensureBuckets(["avatars", "chat-documents"]);

		// Assert
		expect(sendSpy).toHaveBeenCalledTimes(2);
		expect(sendSpy.mock.calls).toEqual([
			[expect.any(HeadBucketCommand)],
			[expect.any(HeadBucketCommand)],
		]);

		if (!resolveFirstCheck) {
			throw new Error("The first S3 check was not started");
		}
		resolveFirstCheck();
		await bucketCheck;
	});
});
