"use client";

import { memo, type ReactNode } from "react";

interface MemoizedRowProps {
	/**
	 * Everything the row reads that can change: its own message plus each
	 * piece of shared state it renders. The row renders again only when one
	 * of these changes (compared with `Object.is`).
	 */
	deps: readonly unknown[];
	render: () => ReactNode;
}

function sameDeps(a: readonly unknown[], b: readonly unknown[]): boolean {
	return (
		a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
	);
}

/**
 * A chat row that sits still while another row streams (Fizzy #2430). The
 * chat re-renders on every streamed token; without this, every earlier row
 * rendered again with it.
 *
 * A skipped row keeps the event handlers of its last render, so any handler
 * the row calls must be stable — route it through `useStableHandlers`.
 */
export const MemoizedRow = memo(
	function MemoizedRow({ render }: MemoizedRowProps) {
		return <>{render()}</>;
	},
	(prev, next) => sameDeps(prev.deps, next.deps),
);
