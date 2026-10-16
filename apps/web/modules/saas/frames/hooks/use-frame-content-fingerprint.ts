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
	const [fingerprint, setFingerprint] = useState<string | null>(null);
	const toolsKey = runtimeTools.join("\n");

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
					setFingerprint(value);
				}
			})
			.catch(() => {
				// No fingerprint: nothing is remembered, every write asks.
			});
		return () => {
			current = false;
		};
	}, [blocks, toolsKey]);

	return fingerprint;
}
