import {
	describeDocumentWriteRefusal,
	documentWriteRefusalKind,
} from "@saas/projects/lib/document-write-refusal";
import { describe, expect, it } from "vitest";

const t = ((key: string) => key) as unknown as Parameters<
	typeof describeDocumentWriteRefusal
>[1];

describe("document write refusals (Fizzy #2946)", () => {
	it.each([
		[
			{
				code: "CONFLICT",
				data: { code: "DOCUMENT_GENERATION_IN_PROGRESS" },
			},
			"runLive",
		],
		[{ code: "CONFLICT" }, "changedMeanwhile"],
		[
			{ code: "CONFLICT", data: { code: "NO_PRIOR_VERSION" } },
			"changedMeanwhile",
		],
		[
			{
				code: "PRECONDITION_FAILED",
				data: { code: "DOCUMENT_SAVE_BASE_REQUIRED" },
			},
			"baseRequired",
		],
		[
			{
				code: "BAD_REQUEST",
				data: { code: "DOCUMENT_STATUS_GENERATION_OWNED" },
			},
			"statusGenerationOwned",
		],
		[{ code: "INTERNAL_SERVER_ERROR" }, "failed"],
		[new Error("network down"), "failed"],
		[null, "failed"],
	])("reads %o as %s", (error, kind) => {
		expect(documentWriteRefusalKind(error)).toBe(kind);
	});

	it("shows the reader's words, never the server's message", () => {
		const error = {
			code: "CONFLICT",
			message: "A generation run is writing this document",
			data: { code: "DOCUMENT_GENERATION_IN_PROGRESS" },
		};
		expect(describeDocumentWriteRefusal(error, t)).toEqual({
			kind: "runLive",
			message: "runLive",
		});
	});
});
