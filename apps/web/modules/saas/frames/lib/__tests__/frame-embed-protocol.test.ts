import {
	PAGE_DOWNLOAD_MAX_BASE64_LENGTH,
	PAGE_DOWNLOAD_MAX_BYTES,
} from "@repo/utils/page-limits";
import { describe, expect, it } from "vitest";
import {
	isFrameRuntimeCallResult,
	isFrameRuntimeRequest,
} from "../frame-embed-protocol";

const DOWNLOAD = {
	type: "fabric-frame:download",
	filename: "report.csv",
	mimeType: "text/csv",
	dataBase64: "YSxiCjEsMgo=",
};

describe("a download request", () => {
	it("is one of the runtime's requests when it carries a name, a type and text", () => {
		expect(isFrameRuntimeRequest(DOWNLOAD)).toBe(true);
	});

	it.each([
		["no name", { filename: undefined }],
		["a name that is not text", { filename: 7 }],
		["no type", { mimeType: undefined }],
		["a type that is not text", { mimeType: {} }],
		["no data", { dataBase64: undefined }],
		["data that is not text", { dataBase64: [1, 2, 3] }],
		["a name of 501 characters", { filename: "n".repeat(501) }],
		["a type of 501 characters", { mimeType: "t".repeat(501) }],
		[
			"more data than a download may hold",
			{ dataBase64: "A".repeat(PAGE_DOWNLOAD_MAX_BASE64_LENGTH + 1) },
		],
	])("is not one with %s", (_label, change) => {
		expect(isFrameRuntimeRequest({ ...DOWNLOAD, ...change })).toBe(false);
	});

	it("is one at the largest size it may have, which holds the largest file a download may be", () => {
		expect(
			isFrameRuntimeRequest({
				...DOWNLOAD,
				filename: "n".repeat(500),
				dataBase64: "A".repeat(PAGE_DOWNLOAD_MAX_BASE64_LENGTH),
			}),
		).toBe(true);
		const largestFile = Buffer.alloc(PAGE_DOWNLOAD_MAX_BYTES).toString(
			"base64",
		);
		expect(
			isFrameRuntimeRequest({ ...DOWNLOAD, dataBase64: largestFile }),
		).toBe(true);
	});
});

describe("an answer to a call", () => {
	const FAILED = {
		type: "fabric-frame:call-result",
		requestId: "r1",
		ok: false,
		error: "The page is busy.",
	};

	it("is believed with a result, or with a message", () => {
		expect(
			isFrameRuntimeCallResult({
				type: "fabric-frame:call-result",
				requestId: "r1",
				ok: true,
				result: { a: 1 },
			}),
		).toBe(true);
		expect(isFrameRuntimeCallResult(FAILED)).toBe(true);
	});

	it("is believed with the reason a tool gave and whether to try again", () => {
		expect(
			isFrameRuntimeCallResult({
				...FAILED,
				reason: "busy",
				retryable: true,
			}),
		).toBe(true);
	});

	it.each([
		["a reason that is not text", { reason: { not: "text" } }],
		["a retry flag that is not true or false", { retryable: "yes" }],
		["no message", { error: undefined }],
	])("is not believed with %s", (_label, change) => {
		expect(isFrameRuntimeCallResult({ ...FAILED, ...change })).toBe(false);
	});
});
