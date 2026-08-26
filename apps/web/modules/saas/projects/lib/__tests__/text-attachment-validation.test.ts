import { describe, expect, it } from "vitest";
import {
	MAX_TEXT_ATTACHMENT_BYTES,
	validateTextAttachmentFile,
} from "../text-attachment-validation";

/** Build a File whose `.size` reports `size` without allocating the bytes. */
function makeFile(name: string, type: string, size: number): File {
	const f = new File([""], name, { type });
	Object.defineProperty(f, "size", { value: size });
	return f;
}

const DOCX =
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document";

describe("validateTextAttachmentFile", () => {
	it("accepts a .docx within the size limit", () => {
		expect(
			validateTextAttachmentFile(makeFile("spec.docx", DOCX, 1024)),
		).toEqual({
			valid: true,
		});
	});

	it("accepts a .md reported with an empty browser mime (extension rescue)", () => {
		expect(
			validateTextAttachmentFile(makeFile("notes.md", "", 2048)),
		).toEqual({
			valid: true,
		});
	});

	it("accepts a .txt", () => {
		expect(
			validateTextAttachmentFile(
				makeFile("readme.txt", "text/plain", 10),
			),
		).toEqual({ valid: true });
	});

	it("accepts a .excalidraw reported with an empty browser mime (#1942)", () => {
		expect(
			validateTextAttachmentFile(makeFile("board.excalidraw", "", 4096)),
		).toEqual({ valid: true });
	});

	it("rejects an unsupported type (pdf)", () => {
		expect(
			validateTextAttachmentFile(
				makeFile("a.pdf", "application/pdf", 10),
			),
		).toEqual({ valid: false, errorCode: "unsupported-type" });
	});

	it("rejects an image", () => {
		expect(
			validateTextAttachmentFile(makeFile("a.png", "image/png", 10)),
		).toEqual({ valid: false, errorCode: "unsupported-type" });
	});

	it("rejects a file over 25 MB (AE1)", () => {
		expect(
			validateTextAttachmentFile(
				makeFile(
					"big.txt",
					"text/plain",
					MAX_TEXT_ATTACHMENT_BYTES + 1,
				),
			),
		).toEqual({ valid: false, errorCode: "too-large" });
	});

	it("accepts a file exactly at the 25 MB boundary", () => {
		expect(
			validateTextAttachmentFile(
				makeFile("edge.txt", "text/plain", MAX_TEXT_ATTACHMENT_BYTES),
			),
		).toEqual({ valid: true });
	});
});
