import { describe, expect, it, vi } from "vitest";
import { submitCreateStoryEnrichment } from "../submit-create-story-enrichment";

function makeFile(name: string): File {
	return new File([new Uint8Array(8)], name, { type: "image/png" });
}

function makeDeps(
	overrides?: Partial<{
		uploadImage: ReturnType<typeof vi.fn>;
		uploadAttachment: ReturnType<typeof vi.fn>;
		update: ReturnType<typeof vi.fn>;
		toastSuccess: ReturnType<typeof vi.fn>;
		toastError: ReturnType<typeof vi.fn>;
		toastWarning: ReturnType<typeof vi.fn>;
	}>,
) {
	const uploadImage =
		overrides?.uploadImage ??
		vi.fn().mockResolvedValue("story-media/p1/target-1/uuid.png");
	const uploadAttachment =
		overrides?.uploadAttachment ??
		vi.fn().mockResolvedValue({ id: "att-1" });
	const update = overrides?.update ?? vi.fn().mockResolvedValue(undefined);
	const toastSuccess = overrides?.toastSuccess ?? vi.fn();
	const toastError = overrides?.toastError ?? vi.fn();
	const toastWarning = overrides?.toastWarning ?? vi.fn();
	return {
		uploadStoryImage: uploadImage,
		uploadStoryAttachment: uploadAttachment,
		updateStoryMutateAsync: update,
		toast: {
			success: toastSuccess,
			error: toastError,
			warning: toastWarning,
		},
		_spies: {
			uploadImage,
			uploadAttachment,
			update,
			toastSuccess,
			toastError,
			toastWarning,
		},
	};
}

const BASE_ARGS = {
	projectId: "p1",
	targetStoryId: "target-1",
	targetIdentifier: "F-12",
	mergedDescription: "Exports need a queue.\n\nAlso rate limit the endpoint.",
	mergedAcceptanceCriteria: "GIVEN a large export THEN it is queued.",
	organizationId: null,
};

describe("submitCreateStoryEnrichment", () => {
	it("with no files and no docs: writes the merge and succeeds", async () => {
		const deps = makeDeps();

		const result = await submitCreateStoryEnrichment({
			...BASE_ARGS,
			acceptanceCriteriaChanged: false,
			files: [],
			deps,
		});

		expect(deps._spies.uploadImage).not.toHaveBeenCalled();
		expect(deps._spies.uploadAttachment).not.toHaveBeenCalled();
		expect(deps._spies.update).toHaveBeenCalledTimes(1);
		expect(deps._spies.update).toHaveBeenCalledWith({
			projectId: "p1",
			storyId: "target-1",
			organizationId: null,
			description: BASE_ARGS.mergedDescription,
		});
		expect(deps._spies.toastSuccess).toHaveBeenCalledOnce();
		expect(result.storyId).toBe("target-1");
	});

	it("includes acceptanceCriteria in the write only when it changed", async () => {
		const deps = makeDeps();

		await submitCreateStoryEnrichment({
			...BASE_ARGS,
			acceptanceCriteriaChanged: true,
			files: [],
			deps,
		});

		expect(deps._spies.update).toHaveBeenCalledWith(
			expect.objectContaining({
				acceptanceCriteria: BASE_ARGS.mergedAcceptanceCriteria,
			}),
		);
	});

	it("uploads images to the TARGET ticket and folds them into the merged description before the single write", async () => {
		const deps = makeDeps();
		const file = makeFile("diagram.png");

		await submitCreateStoryEnrichment({
			...BASE_ARGS,
			acceptanceCriteriaChanged: false,
			files: [file],
			deps,
		});

		expect(deps._spies.uploadImage).toHaveBeenCalledWith(
			expect.objectContaining({
				file,
				projectId: "p1",
				userStoryId: "target-1",
				organizationId: null,
			}),
		);
		const writeCall = deps._spies.update.mock.calls[0][0] as {
			description: string;
		};
		expect(writeCall.description).toContain("## Attachments");
		expect(writeCall.description).toContain(
			"story-media/p1/target-1/uuid.png",
		);
	});

	it("uploads doc attachments to the TARGET ticket, independent of the image path", async () => {
		const deps = makeDeps();
		const doc = {
			file: makeFile("spec.docx"),
			designation: "LOCKED" as const,
		};

		await submitCreateStoryEnrichment({
			...BASE_ARGS,
			acceptanceCriteriaChanged: false,
			files: [],
			docAttachments: [doc],
			deps,
		});

		expect(deps._spies.uploadAttachment).toHaveBeenCalledWith(
			expect.objectContaining({
				file: doc.file,
				userStoryId: "target-1",
				designation: "LOCKED",
			}),
		);
		expect(deps._spies.update).toHaveBeenCalledTimes(1);
	});

	it("partial image upload failure: warns and still writes the merge with the successful subset", async () => {
		const uploadImage = vi
			.fn()
			.mockResolvedValueOnce("story-media/p1/target-1/ok.png")
			.mockRejectedValueOnce(new Error("network error"));
		const deps = makeDeps({ uploadImage });

		const result = await submitCreateStoryEnrichment({
			...BASE_ARGS,
			acceptanceCriteriaChanged: false,
			files: [makeFile("a.png"), makeFile("b.png")],
			deps,
		});

		expect(deps._spies.toastWarning).toHaveBeenCalledOnce();
		expect(deps._spies.update).toHaveBeenCalledTimes(1);
		const writeCall = deps._spies.update.mock.calls[0][0] as {
			description: string;
		};
		expect(writeCall.description).toContain("ok.png");
		expect(result.storyId).toBe("target-1");
	});

	it("total doc-attachment failure: warns but the merge still writes", async () => {
		const uploadAttachment = vi
			.fn()
			.mockRejectedValue(new Error("upload failed"));
		const deps = makeDeps({ uploadAttachment });

		await submitCreateStoryEnrichment({
			...BASE_ARGS,
			acceptanceCriteriaChanged: false,
			files: [],
			docAttachments: [
				{ file: makeFile("spec.docx"), designation: "LOCKED" },
			],
			deps,
		});

		expect(deps._spies.toastWarning).toHaveBeenCalledOnce();
		expect(deps._spies.update).toHaveBeenCalledTimes(1);
	});

	it("update failure: propagates and never fires the success toast (nothing was written)", async () => {
		const update = vi.fn().mockRejectedValue(new Error("write conflict"));
		const deps = makeDeps({ update });

		await expect(
			submitCreateStoryEnrichment({
				...BASE_ARGS,
				acceptanceCriteriaChanged: false,
				files: [],
				deps,
			}),
		).rejects.toThrow("write conflict");
		expect(deps._spies.toastSuccess).not.toHaveBeenCalled();
	});
});
