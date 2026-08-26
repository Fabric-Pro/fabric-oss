/**
 * Replace images that fail to load with a readable inline message.
 *
 * An `<img>` whose `src` never resolves — an expired story-media signed URL, a
 * storage blip, or a legacy description still carrying an external PM-tool
 * attachment URL the browser cannot authenticate — otherwise paints the
 * browser's native broken-image icon: no message, no filename, nothing the
 * reader can act on (Fizzy card 2027).
 *
 * The pull-side ingester (`@repo/integrations/pm/pull-image-ingest`) keeps
 * unreachable URLs out of stored descriptions in the first place. This is the
 * render-time backstop for everything it cannot cover.
 *
 * The message is a WIDGET DECORATION, never a node spliced into the editable
 * DOM. An earlier version inserted a real `<span>` next to the broken `<img>`;
 * ProseMirror's DOM observer read that back as document content, so the text
 * was saved into the body and accumulated on every open/save cycle — and would
 * have been pushed to the PM tool in place of the real attachment. Decorations
 * live outside the document, so they cannot be serialised into a save.
 *
 * Which images are broken is runtime state, not document state, so it is kept
 * in plugin state keyed by `src` and fed by `error`/`load` listeners. `error`
 * does not bubble, so they are registered in the CAPTURE phase on the editor
 * root — one pair of listeners covers every current and future image.
 */

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { buildMediaUnavailableMessage } from "./media-unavailable-message";

/** Marker attribute on the rendered message (also the test hook). */
const FALLBACK_ATTR = "data-image-load-error";

/** Marker class on the image node whose picture could not be shown. */
const FAILED_CLASS = "image-load-failed";

/** Longest filename we will spell out before truncating. */
const MAX_NAME_LENGTH = 60;

const pluginKey = new PluginKey<Set<string>>("imageLoadFallback");

/**
 * Best-effort display name for a broken image: alt text, else the filename.
 *
 * Azure DevOps attachment URLs carry a bare GUID in the path and the real
 * filename in a `fileName` query parameter, so the query is consulted before
 * the path segment. `data:` and `blob:` sources have no meaningful filename —
 * the "path segment" of a data URI is the entire base64 payload — so they fall
 * back to an unnamed message rather than dumping kilobytes into the editor.
 */
function describeImage(src: string, alt?: string | null): string {
	const trimmedAlt = alt?.trim();
	if (trimmedAlt) {
		return trimmedAlt.slice(0, MAX_NAME_LENGTH);
	}
	if (!src || /^(?:data|blob):/i.test(src)) {
		return "";
	}
	const [path, query] = src.split(/[?#]/);
	const fromQuery = new URLSearchParams(query ?? "").get("fileName");
	const segment = fromQuery || path.split("/").pop() || "";
	let name: string;
	try {
		name = decodeURIComponent(segment);
	} catch {
		name = segment;
	}
	return name.slice(0, MAX_NAME_LENGTH);
}

function fallbackMessage(name: string): string {
	return name ? `Image unavailable: ${name}` : "Image unavailable";
}

function buildDecorations(
	doc: import("@tiptap/pm/model").Node,
	failed: Set<string>,
): DecorationSet {
	if (failed.size === 0) {
		return DecorationSet.empty;
	}
	const decorations: Decoration[] = [];
	doc.descendants((node, pos) => {
		if (node.type.name !== "image") {
			return;
		}
		const src = typeof node.attrs.src === "string" ? node.attrs.src : "";
		if (!failed.has(src)) {
			return;
		}
		// Hides the picture itself; the message stands in for it.
		decorations.push(
			Decoration.node(pos, pos + node.nodeSize, { class: FAILED_CLASS }),
		);
		decorations.push(
			Decoration.widget(
				pos + node.nodeSize,
				() => {
					// Shared with the failed-import placeholder so the two
					// read as one state — see media-unavailable-message.ts.
					const element = buildMediaUnavailableMessage(
						fallbackMessage(
							describeImage(src, node.attrs.alt as string | null),
						),
					);
					element.setAttribute(FALLBACK_ATTR, "true");
					return element;
				},
				{ side: 1 },
			),
		);
	});
	return DecorationSet.create(doc, decorations);
}

export const ImageLoadFallback = Extension.create({
	name: "imageLoadFallback",

	addProseMirrorPlugins() {
		return [
			new Plugin<Set<string>>({
				key: pluginKey,

				state: {
					init: () => new Set<string>(),
					apply(tr, failed) {
						const meta = tr.getMeta(pluginKey) as
							| { src: string; broken: boolean }
							| undefined;
						if (!meta) {
							return failed;
						}
						const next = new Set(failed);
						if (meta.broken) {
							next.add(meta.src);
						} else {
							next.delete(meta.src);
						}
						return next;
					},
				},

				props: {
					decorations(state) {
						return buildDecorations(
							state.doc,
							pluginKey.getState(state) ?? new Set(),
						);
					},
				},

				view(view) {
					const record = (event: Event, broken: boolean) => {
						const img = event.target;
						if (!(img instanceof HTMLImageElement)) {
							return;
						}
						// ProseMirror emits <img class="ProseMirror-separator">
						// beside inline leaf nodes. It carries no `src`, so it
						// reports the same complete/naturalWidth state a broken
						// image does — but it is editor scaffolding, not content.
						if (img.classList.contains("ProseMirror-separator")) {
							return;
						}
						const src = img.getAttribute("src");
						if (!src) {
							return;
						}
						const failed =
							pluginKey.getState(view.state) ?? new Set<string>();
						if (failed.has(src) === broken) {
							return;
						}
						view.dispatch(
							view.state.tr.setMeta(pluginKey, { src, broken }),
						);
					};

					const onError = (event: Event) => record(event, true);
					const onLoad = (event: Event) => record(event, false);

					view.dom.addEventListener("error", onError, true);
					view.dom.addEventListener("load", onLoad, true);

					// Images that failed BEFORE the listeners attached never fire
					// `error` again — a cached failure resolves before this runs.
					// A decoded image reports a non-zero `naturalWidth`.
					for (const img of view.dom.querySelectorAll("img")) {
						if (img.complete && img.naturalWidth === 0) {
							record({ target: img } as unknown as Event, true);
						}
					}

					return {
						destroy() {
							view.dom.removeEventListener(
								"error",
								onError,
								true,
							);
							view.dom.removeEventListener("load", onLoad, true);
						},
					};
				},
			}),
		];
	},
});
