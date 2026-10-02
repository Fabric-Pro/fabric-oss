import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createSignedMediaUrlRefresher,
	type SignedMediaUrlRefresher,
} from "../signed-media-url-refresher";
import { advancedExtensions } from "../tiptap-extensions-advanced";

/**
 * The editors store an image as the signed URL it got at upload time plus its
 * storage key. That URL lapses after an hour, so the refresher points every
 * `<img>` at a fresh one — on load, and again whenever an image is re-rendered
 * from the document, which brings the stored (expired) URL back (Fizzy #2800).
 */

const KEY_A = "document-media/p1/d1/a.png";
const KEY_B = "document-media/p1/d1/b.png";
const STALE_A = `https://bucket.example.com/${KEY_A}?sig=expired`;
const STALE_B = `https://bucket.example.com/${KEY_B}?sig=expired`;
const fresh = (key: string, n = 1) =>
	`https://bucket.example.com/${key}?sig=fresh-${n}`;

const keyFromImageSrc = (src: string) =>
	src.match(/\/(document-media\/[^?"]+)/)?.[1] ?? null;

const image = (src: string, key: string) =>
	`<img src="${src}" alt="x.png" data-s3-key="${key}">`;

let editor: Editor | null = null;
let refresher: SignedMediaUrlRefresher | null = null;

afterEach(() => {
	vi.useRealTimers();
	refresher?.destroy();
	editor?.destroy();
	refresher = null;
	editor = null;
});

function srcs(ed: Editor): string[] {
	return Array.from(
		ed.view.dom.querySelectorAll("img:not(.ProseMirror-separator)"),
	).map((img) => img.getAttribute("src") ?? "");
}

/** A resolver that signs every key it is asked for, counting the calls. */
function signingResolver() {
	let round = 0;
	return vi.fn(async (keys: string[]) => {
		round += 1;
		return Object.fromEntries(keys.map((key) => [key, fresh(key, round)]));
	});
}

function resizeFirstImage(ed: Editor): void {
	let pos = -1;
	ed.state.doc.descendants((node, at) => {
		if (pos === -1 && node.type.name === "image") {
			pos = at;
		}
	});
	const node = ed.state.doc.nodeAt(pos);
	ed.view.dispatch(
		ed.state.tr.setNodeMarkup(pos, undefined, {
			...node?.attrs,
			width: "100%",
		}),
	);
}

describe("signed media URL refresher", () => {
	it("points every image at a freshly signed URL in one request", async () => {
		editor = new Editor({
			extensions: advancedExtensions,
			content: `<p>${image(STALE_A, KEY_A)}${image(STALE_B, KEY_B)}</p>`,
		});
		const resolve = signingResolver();

		refresher = createSignedMediaUrlRefresher({
			editor,
			keyFromImageSrc,
			resolve,
		});

		await vi.waitFor(() =>
			expect(srcs(editor as Editor)).toEqual([
				fresh(KEY_A),
				fresh(KEY_B),
			]),
		);
		expect(resolve).toHaveBeenCalledTimes(1);
		expect(resolve.mock.calls[0]?.[0]).toEqual([KEY_A, KEY_B]);
	});

	it("does not touch the document, only the rendered image", async () => {
		editor = new Editor({
			extensions: advancedExtensions,
			content: `<p>${image(STALE_A, KEY_A)}</p>`,
		});
		const htmlBefore = editor.getHTML();

		refresher = createSignedMediaUrlRefresher({
			editor,
			keyFromImageSrc,
			resolve: signingResolver(),
		});

		await vi.waitFor(() =>
			expect(srcs(editor as Editor)).toEqual([fresh(KEY_A)]),
		);
		expect(editor.getHTML()).toBe(htmlBefore);
	});

	it("re-points an image re-rendered from the document without asking again", async () => {
		// Resizing or captioning an image rebuilds its <img> from the document,
		// which still holds the URL signed at upload time — long expired.
		editor = new Editor({
			extensions: advancedExtensions,
			content: `<p>${image(STALE_A, KEY_A)}</p>`,
		});
		const resolve = signingResolver();
		refresher = createSignedMediaUrlRefresher({
			editor,
			keyFromImageSrc,
			resolve,
		});
		await vi.waitFor(() =>
			expect(srcs(editor as Editor)).toEqual([fresh(KEY_A)]),
		);

		resizeFirstImage(editor);

		expect(srcs(editor)).toEqual([fresh(KEY_A)]);
		expect(resolve).toHaveBeenCalledTimes(1);
	});

	it("signs images that arrive after it started", async () => {
		editor = new Editor({
			extensions: advancedExtensions,
			content: "<p>Generating…</p>",
		});
		const resolve = signingResolver();
		refresher = createSignedMediaUrlRefresher({
			editor,
			keyFromImageSrc,
			resolve,
		});
		expect(resolve).not.toHaveBeenCalled();

		editor.commands.setContent(`<p>${image(STALE_A, KEY_A)}</p>`);

		await vi.waitFor(() =>
			expect(srcs(editor as Editor)).toEqual([fresh(KEY_A)]),
		);
	});

	it("waits for the editor view to mount", async () => {
		// `useEditor({ immediatelyRender: false })` hands out the editor before
		// <EditorContent> mounts it; touching `view.dom` then throws.
		editor = new Editor({
			element: null,
			extensions: advancedExtensions,
			content: `<p>${image(STALE_A, KEY_A)}</p>`,
		});
		const resolve = signingResolver();
		refresher = createSignedMediaUrlRefresher({
			editor,
			keyFromImageSrc,
			resolve,
		});
		expect(resolve).not.toHaveBeenCalled();

		editor.mount(document.createElement("div"));

		await vi.waitFor(() =>
			expect(srcs(editor as Editor)).toEqual([fresh(KEY_A)]),
		);
	});

	it("signs again once a remembered URL is close to expiring", async () => {
		let clock = 0;
		editor = new Editor({
			extensions: advancedExtensions,
			content: `<p>${image(STALE_A, KEY_A)}</p>`,
		});
		const resolve = signingResolver();
		refresher = createSignedMediaUrlRefresher({
			editor,
			keyFromImageSrc,
			resolve,
			now: () => clock,
		});
		await vi.waitFor(() =>
			expect(srcs(editor as Editor)).toEqual([fresh(KEY_A, 1)]),
		);

		clock += 55 * 60 * 1000;
		resizeFirstImage(editor);

		await vi.waitFor(() =>
			expect(srcs(editor as Editor)).toEqual([fresh(KEY_A, 2)]),
		);
		expect(resolve).toHaveBeenCalledTimes(2);
	});

	it("leaves images outside its keyspace alone", async () => {
		editor = new Editor({
			extensions: advancedExtensions,
			content: '<p><img src="https://example.com/logo.png"></p>',
		});
		const resolve = signingResolver();

		refresher = createSignedMediaUrlRefresher({
			editor,
			keyFromImageSrc,
			resolve,
		});

		expect(resolve).not.toHaveBeenCalled();
		expect(srcs(editor)).toEqual(["https://example.com/logo.png"]);
	});

	it("does not retry a failed request on every edit", async () => {
		let clock = 0;
		editor = new Editor({
			extensions: advancedExtensions,
			content: `<p>Intro</p><p>${image(STALE_A, KEY_A)}</p>`,
		});
		const resolve = vi.fn(async () => {
			throw new Error("network down");
		});
		const onError = vi.fn();
		refresher = createSignedMediaUrlRefresher({
			editor,
			keyFromImageSrc,
			resolve,
			onError,
			now: () => clock,
		});
		await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));

		editor.commands.insertContentAt(1, "typing ");
		editor.commands.insertContentAt(1, "more ");
		expect(resolve).toHaveBeenCalledTimes(1);

		clock += 2 * 60 * 1000;
		editor.commands.insertContentAt(1, "later ");
		await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(2));
	});

	it("uses a remembered upload URL instead of signing it again", () => {
		editor = new Editor({
			extensions: advancedExtensions,
			content: "<p>Intro</p>",
		});
		const resolve = signingResolver();
		refresher = createSignedMediaUrlRefresher({
			editor,
			keyFromImageSrc,
			resolve,
		});

		const uploaded = fresh(KEY_A, 0);
		refresher.remember(KEY_A, uploaded);
		editor.commands.insertContent(image(uploaded, KEY_A));

		expect(resolve).not.toHaveBeenCalled();
		expect(srcs(editor)).toEqual([uploaded]);
	});

	it("refreshes file links when asked to", async () => {
		editor = new Editor({
			extensions: advancedExtensions,
			content: `<p><a href="${STALE_A}" data-s3-key="${KEY_A}">a.png</a></p>`,
		});
		refresher = createSignedMediaUrlRefresher({
			editor,
			keyFromImageSrc,
			keyFromStoredKey: (key) => key,
			refreshLinks: true,
			resolve: signingResolver(),
		});

		await vi.waitFor(() =>
			expect(
				editor?.view.dom.querySelector("a")?.getAttribute("href"),
			).toBe(fresh(KEY_A)),
		);
	});

	it("retries a failed request on its own, without an edit", async () => {
		// Signing failed during load and the reader only reads: nothing else
		// will ever happen in the document to trigger a retry.
		vi.useFakeTimers();
		editor = new Editor({
			extensions: advancedExtensions,
			content: `<p>${image(STALE_A, KEY_A)}</p>`,
		});
		const resolve = vi
			.fn<(keys: string[]) => Promise<Record<string, string>>>()
			.mockRejectedValueOnce(new Error("network down"))
			.mockResolvedValue({ [KEY_A]: fresh(KEY_A) });
		refresher = createSignedMediaUrlRefresher({
			editor,
			keyFromImageSrc,
			resolve,
			onError: () => {},
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(resolve).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(60 * 1000);

		expect(resolve).toHaveBeenCalledTimes(2);
		expect(srcs(editor)).toEqual([fresh(KEY_A)]);
		vi.useRealTimers();
	});

	it("waits out the retry window after a renewal fails, instead of spinning", async () => {
		// The renewal at 50 minutes fails while the old entry is still cached.
		// Its deadline is already past, so scheduling off it re-armed a
		// zero-delay timer that rescanned the editor until the retry was due.
		vi.useFakeTimers();
		editor = new Editor({
			extensions: advancedExtensions,
			content: `<p>${image(STALE_A, KEY_A)}</p>`,
		});
		const resolve = vi
			.fn<(keys: string[]) => Promise<Record<string, string>>>()
			.mockResolvedValueOnce({ [KEY_A]: fresh(KEY_A, 1) })
			.mockRejectedValueOnce(new Error("storage down"))
			.mockResolvedValue({ [KEY_A]: fresh(KEY_A, 3) });
		refresher = createSignedMediaUrlRefresher({
			editor,
			keyFromImageSrc,
			resolve,
			onError: () => {},
		});
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(50 * 60 * 1000);
		expect(resolve).toHaveBeenCalledTimes(2);

		const scans = vi.spyOn(editor.view.dom, "querySelectorAll");
		await vi.advanceTimersByTimeAsync(30 * 1000);
		expect(scans).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(30 * 1000);
		expect(resolve).toHaveBeenCalledTimes(3);
		vi.useRealTimers();
	});

	it("signs more than 50 images in batches the resolvers accept", async () => {
		// Both resolvers refuse a request with more than 50 keys outright.
		const keys = Array.from(
			{ length: 55 },
			(_, i) => `document-media/p1/d1/${i}.png`,
		);
		editor = new Editor({
			extensions: advancedExtensions,
			content: `<p>${keys.map((key) => image(`https://bucket.example.com/${key}?sig=expired`, key)).join("")}</p>`,
		});
		const resolve = vi.fn(async (batch: string[]) => {
			if (batch.length > 50) {
				throw new Error("Cannot resolve more than 50 keys at once");
			}
			return Object.fromEntries(batch.map((key) => [key, fresh(key)]));
		});

		refresher = createSignedMediaUrlRefresher({
			editor,
			keyFromImageSrc,
			resolve,
		});

		await vi.waitFor(() =>
			expect(srcs(editor as Editor)).toEqual(
				keys.map((key) => fresh(key)),
			),
		);
		expect(resolve).toHaveBeenCalledTimes(2);
	});

	it("keeps the batches that succeeded when another fails", async () => {
		const keys = Array.from(
			{ length: 55 },
			(_, i) => `document-media/p1/d1/${i}.png`,
		);
		const stale = (key: string) =>
			`https://bucket.example.com/${key}?sig=expired`;
		editor = new Editor({
			extensions: advancedExtensions,
			content: `<p>${keys.map((key) => image(stale(key), key)).join("")}</p>`,
		});
		const resolve = vi.fn(async (batch: string[]) => {
			if (batch.includes(keys[0] as string)) {
				throw new Error("storage down");
			}
			return Object.fromEntries(batch.map((key) => [key, fresh(key)]));
		});
		const onError = vi.fn();

		refresher = createSignedMediaUrlRefresher({
			editor,
			keyFromImageSrc,
			resolve,
			onError,
		});

		await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
		expect(srcs(editor)).toEqual([
			...keys.slice(0, 50).map(stale),
			...keys.slice(50).map((key) => fresh(key)),
		]);
	});

	it("still re-points a rebuilt image while a renewal is failing", async () => {
		// The renewal at 50 minutes fails, but the URL signed at 0 is good for
		// an hour: an image rebuilt at 52 minutes must get it, not the
		// document's long-expired stored URL.
		vi.useFakeTimers();
		editor = new Editor({
			extensions: advancedExtensions,
			content: `<p>${image(STALE_A, KEY_A)}</p>`,
		});
		const resolve = vi
			.fn<(keys: string[]) => Promise<Record<string, string>>>()
			.mockResolvedValueOnce({ [KEY_A]: fresh(KEY_A, 1) })
			.mockRejectedValue(new Error("storage down"));
		refresher = createSignedMediaUrlRefresher({
			editor,
			keyFromImageSrc,
			resolve,
			onError: () => {},
		});
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(50 * 60 * 1000);
		expect(resolve).toHaveBeenCalledTimes(2);

		await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
		resizeFirstImage(editor);

		expect(srcs(editor)).toEqual([fresh(KEY_A, 1)]);
		vi.useRealTimers();
	});

	it("signs an image by its data-s3-key when its src carries none", async () => {
		// The story fetch leaves a reference untouched when signing fails, so
		// an image can hold its key only in `data-s3-key`.
		editor = new Editor({
			extensions: advancedExtensions,
			content: `<p><img src="https://pm.example.com/attachments/42" alt="x.png" data-s3-key="${KEY_A}"></p>`,
		});
		refresher = createSignedMediaUrlRefresher({
			editor,
			keyFromImageSrc,
			keyFromStoredKey: (key) =>
				key.startsWith("document-media/") ? key : null,
			resolve: signingResolver(),
		});

		await vi.waitFor(() =>
			expect(srcs(editor as Editor)).toEqual([fresh(KEY_A)]),
		);
	});

	it("ignores a data-s3-key it is not allowed to sign", () => {
		editor = new Editor({
			extensions: advancedExtensions,
			content: `<p><img src="https://pm.example.com/attachments/42" alt="x.png" data-s3-key="${KEY_A}"></p>`,
		});
		const resolve = signingResolver();
		refresher = createSignedMediaUrlRefresher({
			editor,
			keyFromImageSrc,
			keyFromStoredKey: () => null,
			resolve,
		});

		expect(resolve).not.toHaveBeenCalled();
	});

	it("applies each batch as it lands, while another request hangs", async () => {
		const keys = Array.from(
			{ length: 55 },
			(_, i) => `document-media/p1/d1/${i}.png`,
		);
		editor = new Editor({
			extensions: advancedExtensions,
			content: `<p>${keys.map((key) => image(`https://bucket.example.com/${key}?sig=expired`, key)).join("")}</p>`,
		});
		const resolve = vi.fn((batch: string[]) =>
			batch.includes(keys[0] as string)
				? new Promise<Record<string, string>>(() => {})
				: Promise.resolve(
						Object.fromEntries(
							batch.map((key) => [key, fresh(key)]),
						),
					),
		);
		refresher = createSignedMediaUrlRefresher({
			editor,
			keyFromImageSrc,
			resolve,
		});

		await vi.waitFor(() =>
			expect(srcs(editor as Editor).slice(50)).toEqual(
				keys.slice(50).map((key) => fresh(key)),
			),
		);
	});

	it("keeps signing new images while an earlier request hangs", async () => {
		editor = new Editor({
			extensions: advancedExtensions,
			content: `<p>${image(STALE_A, KEY_A)}</p>`,
		});
		const resolve = vi.fn((batch: string[]) =>
			batch.includes(KEY_A)
				? new Promise<Record<string, string>>(() => {})
				: Promise.resolve(
						Object.fromEntries(
							batch.map((key) => [key, fresh(key)]),
						),
					),
		);
		refresher = createSignedMediaUrlRefresher({
			editor,
			keyFromImageSrc,
			resolve,
		});
		expect(resolve).toHaveBeenCalledTimes(1);

		editor.commands.insertContentAt(
			editor.state.doc.content.size,
			`<p>${image(STALE_B, KEY_B)}</p>`,
		);

		await vi.waitFor(() =>
			expect(srcs(editor as Editor)).toEqual([STALE_A, fresh(KEY_B)]),
		);
	});

	it("reports a resolver that throws synchronously, and keeps working", async () => {
		editor = new Editor({
			extensions: advancedExtensions,
			content: `<p>${image(STALE_A, KEY_A)}</p>`,
		});
		const onError = vi.fn();
		refresher = createSignedMediaUrlRefresher({
			editor,
			keyFromImageSrc,
			resolve: () => {
				throw new Error("misconfigured");
			},
			onError,
		});

		await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
		editor.commands.insertContentAt(
			editor.state.doc.content.size,
			`<p>${image(STALE_B, KEY_B)}</p>`,
		);
		await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
	});

	it("gives up on a request that never answers, and retries it", async () => {
		vi.useFakeTimers();
		editor = new Editor({
			extensions: advancedExtensions,
			content: `<p>${image(STALE_A, KEY_A)}</p>`,
		});
		const resolve = vi
			.fn<(keys: string[]) => Promise<Record<string, string>>>()
			.mockReturnValueOnce(new Promise(() => {}))
			.mockResolvedValue({ [KEY_A]: fresh(KEY_A) });
		const onError = vi.fn();
		refresher = createSignedMediaUrlRefresher({
			editor,
			keyFromImageSrc,
			resolve,
			onError,
		});

		await vi.advanceTimersByTimeAsync(30 * 1000);
		expect(onError).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(60 * 1000);
		expect(resolve).toHaveBeenCalledTimes(2);
		expect(srcs(editor)).toEqual([fresh(KEY_A)]);
		vi.useRealTimers();
	});

	it("re-signs a file link before its URL expires while the editor sits idle", async () => {
		// Story file links open their `href` on click — an hour-old one is dead.
		vi.useFakeTimers();
		editor = new Editor({
			extensions: advancedExtensions,
			content: `<p><a href="${STALE_A}" data-s3-key="${KEY_A}">a.png</a></p>`,
		});
		const resolve = signingResolver();
		refresher = createSignedMediaUrlRefresher({
			editor,
			keyFromImageSrc,
			keyFromStoredKey: (key) => key,
			refreshLinks: true,
			resolve,
		});
		await vi.advanceTimersByTimeAsync(0);
		const href = () =>
			editor?.view.dom.querySelector("a")?.getAttribute("href");
		expect(href()).toBe(fresh(KEY_A, 1));

		await vi.advanceTimersByTimeAsync(50 * 60 * 1000);

		expect(href()).toBe(fresh(KEY_A, 2));
		vi.useRealTimers();
	});

	it("does not re-download an image that is already showing", async () => {
		vi.useFakeTimers();
		editor = new Editor({
			extensions: advancedExtensions,
			content: `<p>${image(STALE_A, KEY_A)}</p>`,
		});
		const resolve = signingResolver();
		refresher = createSignedMediaUrlRefresher({
			editor,
			keyFromImageSrc,
			resolve,
		});
		await vi.advanceTimersByTimeAsync(0);
		const img = editor.view.dom.querySelector(
			"img:not(.ProseMirror-separator)",
		) as HTMLImageElement;
		Object.defineProperty(img, "complete", { value: true });
		Object.defineProperty(img, "naturalWidth", { value: 640 });

		await vi.advanceTimersByTimeAsync(50 * 60 * 1000);

		// Signed again (so a rebuilt image is re-pointed instantly)…
		expect(resolve).toHaveBeenCalledTimes(2);
		// …but the picture on screen keeps the URL it loaded from.
		expect(img.getAttribute("src")).toBe(fresh(KEY_A, 1));
		vi.useRealTimers();
	});

	it("stops its timer once destroyed", async () => {
		vi.useFakeTimers();
		editor = new Editor({
			extensions: advancedExtensions,
			content: `<p>${image(STALE_A, KEY_A)}</p>`,
		});
		const resolve = signingResolver();
		refresher = createSignedMediaUrlRefresher({
			editor,
			keyFromImageSrc,
			resolve,
		});
		await vi.advanceTimersByTimeAsync(0);

		refresher.destroy();
		await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);

		expect(resolve).toHaveBeenCalledTimes(1);
		vi.useRealTimers();
	});

	it("stops reacting once destroyed", async () => {
		editor = new Editor({
			extensions: advancedExtensions,
			content: "<p>Intro</p>",
		});
		const resolve = signingResolver();
		refresher = createSignedMediaUrlRefresher({
			editor,
			keyFromImageSrc,
			resolve,
		});

		refresher.destroy();
		editor.commands.setContent(`<p>${image(STALE_A, KEY_A)}</p>`);

		expect(resolve).not.toHaveBeenCalled();
		expect(srcs(editor)).toEqual([STALE_A]);
	});
});
