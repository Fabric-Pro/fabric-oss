import type { FrameRecord } from "@repo/database";
import type { FrameSourceWindow } from "./frame-args";

export const FRAME_SOURCE_RESULT_MAX_CHARS = 10_000;

function splitsCodePoint(content: string, offset: number): boolean {
	const before = content.charCodeAt(offset - 1);
	const after = content.charCodeAt(offset);
	return (
		before >= 0xd800 &&
		before <= 0xdbff &&
		after >= 0xdc00 &&
		after <= 0xdfff
	);
}

/** One authorized block's source, bounded after JSON escaping and metadata. */
export function readFrameSource(
	frame: Pick<FrameRecord, "id" | "title" | "updatedAt" | "document">,
	window: FrameSourceWindow,
) {
	const block =
		window.blockId === undefined
			? frame.document.blocks[0]
			: frame.document.blocks.find(
					(candidate) => candidate.id === window.blockId,
				);
	if (!block) {
		return {
			error: "Saved block not found. Read the frame's block ids before retrying.",
		};
	}
	if (window.offset > block.content.length) {
		return { error: "`offset` is past the end of this saved block." };
	}
	if (splitsCodePoint(block.content, window.offset)) {
		return {
			error: "`offset` splits a Unicode character. Use the previous nextOffset.",
		};
	}
	const resultFor = (length: number) => {
		const end = window.offset + length;
		const complete = end === block.content.length;
		return {
			source: true as const,
			frameId: frame.id,
			title: frame.title,
			updatedAt: frame.updatedAt.toISOString(),
			block: {
				id: block.id,
				type: block.type,
				content: block.content.slice(window.offset, end),
			},
			offset: window.offset,
			returnedLength: length,
			totalChars: block.content.length,
			complete,
			...(complete ? {} : { nextOffset: end }),
		};
	};
	const fits = (length: number) =>
		JSON.stringify(resultFor(length), null, 2).length <=
		FRAME_SOURCE_RESULT_MAX_CHARS;
	if (!fits(0)) {
		return {
			error: "Saved frame metadata exceeds the source-read size limit.",
		};
	}
	let low = 0;
	let high = Math.min(window.limit, block.content.length - window.offset);
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (fits(middle)) {
			low = middle;
		} else {
			high = middle - 1;
		}
	}
	if (splitsCodePoint(block.content, window.offset + low)) {
		low -= 1;
	}
	if (low === 0 && window.offset < block.content.length) {
		return {
			error: "This source window cannot fit a complete character. Increase `limit` or shorten the saved frame metadata.",
		};
	}
	return resultFor(low);
}
