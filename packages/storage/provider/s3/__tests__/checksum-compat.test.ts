import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/observability", () => ({
	withProviderBreaker: (_service: string, _op: string, fn: () => unknown) =>
		fn(),
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
}));

import { getSignedUploadUrl, getSignedUrl } from "../index";

/**
 * Regression guard for the AWS SDK >=3.729.0 default-integrity change.
 *
 * With the default `requestChecksumCalculation: "WHEN_SUPPORTED"`, the
 * presigner hoists a SIGNED empty-body `x-amz-checksum-crc32` (plus
 * `x-amz-sdk-checksum-algorithm`) into presigned PUT URLs. S3-compatible
 * backends (Cloudflare R2 in prod, MinIO in dev) then reject every browser
 * upload with a checksum mismatch, because the browser PUTs a real body the
 * empty-body checksum never matches. The client must be configured with
 * `requestChecksumCalculation: "WHEN_REQUIRED"` to keep presigned URLs
 * byte-compatible with the pre-3.729 wire format.
 *
 * These tests presign locally (no network) — mocked-send tests can never
 * catch this class of regression.
 */
describe("presigned URLs carry no checksum parameters", () => {
	beforeEach(() => {
		process.env.S3_ENDPOINT = "http://localhost:9000";
		process.env.S3_ACCESS_KEY_ID = "test";
		process.env.S3_SECRET_ACCESS_KEY = "test";
	});

	const FORBIDDEN_PARAM = /x-amz-(sdk-)?checksum/i;

	it("presigned PUT (upload) URL has no x-amz-checksum-* / x-amz-sdk-checksum-* params", async () => {
		const url = await getSignedUploadUrl("avatars/user-1.jpg", {
			bucket: "test-bucket",
			contentType: "image/jpeg",
		});
		const parsed = new URL(url);
		for (const key of parsed.searchParams.keys()) {
			expect(key).not.toMatch(FORBIDDEN_PARAM);
		}
		// The checksum params ride in X-Amz-SignedHeaders too when present —
		// assert the whole signed-headers list is checksum-free.
		expect(
			parsed.searchParams.get("X-Amz-SignedHeaders") ?? "",
		).not.toMatch(FORBIDDEN_PARAM);
	});

	it("presigned GET URL has no checksum params", async () => {
		const url = await getSignedUrl("documents/doc-1.pdf", {
			bucket: "test-bucket",
			expiresIn: 60,
		});
		const parsed = new URL(url);
		for (const key of parsed.searchParams.keys()) {
			expect(key).not.toMatch(FORBIDDEN_PARAM);
		}
	});
});
