"use client";

import { cn } from "@ui/lib";
import { lazy, Suspense } from "react";
import type { ResponseProps } from "./response";

const MarkdownResponse = lazy(() =>
	import("./response").then((module) => ({ default: module.Response })),
);

export function DeferredResponse(props: ResponseProps) {
	return (
		<Suspense
			fallback={
				<div className={cn("whitespace-pre-wrap", props.className)}>
					{props.children}
				</div>
			}
		>
			<MarkdownResponse {...props} />
		</Suspense>
	);
}
