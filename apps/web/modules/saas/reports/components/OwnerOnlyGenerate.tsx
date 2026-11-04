"use client";

import { cn } from "@ui/lib";
import { type ReactNode, useId } from "react";

const OWNER_ONLY_GENERATE_MESSAGE =
	"Only the report's owner can generate it, because it runs on the owner's connections.";

/** Shown where a non-owner would pick a report's connections. */
export const CONNECTIONS_OWNER_ONLY_MESSAGE =
	"Connections belong to the report's owner";

/**
 * Explains a Generate button that is disabled because the viewer does not own
 * the report. The caller disables the button itself and passes the id this
 * renders to the button's `aria-describedby`; the explanation is visible text
 * under the button, so touch and screen-reader users get it too.
 */
export function OwnerOnlyGenerate({
	canGenerate,
	className,
	children,
}: {
	canGenerate: boolean;
	className?: string;
	children: (describedBy: string | undefined) => ReactNode;
}) {
	const messageId = useId();
	if (canGenerate) {
		return children(undefined);
	}
	return (
		<span className={cn("inline-flex flex-col gap-1", className)}>
			{children(messageId)}
			<span id={messageId} className="text-xs text-muted-foreground">
				{OWNER_ONLY_GENERATE_MESSAGE}
			</span>
		</span>
	);
}
