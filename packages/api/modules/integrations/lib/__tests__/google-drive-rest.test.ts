import { afterEach, describe, expect, it, vi } from "vitest";
import {
	exportGoogleDocText,
	GoogleDriveExportAuthError,
	GoogleDriveExportNotFoundError,
	GoogleDriveExportTransientError,
} from "../google-drive-rest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
afterEach(() => fetchMock.mockReset());

describe("exportGoogleDocText", () => {
	it("exports as text/plain on 2xx", async () => {
		fetchMock.mockResolvedValue({ ok: true, text: async () => "hello" });
		const text = await exportGoogleDocText({ token: "t", fileId: "d1" });
		const calledUrl = fetchMock.mock.calls[0][0] as string;
		expect(calledUrl).toContain("/files/d1/export");
		expect(calledUrl).toContain("text%2Fplain");
		expect(text).toBe("hello");
	});

	it("throws GoogleDriveExportAuthError on 401", async () => {
		fetchMock.mockResolvedValue({ ok: false, status: 401 });
		await expect(
			exportGoogleDocText({ token: "t", fileId: "d1" }),
		).rejects.toBeInstanceOf(GoogleDriveExportAuthError);
	});

	it("throws GoogleDriveExportAuthError on 403", async () => {
		fetchMock.mockResolvedValue({ ok: false, status: 403 });
		await expect(
			exportGoogleDocText({ token: "t", fileId: "d1" }),
		).rejects.toBeInstanceOf(GoogleDriveExportAuthError);
	});

	it("throws GoogleDriveExportNotFoundError on 404", async () => {
		fetchMock.mockResolvedValue({ ok: false, status: 404 });
		await expect(
			exportGoogleDocText({ token: "t", fileId: "d1" }),
		).rejects.toBeInstanceOf(GoogleDriveExportNotFoundError);
	});

	it("throws GoogleDriveExportTransientError on 429", async () => {
		fetchMock.mockResolvedValue({ ok: false, status: 429 });
		await expect(
			exportGoogleDocText({ token: "t", fileId: "d1" }),
		).rejects.toBeInstanceOf(GoogleDriveExportTransientError);
	});

	it("throws GoogleDriveExportTransientError on 500", async () => {
		fetchMock.mockResolvedValue({ ok: false, status: 500 });
		await expect(
			exportGoogleDocText({ token: "t", fileId: "d1" }),
		).rejects.toBeInstanceOf(GoogleDriveExportTransientError);
	});

	it("throws a generic Error for unclassified statuses", async () => {
		fetchMock.mockResolvedValue({ ok: false, status: 418 });
		await expect(
			exportGoogleDocText({ token: "t", fileId: "d1" }),
		).rejects.toThrow(/418/);
	});
});
