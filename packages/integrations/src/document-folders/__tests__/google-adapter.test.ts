import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	resolveOwn: vi.fn(),
	getToken: vi.fn(),
	hasReadonly: vi.fn(),
}));

// The adapter lookup loads the Microsoft adapter too; Graph is not used here.
vi.mock("../../microsoft/index", () => ({
	executeMicrosoftTeamsTool: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	resolveOwnWorkflowIntegrationForProvider: mocks.resolveOwn,
}));

// The token helper is the adapter's boundary with the stored connection.
vi.mock("../../google/token", async () => ({
	getGoogleDriveAccessToken: mocks.getToken,
	hasGoogleDriveReadonlyScope: mocks.hasReadonly,
	isGoogleDriveNotConnectedError: (
		await import("../../google/connection-errors")
	).isGoogleDriveNotConnectedError,
}));

import { GoogleDriveTokenExpiredError } from "../../google/connection-errors";
import { documentFolderDriveAdapter } from "../adapter";

const connection = {
	userId: "user-1",
	organizationId: "org-1",
	connectionId: "conn-1",
};

beforeEach(() => {
	mocks.resolveOwn.mockReset();
	mocks.getToken.mockReset();
	mocks.hasReadonly.mockReset();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("Google Drive document-folder adapter", () => {
	const adapter = documentFolderDriveAdapter("googledrive");

	it("resolves the person's own Google Drive connection", async () => {
		mocks.resolveOwn.mockResolvedValue({ id: "conn-1" });
		mocks.hasReadonly.mockResolvedValue(true);
		await expect(
			adapter.resolveOwnConnection({
				userId: "user-1",
				organizationId: "org-1",
			}),
		).resolves.toEqual({ status: "connected", connection });
		expect(mocks.resolveOwn).toHaveBeenCalledWith(
			"GOOGLE_DRIVE",
			"user-1",
			"org-1",
		);
		expect(mocks.hasReadonly).toHaveBeenCalledWith(connection);
	});

	it("reports no connection when the person has none of their own", async () => {
		mocks.resolveOwn.mockResolvedValue(null);
		await expect(
			adapter.resolveOwnConnection({
				userId: "user-1",
				organizationId: "org-1",
			}),
		).resolves.toEqual({ status: "not_connected" });
	});

	it("asks for a reconnect when the grant lacks drive.readonly", async () => {
		mocks.resolveOwn.mockResolvedValue({ id: "conn-1" });
		mocks.hasReadonly.mockResolvedValue(false);
		await expect(
			adapter.resolveOwnConnection({
				userId: "user-1",
				organizationId: "org-1",
			}),
		).resolves.toEqual({ status: "reconnect_required" });
	});

	it("reads Drive with the connection's own token", async () => {
		mocks.getToken.mockResolvedValue("token-example");
		const fetchMock = vi.fn(
			async (_url: string, _init?: RequestInit) =>
				new Response(JSON.stringify({ error: { code: 404 } }), {
					status: 404,
				}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			adapter.downloadFile(connection, {
				driveId: "root-id",
				itemId: "file-1",
				maxBytes: 1_000,
			}),
		).resolves.toEqual({ status: "gone" });
		expect(mocks.getToken).toHaveBeenCalledWith(connection);
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(new URL(String(url)).hostname).toBe("www.googleapis.com");
		expect(new Headers(init?.headers).get("authorization")).toBe(
			"Bearer token-example",
		);
	});

	it("reuses a token for 50 seconds within one read, then asks for it again", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		mocks.getToken
			.mockResolvedValueOnce("token-first")
			.mockResolvedValueOnce("token-second");
		const json = (body: unknown) =>
			new Response(JSON.stringify(body), { status: 200 });
		const responses = [
			// The folder's probe, then its two pages of children.
			json({ id: "folder-1" }),
			json({ files: [], nextPageToken: "page-2" }),
			json({ files: [] }),
		];
		const tokens: Array<string | null> = [];
		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
			tokens.push(new Headers(init?.headers).get("authorization"));
			// The first page is read 49 s after the token was fetched, the
			// second 50 s after.
			vi.setSystemTime(
				new Date(
					tokens.length === 1
						? "2026-01-01T00:00:49Z"
						: "2026-01-01T00:00:50Z",
				),
			);
			return responses.shift() ?? json({});
		});
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			adapter.listFolderTree(connection, {
				driveId: "root-id",
				itemId: "folder-1",
			}),
		).resolves.toEqual({ status: "complete", files: [] });
		expect(tokens).toEqual([
			"Bearer token-first",
			"Bearer token-first",
			"Bearer token-second",
		]);
		expect(mocks.getToken).toHaveBeenCalledTimes(2);
	});

	it("recognises an expired Google session as not connected", () => {
		expect(
			adapter.isNotConnectedError(
				new GoogleDriveTokenExpiredError().message,
			),
		).toBe(true);
		expect(adapter.isNotConnectedError("Some other failure")).toBe(false);
	});
});
