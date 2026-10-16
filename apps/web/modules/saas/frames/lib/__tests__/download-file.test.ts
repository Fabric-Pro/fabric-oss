import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadHref, saveBase64File } from "../download-file";

let clicked: Array<{ href: string; download: string }> = [];
let blobs: Blob[] = [];
let revoked: string[] = [];
let originalCreate: typeof URL.createObjectURL;
let originalRevoke: typeof URL.revokeObjectURL;

beforeEach(() => {
	clicked = [];
	blobs = [];
	revoked = [];
	vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
		this: HTMLAnchorElement,
	) {
		clicked.push({ href: this.href, download: this.download });
	});
	originalCreate = URL.createObjectURL;
	originalRevoke = URL.revokeObjectURL;
	URL.createObjectURL = (blob: Blob) => {
		blobs.push(blob);
		return "blob:https://app.example.com/file-1";
	};
	URL.revokeObjectURL = (url: string) => {
		revoked.push(url);
	};
});

afterEach(() => {
	URL.createObjectURL = originalCreate;
	URL.revokeObjectURL = originalRevoke;
	vi.restoreAllMocks();
});

describe("downloadHref", () => {
	it("offers the address to the browser as a file of that name", () => {
		downloadHref("https://app.example.com/a.png", "a.png");

		expect(clicked).toEqual([
			{ href: "https://app.example.com/a.png", download: "a.png" },
		]);
	});
});

describe("saveBase64File", () => {
	it("saves the bytes the page sent, as the type it named, under its file name", async () => {
		saveBase64File({
			filename: "report.csv",
			mimeType: "text/csv",
			dataBase64: btoa("a,b\n1,2\n"),
		});

		expect(clicked).toEqual([
			{
				href: "blob:https://app.example.com/file-1",
				download: "report.csv",
			},
		]);
		expect(blobs).toHaveLength(1);
		expect(blobs[0].type).toBe("text/csv");
		expect(blobs[0].size).toBe(8);
		expect(
			Array.from(new Uint8Array(await blobs[0].arrayBuffer())),
		).toEqual(Array.from(new TextEncoder().encode("a,b\n1,2\n")));
	});

	it("lets the address go once the browser has it", () => {
		saveBase64File({
			filename: "a.txt",
			mimeType: "text/plain",
			dataBase64: btoa("hi"),
		});

		expect(revoked).toEqual(["blob:https://app.example.com/file-1"]);
	});

	it("keeps every byte of a binary file", async () => {
		const bytes = Uint8Array.from([0, 255, 128, 10, 13, 200]);

		saveBase64File({
			filename: "a.png",
			mimeType: "image/png",
			dataBase64: btoa(String.fromCharCode(...bytes)),
		});

		expect(
			Array.from(new Uint8Array(await blobs[0].arrayBuffer())),
		).toEqual(Array.from(bytes));
	});
});
