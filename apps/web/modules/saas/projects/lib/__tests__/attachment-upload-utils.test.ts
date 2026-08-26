import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			stories: {
				createAttachmentUploadUrl: vi.fn().mockResolvedValue({
					signedUploadUrl: "https://put.example",
					storageKey: "story-attachments/p1/s1/x.pdf",
					contentType: "application/pdf",
				}),
				createAttachment: vi.fn().mockResolvedValue({
					attachment: { id: "a1", filename: "x.pdf" },
				}),
			},
		},
	},
}));
vi.mock("../image-upload-utils", () => ({
	uploadToS3: vi.fn().mockResolvedValue(undefined),
}));

import { orpcClient } from "@shared/lib/orpc-client";
import { uploadStoryAttachment } from "../attachment-upload-utils";
import { uploadToS3 } from "../image-upload-utils";

const makeFile = (type: string, size: number) => {
	const f = new File(["x"], "doc.pdf", { type });
	Object.defineProperty(f, "size", { value: size });
	return f;
};

const makeNamedFile = (name: string, type: string, size = 10) => {
	const f = new File(["x"], name, { type });
	Object.defineProperty(f, "size", { value: size });
	return f;
};

describe("uploadStoryAttachment", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Restore default mock for createAttachmentUploadUrl after any per-test overrides.
		vi.mocked(
			orpcClient.projects.stories.createAttachmentUploadUrl,
		).mockResolvedValue({
			signedUploadUrl: "https://put.example",
			storageKey: "story-attachments/p1/s1/x.pdf",
			contentType: "application/pdf",
		} as never);
		vi.mocked(
			orpcClient.projects.stories.createAttachment,
		).mockResolvedValue({
			attachment: { id: "a1", filename: "x.pdf" },
		} as never);
		vi.mocked(uploadToS3).mockResolvedValue(undefined);
	});

	it("rejects a non-allowlisted type before any network call", async () => {
		await expect(
			uploadStoryAttachment({
				file: makeNamedFile(
					"virus.exe",
					"application/x-msdownload",
					10,
				),
				projectId: "p1",
				userStoryId: "s1",
				organizationId: null,
			}),
		).rejects.toThrow();
		expect(
			orpcClient.projects.stories.createAttachmentUploadUrl,
		).not.toHaveBeenCalled();
	});

	it("rejects an oversize file before any network call", async () => {
		await expect(
			uploadStoryAttachment({
				file: makeFile("application/pdf", 26 * 1024 * 1024),
				projectId: "p1",
				userStoryId: "s1",
				organizationId: null,
			}),
		).rejects.toThrow();
	});

	it("runs the full pipeline and returns the created attachment", async () => {
		const res = await uploadStoryAttachment({
			file: makeFile("application/pdf", 10),
			projectId: "p1",
			userStoryId: "s1",
			organizationId: null,
		});
		expect(res.id).toBe("a1");
		expect(
			orpcClient.projects.stories.createAttachment,
		).toHaveBeenCalledWith(
			expect.objectContaining({
				storageKey: "story-attachments/p1/s1/x.pdf",
				filename: "doc.pdf",
			}),
		);
	});

	it("throws when no presigned URL is returned, without uploading", async () => {
		vi.mocked(
			orpcClient.projects.stories.createAttachmentUploadUrl,
		).mockResolvedValue({
			signedUploadUrl: null,
			storageKey: "story-attachments/p1/s1/x.pdf",
		} as never);
		await expect(
			uploadStoryAttachment({
				file: makeFile("application/pdf", 10),
				projectId: "p1",
				userStoryId: "s1",
				organizationId: null,
			}),
		).rejects.toThrow(/temporarily unavailable/i);
		expect(uploadToS3).not.toHaveBeenCalled();
	});

	it("passes the server contentType to uploadToS3", async () => {
		await uploadStoryAttachment({
			file: makeFile("application/pdf", 10),
			projectId: "p1",
			userStoryId: "s1",
			organizationId: null,
		});
		expect(uploadToS3).toHaveBeenCalledWith(
			expect.objectContaining({ contentType: "application/pdf" }),
		);
	});

	it("resolves a .md file with an empty browser mime and uploads it", async () => {
		vi.mocked(
			orpcClient.projects.stories.createAttachmentUploadUrl,
		).mockResolvedValue({
			signedUploadUrl: "https://put.example",
			storageKey: "story-attachments/p1/s1/x.md",
			contentType: "text/markdown",
		} as never);
		await uploadStoryAttachment({
			file: makeNamedFile("notes.md", ""),
			projectId: "p1",
			userStoryId: "s1",
			organizationId: null,
		});
		// sent the RESOLVED mime to the server, not the empty browser mime
		expect(
			orpcClient.projects.stories.createAttachmentUploadUrl,
		).toHaveBeenCalledWith(
			expect.objectContaining({
				mimeType: "text/markdown",
				filename: "notes.md",
			}),
		);
		expect(uploadToS3).toHaveBeenCalledWith(
			expect.objectContaining({ contentType: "text/markdown" }),
		);
	});

	it("forwards the designation to createAttachment when passed", async () => {
		await uploadStoryAttachment({
			file: makeFile("application/pdf", 10),
			projectId: "p1",
			userStoryId: "s1",
			organizationId: null,
			designation: "UNLOCKED",
		});
		expect(
			orpcClient.projects.stories.createAttachment,
		).toHaveBeenCalledWith(
			expect.objectContaining({ designation: "UNLOCKED" }),
		);
	});

	it("omits designation from createAttachment when not passed (server defaults LOCKED)", async () => {
		await uploadStoryAttachment({
			file: makeFile("application/pdf", 10),
			projectId: "p1",
			userStoryId: "s1",
			organizationId: null,
		});
		const arg = vi.mocked(orpcClient.projects.stories.createAttachment).mock
			.calls[0][0] as Record<string, unknown>;
		expect(arg).not.toHaveProperty("designation");
	});

	it("rejects a malformed .excalidraw before any network call (#1942)", async () => {
		const file = new File(["{ not json"], "diagram.excalidraw", {
			type: "",
		});
		await expect(
			uploadStoryAttachment({
				file,
				projectId: "p1",
				userStoryId: "s1",
				organizationId: null,
			}),
		).rejects.toThrow(/Excalidraw/);
		expect(
			orpcClient.projects.stories.createAttachmentUploadUrl,
		).not.toHaveBeenCalled();
	});
});
