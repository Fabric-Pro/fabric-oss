import { ORPCError } from "@orpc/client";
import { NOTION_EMPTY_CONTENT } from "@repo/utils/notion-error-reasons";
import { describe, expect, it } from "vitest";
import {
	NOTION_ADD_FALLBACK_MESSAGE,
	notionAddErrorMessage,
} from "../notion-add-error-message";

describe("notionAddErrorMessage", () => {
	it("uses client copy for the empty-content reason", () => {
		expect(
			notionAddErrorMessage(
				new ORPCError("BAD_REQUEST", {
					message: "Untrusted server text",
					data: { reason: NOTION_EMPTY_CONTENT },
				}),
			),
		).toBe("Fabric could not read any content from this Notion page.");
	});
	it.each([undefined, {}, { reason: "OTHER" }])(
		"rejects an upstream BAD_REQUEST with data %j",
		(data) => {
			expect(
				notionAddErrorMessage(
					new ORPCError("BAD_REQUEST", {
						message:
							'Notion API error 429: {"detail":"upstream body"}',
						data,
					}),
				),
			).toBe(NOTION_ADD_FALLBACK_MESSAGE);
		},
	);
	it.each(["INTERNAL_SERVER_ERROR", "UNAUTHORIZED"])(
		"rejects code %s even with the reason",
		(code) => {
			expect(
				notionAddErrorMessage(
					new ORPCError(code, {
						message: "Untrusted server text",
						data: { reason: NOTION_EMPTY_CONTENT },
					}),
				),
			).toBe(NOTION_ADD_FALLBACK_MESSAGE);
		},
	);
	it("rejects a plain Error with matching code and reason", () => {
		expect(
			notionAddErrorMessage(
				Object.assign(new Error("Untrusted exception"), {
					code: "BAD_REQUEST",
					data: { reason: NOTION_EMPTY_CONTENT },
				}),
			),
		).toBe(NOTION_ADD_FALLBACK_MESSAGE);
	});
	it.each([
		null,
		undefined,
		"boom",
		{ code: "BAD_REQUEST", data: { reason: NOTION_EMPTY_CONTENT } },
	])("rejects non-Error %j", (value) => {
		expect(notionAddErrorMessage(value)).toBe(NOTION_ADD_FALLBACK_MESSAGE);
	});
});
