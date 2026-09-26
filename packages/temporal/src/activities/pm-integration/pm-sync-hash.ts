import { createHash } from "node:crypto";

/**
 * Every normalisation below feeds a stored change-detection digest, so each
 * must return exactly what it always has: a different string for the same
 * PM content would read as drift on every synced item. The two rewrites
 * here are linear-time forms of the patterns in their comments, which were
 * quadratic on a long run of `<` with no `>` after it, or of whitespace
 * that does not end a line (CodeQL js/polynomial-redos). Both take PM
 * payloads, which a third party authors.
 */
export function stripHtml(value: string): string {
	return removeTags(
		value
			.replace(/<br\s*\/?>/gi, "\n")
			.replace(/<\/(?:p|div|li|tr|h[1-6])>/gi, "\n"),
	)
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ");
}

/**
 * `value.replace(/<[^>]+>/g, "")`, scanned by hand: that pattern rescanned to
 * the end of the text from every `<` once no `>` followed. A `<` with no `>`
 * after it means no later `<` has one either, so the scan stops there; `<>`
 * holds no tag and is kept, as before.
 */
function removeTags(value: string): string {
	let out = "";
	let kept = 0;
	let from = 0;
	for (;;) {
		const open = value.indexOf("<", from);
		if (open === -1) {
			break;
		}
		const close = value.indexOf(">", open + 1);
		if (close === -1) {
			break;
		}
		if (close === open + 1) {
			from = close;
			continue;
		}
		out += value.slice(kept, open);
		kept = close + 1;
		from = kept;
	}
	return out + value.slice(kept);
}

export function normalize(value: string | null | undefined): string {
	return (
		stripHtml(value ?? "")
			.replace(/\r\n/g, "\n")
			// `/\s+$/gm`, matched only from the start of a whitespace run. A
			// match can only ever begin there (from anywhere later in the run
			// it ends at the same line break or not at all), so the output is
			// unchanged; the run is no longer rescanned from each position.
			.replace(/(?<!\s)\s+$/gm, "")
			.trim()
	);
}

export function computePmHash(
	title: string | null | undefined,
	description: string | null | undefined,
): string {
	const payload = `${normalize(title)}\n${normalize(description)}`;
	return createHash("sha256").update(payload, "utf8").digest("hex");
}
