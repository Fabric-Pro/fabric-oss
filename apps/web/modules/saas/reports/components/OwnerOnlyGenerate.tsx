"use client";

import { cn } from "@ui/lib";
import { type ReactNode, useId } from "react";

const OWNER_ONLY_GENERATE_MESSAGE =
	"Only the report's owner can generate it, because it runs on the owner's connections.";

/** For the owner whose project role no longer allows adding reports. */
const ROLE_BLOCKS_GENERATE_MESSAGE =
	"You own this report, but your role on this project does not let you generate it.";

/** Shown where a non-owner would pick a report's connections. */
export const CONNECTIONS_OWNER_ONLY_MESSAGE =
	"Connections belong to the report's owner";

/** Shown where an owner whose role has changed would pick its connections. */
export const CONNECTIONS_ROLE_LOCKED_MESSAGE =
	"Your role on this project does not let you change these connections";

/** Shown above what a non-owner cannot change on a connected report. */
export const CONNECTION_BINDINGS_OWNER_ONLY_MESSAGE =
	"Only the report's owner can change what its connections read. You can still edit its prompts.";

/**
 * Explains a Generate button that is disabled because the viewer may not
 * generate the report: they do not own it, or they own it and their role on the
 * project no longer allows it. The caller disables the button itself and passes
 * the id this renders to the button's `aria-describedby`; the explanation is
 * visible text under the button, so touch and screen-reader users get it too.
 */
export function OwnerOnlyGenerate({
	canGenerate,
	viewerIsOwner = false,
	className,
	children,
}: {
	canGenerate: boolean;
	viewerIsOwner?: boolean;
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
				{viewerIsOwner
					? ROLE_BLOCKS_GENERATE_MESSAGE
					: OWNER_ONLY_GENERATE_MESSAGE}
			</span>
		</span>
	);
}
