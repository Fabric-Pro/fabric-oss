import { describe, expect, it, vi } from "vitest";
import { submitCreateStoryWithAttachments } from "../submit-create-story-with-attachments";

function makeFile(name: string): File {
	return new File([new Uint8Array(8)], name, { type: "image/png" });
}

function makeDeps(
	overrides?: Partial<{
		create: ReturnType<typeof vi.fn>;
		upload: ReturnType<typeof vi.fn>;
		uploadAttachment: ReturnType<typeof vi.fn>;
		update: ReturnType<typeof vi.fn>;
		close: ReturnType<typeof vi.fn>;
		toastSuccess: ReturnType<typeof vi.fn>;
		toastError: ReturnType<typeof vi.fn>;
		toastWarning: ReturnType<typeof vi.fn>;
	}>,
) {
	const create =
		overrides?.create ??
		vi.fn().mockResolvedValue({
			story: { id: "s1", titleSource: "AI" },
			aiGenerated: false,
		});
	const upload =
		overrides?.upload ??
		vi.fn().mockResolvedValue("story-media/p1/s1/uuid.png");
	const uploadAttachment =
		overrides?.uploadAttachment ??
		vi.fn().mockResolvedValue({ id: "att-1" });
	const update = overrides?.update ?? vi.fn().mockResolvedValue(undefined);
	const close = overrides?.close ?? vi.fn();
	const toastSuccess = overrides?.toastSuccess ?? vi.fn();
	const toastError = overrides?.toastError ?? vi.fn();
	const toastWarning = overrides?.toastWarning ?? vi.fn();
	return {
		createStoryMutateAsync: create,
		uploadStoryImage: upload,
		uploadStoryAttachment: uploadAttachment,
		updateStoryMutateAsync: update,
		closeDialog: close,
		toast: {
			success: toastSuccess,
			error: toastError,
			warning: toastWarning,
		},
		// for assertions:
		_spies: {
			create,
			upload,
			uploadAttachment,
			update,
			close,
			toastSuccess,
			toastError,
			toastWarning,
		},
	};
}

