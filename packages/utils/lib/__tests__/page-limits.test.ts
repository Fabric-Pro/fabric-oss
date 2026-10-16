import { describe, expect, it } from "vitest";
import {
	base64DecodedSize,
	base64LengthOf,
	COMMENTS_COLLECTION,
	cleanPageFileName,
	FILES_COLLECTION,
	PAGE_DOWNLOAD_MAX_BASE64_LENGTH,
	PAGE_DOWNLOAD_MAX_BYTES,
	PAGE_FILE_MAX_BYTES,
	PAGE_FILES_MAX_BYTES,
	PAGE_LIST_DEFAULT,
	PAGE_LIST_MAX,
	RESERVED_COLLECTION_PREFIX,
	RESERVED_PAGE_COLLECTIONS,
} from "../page-limits";

describe("the limits", () => {
	it("keep the host's collections under the reserved prefix, and nothing else under it", () => {
		expect(RESERVED_PAGE_COLLECTIONS).toEqual([
			FILES_COLLECTION,
			COMMENTS_COLLECTION,
		]);
		for (const name of RESERVED_PAGE_COLLECTIONS) {
			expect(name.startsWith(RESERVED_COLLECTION_PREFIX)).toBe(true);
		}
	});

	it("hold a file within the page's quota, and a default list within the most a list returns", () => {
		expect(PAGE_FILE_MAX_BYTES).toBeLessThan(PAGE_FILES_MAX_BYTES);
		expect(PAGE_LIST_DEFAULT).toBeLessThanOrEqual(PAGE_LIST_MAX);
	});

	it("give the base64 length of the largest download exactly", () => {
		expect(PAGE_DOWNLOAD_MAX_BASE64_LENGTH).toBe(
			base64LengthOf(PAGE_DOWNLOAD_MAX_BYTES),
		);
		const atTheCap = Buffer.alloc(PAGE_DOWNLOAD_MAX_BYTES).toString(
			"base64",
		);
		expect(atTheCap.length).toBe(PAGE_DOWNLOAD_MAX_BASE64_LENGTH);
	});
});

describe("base64DecodedSize", () => {
	it.each([
		["", 0],
		["QQ==", 1],
		["QUI=", 2],
		["QUJD", 3],
		[Buffer.from("hello world").toString("base64"), 11],
	])("reads the size of %j as %d", (text, size) => {
		expect(base64DecodedSize(text)).toBe(size);
	});

	it.each([
		["a length the alphabet cannot make", "abc"],
		["a character outside the alphabet", "QUJD!A=="],
		["padding in the middle", "QQ==QQ=="],
		["whitespace", "QUJD QUJD"],
	])("refuses %s", (_label, text) => {
		expect(base64DecodedSize(text)).toBeNull();
	});

	it("agrees with what Buffer decodes, for every length from 0 to 40", () => {
		for (let length = 0; length <= 40; length += 1) {
			const bytes = Buffer.alloc(length, 7);
			expect(base64DecodedSize(bytes.toString("base64"))).toBe(length);
		}
	});
});

describe("cleanPageFileName", () => {
	it("leaves an ordinary name as it is", () => {
		expect(cleanPageFileName("Q3 report (final).csv")).toBe(
			"Q3 report (final).csv",
		);
	});

	it.each([
		["a path", "../../etc/report.csv", "report.csv"],
		["a Windows path", "C:\\Users\\sam\\report.csv", "report.csv"],
		["leading dots", "...hidden.csv", "hidden.csv"],
		["reserved characters", 're<po>rt:"1"|?.csv', "report1.csv"],
		["control characters", "re\u0000po\nrt.csv", "report.csv"],
		["runs of spaces", "my    report.csv", "my report.csv"],
		["trailing dots and spaces", "report.csv. . ", "report.csv"],
	])("removes %s", (_label, raw, expected) => {
		expect(cleanPageFileName(raw)).toBe(expected);
	});

	it.each([
		["a right-to-left override", "invoice\u202Egpj.exe", "invoicegpj.exe"],
		["a left-to-right isolate", "a\u2066b\u2069.csv", "ab.csv"],
		["zero-width characters", "re\u200Bpo\u200Drt\u2060.csv", "report.csv"],
		["a byte-order mark", "\uFEFFreport.csv", "report.csv"],
		["directional marks", "a\u200Eb\u200F.csv", "ab.csv"],
	])(
		"removes %s, which would reorder or hide the name",
		(_label, raw, expected) => {
			expect(cleanPageFileName(raw)).toBe(expected);
		},
	);

	it("is empty when nothing is left of the name", () => {
		expect(cleanPageFileName("...")).toBe("");
		expect(cleanPageFileName("a/")).toBe("");
		expect(cleanPageFileName("<>:")).toBe("");
		expect(cleanPageFileName("\u202E\u200B")).toBe("");
	});

	it("cuts a long name to 100 characters and keeps its extension", () => {
		const cleaned = cleanPageFileName(`${"a".repeat(300)}.csv`);

		expect(cleaned).toHaveLength(100);
		expect(cleaned.endsWith(".csv")).toBe(true);
	});
});
