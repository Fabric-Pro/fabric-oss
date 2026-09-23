/**
 * Orchestrator chat images (Fizzy #2040, F35/F36).
 *
 * F35: the Orchestrator uploaded images only as storage paths, which never
 * reach a vision model — so the model said it could not see them. This turn's
 * images must also become chat documents whose ids ride the turn.
 *
 * F36: every later turn re-sent every earlier image. A turn now sends only its
 * own images, capped at the paste cap.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	latestGeneratedImagePath,
	ORCHESTRATOR_TURN_IMAGE_CAP,
	selectTurnImagePaths,
	uploadTurnImagesAsDocuments,
} from "../orchestrator/turn-images";

function image(name: string, type = "image/png") {
	return {
		name,
		file: new File([new Uint8Array([1, 2, 3])], name, { type }),
	};
}

function makeDocuments() {
	let next = 0;
	return {
		createUploadUrl: vi.fn(async () => ({
			documentId: `doc-${++next}`,
			signedUploadUrl: `https://upload.example.com/${next}`,
			useServerUpload: false,
			chatId: "chat-1",
		})),
		upload: vi.fn(async () => ({})),
		process: vi.fn(async () => ({ extractedContent: "a red square" })),
	};
}

describe("selectTurnImagePaths", () => {
	it("sends nothing on a turn without images, whatever came before", () => {
		// Turn 1 attached `turn-1.png`; turn 2 attaches nothing.
		const turn1 = selectTurnImagePaths(["uploads/turn-1.png"]);
		const turn2 = selectTurnImagePaths(undefined);

		expect(turn1).toEqual(["uploads/turn-1.png"]);
		expect(turn2).toBeUndefined();
	});

	it("sends only the current turn's images on a later turn", () => {
		expect(selectTurnImagePaths(["uploads/turn-2.png"])).toEqual([
			"uploads/turn-2.png",
		]);
	});

	it("de-duplicates and caps at the paste cap", () => {
		const paths = Array.from({ length: 8 }, (_, i) => `uploads/${i}.png`);
		const selected = selectTurnImagePaths([paths[0], ...paths]);

		expect(selected).toHaveLength(ORCHESTRATOR_TURN_IMAGE_CAP);
		expect(selected?.[0]).toBe("uploads/0.png");
		expect(new Set(selected).size).toBe(selected?.length);
	});
});

describe("latest generated image carry-forward", () => {
	const proxy = (path: string) =>
		`![Generated Image](/api/storage/image?path=${encodeURIComponent(path)})`;
	// Turn 1: the user uploads a photo and asks for a variation; the reply
	// carries two generated images. Turn 2 ("make it bluer") attaches nothing.
	const transcript = [
		{ role: "user", content: "make a poster from this" },
		{
			role: "assistant",
			content: `## Design 1\n${proxy("org-1/generated/old.png")}`,
		},
		{ role: "user", content: "another one" },
		{
			role: "assistant",
			content: `${proxy("org-1/generated/a.png")}\n\n${proxy("org-1/generated/b.png")}`,
		},
		{ role: "assistant", content: "Anything else?" },
	];

	it("turn 2 with no attachment carries exactly the last generated image and none of the uploads", () => {
		const turn1Uploads = ["org-1/uploads/photo.png"];
		expect(selectTurnImagePaths(turn1Uploads)).toEqual(turn1Uploads);

		const turn2 = selectTurnImagePaths(
			undefined,
			latestGeneratedImagePath(transcript),
		);

		expect(turn2).toEqual(["org-1/generated/b.png"]);
	});

	it("puts this turn's uploads first and still caps at the paste cap", () => {
		const uploads = Array.from({ length: 5 }, (_, i) => `uploads/${i}.png`);

		expect(
			selectTurnImagePaths(uploads.slice(0, 2), "generated/last.png"),
		).toEqual(["uploads/0.png", "uploads/1.png", "generated/last.png"]);
		expect(selectTurnImagePaths(uploads, "generated/last.png")).toEqual(
			uploads,
		);
	});

	it("finds nothing in a conversation without generated images", () => {
		expect(
			latestGeneratedImagePath([
				{ role: "user", content: "/api/storage/image?path=user.png" },
				{ role: "assistant", content: "no images here" },
			]),
		).toBeUndefined();
		expect(latestGeneratedImagePath([])).toBeUndefined();
	});
});

describe("uploadTurnImagesAsDocuments", () => {
	it("turns each current image into a chat document id with its real MIME type", async () => {
		const documents = makeDocuments();
		const fetchFn = vi.fn(async () => new Response(null, { status: 200 }));

		const result = await uploadTurnImagesAsDocuments({
			images: [image("a.png"), image("b.webp", "image/webp")],
			chatId: undefined,
			organizationId: "org-1",
			documents,
			fetchFn,
		});

		expect(result.documentIds).toEqual(["doc-1", "doc-2"]);
		expect(result.chatId).toBe("chat-1");
		expect(result.inlineContexts).toHaveLength(2);
		expect(documents.createUploadUrl).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				chatId: undefined,
				organizationId: "org-1",
				mimeType: "image/png",
			}),
		);
		// The second upload reuses the chat the first one created.
		expect(documents.createUploadUrl).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				chatId: "chat-1",
				mimeType: "image/webp",
			}),
		);
		expect(documents.process).toHaveBeenCalledTimes(2);
	});

	it("skips a failed upload, reports it, and keeps the rest", async () => {
		const documents = makeDocuments();
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(new Response(null, { status: 403 }))
			.mockResolvedValueOnce(new Response(null, { status: 200 }));
		const onUploadError = vi.fn();

		const result = await uploadTurnImagesAsDocuments({
			images: [image("broken.png"), image("ok.png")],
			chatId: "chat-0",
			organizationId: undefined,
			documents,
			fetchFn,
			onUploadError,
		});

		expect(result.documentIds).toEqual(["doc-2"]);
		expect(onUploadError).toHaveBeenCalledWith(
			"broken.png",
			expect.any(Error),
		);
	});

	it("keeps the image when only its text extraction fails", async () => {
		const documents = makeDocuments();
		documents.process.mockRejectedValueOnce(new Error("extractor down"));
		const fetchFn = vi.fn(async () => new Response(null, { status: 200 }));
		const onUploadError = vi.fn();

		const result = await uploadTurnImagesAsDocuments({
			images: [image("a.png")],
			chatId: "chat-1",
			organizationId: undefined,
			documents,
			fetchFn,
			onUploadError,
		});

		expect(result.documentIds).toEqual(["doc-1"]);
		expect(result.inlineContexts).toHaveLength(1);
		expect(onUploadError).not.toHaveBeenCalled();
	});

	it("uses the server upload when no signed URL is offered", async () => {
		const documents = makeDocuments();
		documents.createUploadUrl.mockResolvedValueOnce({
			documentId: "doc-srv",
			signedUploadUrl: "",
			useServerUpload: true,
			chatId: "chat-1",
		});
		const fetchFn = vi.fn();

		const result = await uploadTurnImagesAsDocuments({
			images: [image("a.png")],
			chatId: "chat-1",
			organizationId: undefined,
			documents,
			fetchFn,
		});

		expect(fetchFn).not.toHaveBeenCalled();
		expect(documents.upload).toHaveBeenCalledWith(
			expect.objectContaining({
				documentId: "doc-srv",
				mimeType: "image/png",
			}),
		);
		expect(result.documentIds).toEqual(["doc-srv"]);
	});

	it("never uploads more than the cap", async () => {
		const documents = makeDocuments();
		const fetchFn = vi.fn(async () => new Response(null, { status: 200 }));

		const result = await uploadTurnImagesAsDocuments({
			images: Array.from({ length: 7 }, (_, i) => image(`${i}.png`)),
			chatId: "chat-1",
			organizationId: undefined,
			documents,
			fetchFn,
		});

		expect(result.documentIds).toHaveLength(ORCHESTRATOR_TURN_IMAGE_CAP);
	});
});

describe("FabricTemporalOrchestratorChat send wiring", () => {
	// Read as source: the component is too heavy to mount for one payload.
	const source = readFileSync(
		join(__dirname, "../FabricTemporalOrchestratorChat.tsx"),
		"utf-8",
	);

	it("no longer collects earlier messages' images into the payload", () => {
		expect(source).not.toMatch(/m\.imageUrls/);
		expect(source).not.toMatch(/allImageUrls/);
	});

	it("sends the selected current-turn paths and the image document ids", () => {
		expect(source).toMatch(
			/const turnImageUrls = selectTurnImagePaths\(newlyAttachedImageUrls\)/,
		);
		// The generated edit target rides the workflow paths only — never the
		// vision documents (built from the composer's images) nor thumbnails.
		expect(source).toMatch(
			/isNewChat \? undefined : latestGeneratedImagePath\(messages\)/,
		);
		expect(source).toMatch(/images: turnImages,/);
		expect(source).toMatch(/\.\.\.imageDocuments\.documentIds/);
	});
});
