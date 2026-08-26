import { createHash } from "node:crypto";

export function stripHtml(value: string): string {
	return value
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(?:p|div|li|tr|h[1-6])>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ");
}

export function normalize(value: string | null | undefined): string {
	return stripHtml(value ?? "")
		.replace(/\r\n/g, "\n")
		.replace(/\s+$/gm, "")
		.trim();
}

export function computePmHash(
	title: string | null | undefined,
	description: string | null | undefined,
): string {
	const payload = `${normalize(title)}\n${normalize(description)}`;
	return createHash("sha256").update(payload, "utf8").digest("hex");
}