describe("submitCreateStoryWithAttachments", () => {
	it("with no files: calls createStory then closes — no upload, no update", async () => {
		const deps = makeDeps();
		const result = await submitCreateStoryWithAttachments({
			data: { projectId: "p1", description: "hi" } as never,
			files: [],
			organizationId: null,
			deps,
		});
		expect(deps._spies.create).toHaveBeenCalledTimes(1);
		expect(deps._spies.upload).not.toHaveBeenCalled();
		expect(deps._spies.update).not.toHaveBeenCalled();
		expect(deps._spies.close).toHaveBeenCalledTimes(1);
		expect(result.titleSource).toBe("AI");
		// storyId is exposed so the caller can defer navigation until after
		// the full create → upload → updateStory pipeline resolves.
		expect(result.storyId).toBe("s1");
	});

	it("returns storyId from the created story for caller-driven navigation", async () => {
		// Regression: PR 1 Codex review found that Roadmap navigated inside
		// createStoryMutation.onSuccess (before uploads/update finished). The
		// fix moves navigation into the dialog's onSubmit chain, which needs
		// storyId on the orchestrator's return value.
		const deps = makeDeps({
			create: vi.fn().mockResolvedValue({
				story: { id: "story-xyz", titleSource: "AI" },
				aiGenerated: false,
			}),
		});
		const result = await submitCreateStoryWithAttachments({
			data: { projectId: "p1", description: "hi" } as never,
			files: [makeFile("a.png")],
			organizationId: null,
			deps,
		});
		expect(result.storyId).toBe("story-xyz");
	});

	it("preserves ordering: createStory → upload → updateStory → close", async () => {
		const order: string[] = [];
		const deps = makeDeps({
			create: vi.fn().mockImplementation(async () => {
				order.push("create");
				return {
					story: { id: "s1", titleSource: "AI" },
					aiGenerated: false,
				};
			}),
			upload: vi.fn().mockImplementation(async () => {
				order.push("upload");
				return "story-media/p1/s1/uuid.png";
			}),
			update: vi.fn().mockImplementation(async () => {
				order.push("update");
			}),
			close: vi.fn(() => order.push("close")),
		});

		await submitCreateStoryWithAttachments({
			data: { projectId: "p1", description: "hi" } as never,
			files: [makeFile("a.png")],
			organizationId: null,
			deps,
		});

		expect(order).toEqual(["create", "upload", "update", "close"]);
	});

	it("with partial upload failure: patches with successful subset and warns", async () => {
		const upload = vi
			.fn()
			.mockResolvedValueOnce("story-media/p1/s1/ok.png")
			.mockRejectedValueOnce(new Error("PUT 500"));
		const deps = makeDeps({ upload });

		await submitCreateStoryWithAttachments({
			data: { projectId: "p1", description: "hi" } as never,
			files: [makeFile("ok.png"), makeFile("broken.png")],
			organizationId: null,
			deps,
		});

		expect(deps._spies.update).toHaveBeenCalledTimes(1);
		const patched = deps._spies.update.mock.calls[0][0].description;
		expect(patched).toContain("![ok.png](story-media/p1/s1/ok.png)");
		expect(patched).not.toContain("broken.png");
		expect(deps._spies.toastWarning).toHaveBeenCalledWith(
			expect.stringMatching(/1 of 2 attachments uploaded/i),
		);
		expect(deps._spies.close).toHaveBeenCalledTimes(1);
	});

	it("with all uploads failing: error toast, no update, still closes", async () => {
		const deps = makeDeps({
			upload: vi.fn().mockRejectedValue(new Error("PUT 500")),
		});

		await submitCreateStoryWithAttachments({
			data: { projectId: "p1", description: "hi" } as never,
			files: [makeFile("a.png"), makeFile("b.png")],
			organizationId: null,
			deps,
		});

		expect(deps._spies.update).not.toHaveBeenCalled();
		expect(deps._spies.toastError).toHaveBeenCalledWith(
			expect.stringMatching(/2 attachment\(s\) failed/i),
		);
		expect(deps._spies.close).toHaveBeenCalledTimes(1);
	});

	it("with updateStory failing after successful uploads: error toast, closes anyway", async () => {
		const deps = makeDeps({
			update: vi.fn().mockRejectedValue(new Error("update 500")),
		});

		await submitCreateStoryWithAttachments({
			data: { projectId: "p1", description: "hi" } as never,
			files: [makeFile("a.png")],
			organizationId: null,
			deps,
		});

		expect(deps._spies.toastError).toHaveBeenCalledWith(
			expect.stringMatching(/couldn't be linked/i),
		);
		expect(deps._spies.close).toHaveBeenCalledTimes(1);
	});

	it("threads organizationId through every call", async () => {
		const deps = makeDeps();
		await submitCreateStoryWithAttachments({
			data: { projectId: "p1", description: "hi" } as never,
			files: [makeFile("a.png")],
			organizationId: "org-1",
			deps,
		});
		expect(deps._spies.create.mock.calls[0][0].organizationId).toBe(
			"org-1",
		);
		expect(deps._spies.upload.mock.calls[0][0].organizationId).toBe(
			"org-1",
		);
		expect(deps._spies.update.mock.calls[0][0].organizationId).toBe(
			"org-1",
		);
	});

	it("uploads doc attachments as rows after create and before close (ordering)", async () => {
		const order: string[] = [];
		const uploadAttachment = vi.fn(async () => {
			order.push("doc-upload");
			return { id: "att-1" };
		});
		const base = makeDeps({
			create: vi.fn(async () => {
				order.push("create");
				return {
					story: { id: "s1", titleSource: "AI" },
					aiGenerated: false,
				};
			}),
			close: vi.fn(() => order.push("close")),
		});
		await submitCreateStoryWithAttachments({
			data: { projectId: "p1", description: "hi" } as never,
			files: [],
			docAttachments: [
				{ file: makeFile("spec.docx"), designation: "UNLOCKED" },
			],
			organizationId: "org-1",
			deps: { ...base, uploadStoryAttachment: uploadAttachment },
		});
		expect(uploadAttachment).toHaveBeenCalledTimes(1);
		expect(uploadAttachment.mock.calls[0][0]).toMatchObject({
			projectId: "p1",
			userStoryId: "s1",
			organizationId: "org-1",
			designation: "UNLOCKED",
		});
		// Doc attachments never patch the description.
		expect(base._spies.update).not.toHaveBeenCalled();
		// close fires only after the doc upload settles.
		expect(order).toEqual(["create", "doc-upload", "close"]);
	});

	it("warns on partial doc-upload failure but still creates + closes", async () => {
		const uploadAttachment = vi
			.fn()
			.mockResolvedValueOnce({ id: "ok" })
			.mockRejectedValueOnce(new Error("PUT 500"));
		const base = makeDeps();
		await submitCreateStoryWithAttachments({
			data: { projectId: "p1", description: "hi" } as never,
			files: [],
			docAttachments: [
				{ file: makeFile("a.docx"), designation: "UNLOCKED" },
				{ file: makeFile("b.txt"), designation: "LOCKED" },
			],
			organizationId: null,
			deps: { ...base, uploadStoryAttachment: uploadAttachment },
		});
		expect(base._spies.toastWarning).toHaveBeenCalledWith(
			expect.stringMatching(/1 of 2 documents attached/i),
		);
		expect(base._spies.close).toHaveBeenCalledTimes(1);
	});

	it("is a no-op for docs when none are provided (image-only backward compat)", async () => {
		const uploadAttachment = vi.fn();
		const base = makeDeps();
		await submitCreateStoryWithAttachments({
			data: { projectId: "p1", description: "hi" } as never,
			files: [makeFile("a.png")],
			organizationId: null,
			deps: { ...base, uploadStoryAttachment: uploadAttachment },
		});
		expect(uploadAttachment).not.toHaveBeenCalled();
	});

	it("uploads BOTH docs (as rows) and images (patched into description) in one submit", async () => {
		const uploadAttachment = vi.fn().mockResolvedValue({ id: "att-1" });
		const base = makeDeps({ uploadAttachment });
		await submitCreateStoryWithAttachments({
			data: { projectId: "p1", description: "hi" } as never,
			files: [makeFile("shot.png")],
			docAttachments: [
				{ file: makeFile("spec.docx"), designation: "UNLOCKED" },
			],
			organizationId: null,
			deps: base,
		});
		// Doc uploaded as a StoryAttachment row.
		expect(uploadAttachment).toHaveBeenCalledTimes(1);
		// Image path still patches the description — with the image only.
		expect(base._spies.update).toHaveBeenCalledTimes(1);
		const patched = base._spies.update.mock.calls[0][0].description;
		expect(patched).toContain("story-media/p1/s1/uuid.png");
		expect(patched).not.toContain("spec.docx");
		expect(base._spies.close).toHaveBeenCalledTimes(1);
	});

	it("all doc uploads fail: warns 'failed to attach', feature still created + closes", async () => {
		const uploadAttachment = vi
			.fn()
			.mockRejectedValue(new Error("PUT 500"));
		const base = makeDeps({ uploadAttachment });
		await submitCreateStoryWithAttachments({
			data: { projectId: "p1", description: "hi" } as never,
			files: [],
			docAttachments: [
				{ file: makeFile("a.docx"), designation: "UNLOCKED" },
			],
			organizationId: null,
			deps: base,
		});
		expect(base._spies.toastWarning).toHaveBeenCalledWith(
			expect.stringMatching(/failed to attach/i),
		);
		expect(base._spies.close).toHaveBeenCalledTimes(1);
	});
});
