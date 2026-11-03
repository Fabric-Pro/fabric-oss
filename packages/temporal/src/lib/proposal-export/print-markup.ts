/**
 * The small pieces the Proposal's print page writes with (Fizzy #2946):
 * escaping, the `data:` URL of a raster, a node's plain text, which tables
 * and lists take the id-column and steps classes, a `<style>` element and
 * the running footer's title. The cover and the body each
 * import them from here, so neither depends on the other.
 */

import type { List, Nodes, Paragraph, PhrasingContent, Table } from "mdast";
import { readUploadedImageTag } from "./document-content";
import { exportFailure } from "./failures";
import { eachNode, flatText } from "./markdown";
import type { ExportRaster } from "./types";

const ESCAPES: Readonly<Record<string, string>> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};

/** Text or an attribute value, safe in either place. */
export function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? "");
}

/** A trimmed, non-empty value, or null. */
export function present(value: string | null | undefined): string | null {
	const trimmed = value?.trim() ?? "";
	return trimmed === "" ? null : trimmed;
}

/** Whether a raster is PNG or JPEG: anything else is never written. */
export function isEmbeddable(raster: ExportRaster): boolean {
	return raster.mimeType === "image/png" || raster.mimeType === "image/jpeg";
}

/** Each raster's data URL, encoded once however often it is placed. */
const dataUrls = new WeakMap<ExportRaster, string>();

/** A raster as a `data:` URL, or null when it is not embeddable. */
export function dataUrl(raster: ExportRaster): string | null {
	if (!isEmbeddable(raster)) {
		return null;
	}
	let url = dataUrls.get(raster);
	if (url === undefined) {
		url = `data:${raster.mimeType};base64,${raster.bytes.toString("base64")}`;
		dataUrls.set(raster, url);
	}
	return url;
}

/** A node's text with all markup dropped, whitespace collapsed. */
export function plainText(node: Nodes): string {
	return flatText(node).replace(/\s+/g, " ").trim();
}

/** A paragraph holding an image (a figure in the body, never a lead). */
export function isImageParagraph(node: Paragraph): boolean {
	let image = false;
	eachNode(node, (child) => {
		if (
			child.type === "image" ||
			child.type === "imageReference" ||
			(child.type === "html" && readUploadedImageTag(child.value))
		) {
			image = true;
		}
	});
	return image;
}

/** The children that are more than whitespace. */
export function meaningfulChildren(
	children: readonly PhrasingContent[],
): PhrasingContent[] {
	return children.filter(
		(child) => !(child.type === "text" && child.value.trim() === ""),
	);
}

/**
 * A first-column cell that reads as an id, such as "FS-01": short, one word
 * and with a digit, so a column of plain words ("Discovery", "Pro") is not.
 */
const SHORT_ID = /^(?=[\p{L}\p{N}-]*\p{N})[\p{L}\p{N}-]{1,12}$/u;

/** Whether every body cell of the first column reads as a short id. */
export function hasIdColumn(node: Table): boolean {
	const rows = node.children.slice(1);
	return (
		rows.length > 0 &&
		rows.every((row) => {
			const cell = row.children[0];
			return cell !== undefined && SHORT_ID.test(plainText(cell));
		})
	);
}

/** Whether every item of an ordered list opens with bold text. */
export function isStepList(node: List): boolean {
	return (
		node.ordered === true &&
		node.children.length > 0 &&
		node.children.every((item) => {
			const first = item.children[0];
			return (
				first?.type === "paragraph" &&
				meaningfulChildren(first.children)[0]?.type === "strong"
			);
		})
	);
}

/** Longest document title the footer shows, in characters. */
const FOOTER_TITLE_LIMIT = 60;

/**
 * The title as the footer shows it: cut at a word to
 * {@link FOOTER_TITLE_LIMIT} characters with an ellipsis, so the footer
 * stays on one line beside the page counter.
 */
export function footerTitle(title: string): string {
	const characters = Array.from(title);
	if (characters.length <= FOOTER_TITLE_LIMIT) {
		return title;
	}
	const cut = characters.slice(0, FOOTER_TITLE_LIMIT - 1).join("");
	const atWord = cut.replace(/\s+\S*$/u, "");
	return `${(atWord.length > 0 ? atWord : cut).trimEnd()}…`;
}

/** A stylesheet for a `<style>` element, which nothing in it may close. */
export function styleElement(css: string): string {
	if (/<\/style/i.test(css)) {
		throw exportFailure("EXPORT_FAILED");
	}
	return `<style>${css}</style>`;
}
