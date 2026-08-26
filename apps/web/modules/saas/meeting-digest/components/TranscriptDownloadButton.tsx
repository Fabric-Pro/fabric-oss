"use client";

/**
 * #1896 — client-side transcript download. The full transcript body is
 * already on the page (TranscriptPane fetched it), so this saves it as a .md
 * blob with no new endpoint.
 */
import { Button } from "@ui/components/button";
import { DownloadIcon } from "lucide-react";

export function transcriptFilename(
	subject: string | null,
	date: Date | string | null,
): string {
	const slug = (subject ?? "")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, "-")
		.replace(/^-+|-+$/g, "");
	const iso =
		date instanceof Date
			? date.toISOString()
			: typeof date === "string"
				? date
				: "";
	const day = iso.slice(0, 10);
	const base = [slug, day].filter(Boolean).join("-");
	return `${base || "meeting-transcript"}.md`;
}

export function TranscriptDownloadButton({
	content,
	filename,
}: {
	content: string;
	filename: string;
}) {
	const handleDownload = () => {
		const blob = new Blob([content], {
			type: "text/markdown;charset=utf-8",
		});
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = filename;
		a.click();
		URL.revokeObjectURL(url);
	};

	return (
		<Button
			type="button"
			variant="outline"
			size="sm"
			onClick={handleDownload}
			aria-label="Download transcript"
		>
			<DownloadIcon className="size-4" aria-hidden="true" />
			Download
		</Button>
	);
}
