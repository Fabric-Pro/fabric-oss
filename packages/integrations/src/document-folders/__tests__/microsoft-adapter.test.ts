import {
	DOCUMENT_FOLDER_CONTEXT_PROVIDER,
	type DocumentFolderProvider,
} from "@repo/database/prisma/queries/projects/document-folders/constants";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	executeTool: vi.fn(),
	resolveOwn: vi.fn(),
}));

// The Graph tool is the adapter's boundary: what it is asked for is what
// Graph is asked for.
vi.mock("../../microsoft/index", () => ({
	executeMicrosoftTeamsTool: mocks.executeTool,
}));

vi.mock("@repo/database", () => ({
	resolveOwnWorkflowIntegrationForProvider: mocks.resolveOwn,
}));

import { documentFolderDriveAdapter } from "../adapter";

const connection = {
	userId: "user-1",
	organizationId: "org-1",
	connectionId: "conn-1",
};

beforeEach(() => {
	mocks.executeTool.mockReset();
	mocks.resolveOwn.mockReset();
});

describe("Microsoft document-folder adapter", () => {
	const adapter = documentFolderDriveAdapter("onedrive");

	it("is the adapter for SharePoint folders too", () => {
		expect(documentFolderDriveAdapter("sharepoint")).toBe(adapter);
	});

	it("resolves the person's own Microsoft connection", async () => {
		mocks.resolveOwn.mockResolvedValue({ id: "conn-1" });
		await expect(
			adapter.resolveOwnConnection({
				userId: "user-1",
				organizationId: "org-1",
			}),
		).resolves.toEqual({ status: "connected", connection });
		expect(mocks.resolveOwn).toHaveBeenCalledWith(
			"MICROSOFT_GRAPH",
			"user-1",
			"org-1",
		);
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

	it("reads item details as the connection, adding the item's drive path", async () => {
		mocks.executeTool.mockResolvedValue({
			status: "ok",
			item: {
				id: "item-1",
				name: "Q3",
				driveId: "drive-1",
				driveType: "business",
				provider: "onedrive",
				isFolder: true,
				webUrl: "https://example.com/q3",
				parentPath: "/Plans",
			},
		});

		const result = await adapter.getItemDetails(connection, {
			driveId: "drive-1",
			itemId: "item-1",
		});

		expect(result).toEqual({
			status: "ok",
			item: expect.objectContaining({
				id: "item-1",
				provider: "onedrive",
				parentPath: "/Plans",
				drivePath: "/Plans/Q3",
			}),
		});
		expect(mocks.executeTool).toHaveBeenCalledWith(
			"get_drive_item",
			{ driveId: "drive-1", itemId: "item-1" },
			"user-1",
			"org-1",
			"conn-1",
		);
	});

	it("gives a drive's root no drive path", async () => {
		mocks.executeTool.mockResolvedValue({
			status: "ok",
			item: {
				id: "root-id",
				name: "root",
				driveId: "drive-1",
				driveType: "business",
				provider: "onedrive",
				isFolder: true,
				webUrl: null,
				parentPath: null,
			},
		});
		const result = await adapter.getItemDetails(connection, {
			driveId: "drive-1",
			itemId: "root",
		});
		expect(result.status === "ok" && result.item.drivePath).toBeNull();
	});

	it("returns a failed item read as Graph answered it", async () => {
		const failed = {
			status: "failed",
			httpStatus: 429,
			retryAfterSeconds: 30,
		};
		mocks.executeTool.mockResolvedValue(failed);
		await expect(
			adapter.getItemDetails(connection, {
				driveId: "drive-1",
				itemId: "item-1",
			}),
		).resolves.toEqual(failed);
	});

	it("lists a folder tree as the connection, reporting progress", async () => {
		const listing = { status: "complete", files: [] };
		mocks.executeTool.mockResolvedValue(listing);
		const onProgress = vi.fn();

		await expect(
			adapter.listFolderTree(
				connection,
				{ driveId: "drive-1", itemId: "item-1" },
				{ onProgress },
			),
		).resolves.toEqual(listing);
		expect(mocks.executeTool).toHaveBeenCalledWith(
			"list_drive_tree",
			{ driveId: "drive-1", itemId: "item-1" },
			"user-1",
			"org-1",
			"conn-1",
			{ onProgress },
		);
	});

	it("looks items up as the connection, reporting progress", async () => {
		const placements = {
			items: [{ itemId: "file-1", state: "gone" }],
		};
		mocks.executeTool.mockResolvedValue(placements);
		const onProgress = vi.fn();

		await expect(
			adapter.lookupItemsInFolder(
				connection,
				{
					driveId: "drive-1",
					folderItemId: "item-1",
					itemIds: ["file-1"],
				},
				{ onProgress },
			),
		).resolves.toEqual(placements);
		expect(mocks.executeTool).toHaveBeenCalledWith(
			"lookup_drive_items",
			{ driveId: "drive-1", folderItemId: "item-1", itemIds: ["file-1"] },
			"user-1",
			"org-1",
			"conn-1",
			{ onProgress },
		);
	});

	it("downloads a file as the connection, within the byte cap", async () => {
		const download = {
			status: "too_large",
			name: "big.pdf",
			size: 99_000_000,
		};
		mocks.executeTool.mockResolvedValue(download);

		await expect(
			adapter.downloadFile(connection, {
				driveId: "drive-1",
				itemId: "file-1",
				maxBytes: 1024,
			}),
		).resolves.toEqual(download);
		expect(mocks.executeTool).toHaveBeenCalledWith(
			"download_drive_item",
			{ driveId: "drive-1", itemId: "file-1", maxBytes: 1024 },
			"user-1",
			"org-1",
			"conn-1",
		);
	});

	it("recognises a Microsoft not-connected error", () => {
		expect(
			adapter.isNotConnectedError(
				"Microsoft not connected. Please connect your Microsoft account in Settings > Integrations.",
			),
		).toBe(true);
		expect(adapter.isNotConnectedError("Graph answered 500")).toBe(false);
	});
});

describe("documentFolderDriveAdapter", () => {
	it("throws for a provider it has no adapter for", () => {
		expect(() => documentFolderDriveAdapter("dropbox")).toThrow(
			/No document-folder adapter/,
		);
		expect(() => documentFolderDriveAdapter("toString")).toThrow(
			/No document-folder adapter/,
		);
	});

	it("has an adapter and a context provider for every folder provider", () => {
		const providers: DocumentFolderProvider[] = [
			"onedrive",
			"sharepoint",
			"googledrive",
		];
		expect(Object.keys(DOCUMENT_FOLDER_CONTEXT_PROVIDER).sort()).toEqual(
			[...providers].sort(),
		);
		for (const provider of providers) {
			expect(documentFolderDriveAdapter(provider)).toBeDefined();
		}
		expect(DOCUMENT_FOLDER_CONTEXT_PROVIDER.googledrive).toBe(
			"googledrive-documents",
		);
	});
});
