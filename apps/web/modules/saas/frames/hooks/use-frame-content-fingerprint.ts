"use client";

import { useEffect, useState } from "react";
import { frameContentFingerprint } from "../lib/frame-content-fingerprint";

/**
 * The fingerprint of the page version on screen, or null while it is being
 * worked out, when there is no content to fingerprint, or where the browser
 * cannot hash. A version that has none is not given a remembered approval.
 */
export function useFrameContentFingerprint(
	blocks:
		| ReadonlyArray<{ id: string; type: string; content: string }>
		| undefined,
	runtimeTools: readonly string[],
): string | null {
	const toolsKey = runtimeTools.join("\n");
	const [fingerprint, setFingerprint] = useState<{
		blocks: typeof blocks;
		toolsKey: string;
		value: string | null;
	} | null>(null);

	useEffect(() => {
		let current = true;
		setFingerprint(null);
		if (!blocks) {
			return;
		}
		frameContentFingerprint({
			blocks,
			runtimeTools: toolsKey ? toolsKey.split("\n") : [],
		})
			.then((value) => {
				if (current) {
					setFingerprint({ blocks, toolsKey, value });
				}
			})
			.catch(() => {
				// No fingerprint: nothing is remembered, every write asks.
			});
		return () => {
			current = false;
		};
	}, [blocks, toolsKey]);

	return fingerprint &&
		fingerprint.blocks === blocks &&
		fingerprint.toolsKey === toolsKey
		? fingerprint.value
		: null;
}
