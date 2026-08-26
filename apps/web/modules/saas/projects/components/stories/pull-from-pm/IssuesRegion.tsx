"use client";

import type { PMTicketListError } from "@repo/api/modules/projects/procedures/stories/sync/list-pm-tickets-filters.types";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ui/components/collapsible";
import { AlertCircleIcon, ChevronDownIcon } from "lucide-react";
import { useState } from "react";

interface IssuesRegionProps {
	errors: PMTicketListError[];
}

function describeIssue(err: PMTicketListError): string {
	switch (err.kind) {
		case "not_found":
			return `#${err.id} not found`;
		case "wrong_board":
			return `#${err.id} not found on this board`;
		case "auth":
			return `#${err.id} — authentication failed. Try reconnecting your PM tool.`;
		case "rate_limited":
			return `#${err.id} — rate limited. Please wait and try again.`;
		case "server":
			return `#${err.id} — PM tool returned ${err.status}. Try again later.`;
		case "network":
			return `#${err.id} — network error. Check your connection and try again.`;
		default: {
			// Exhaustiveness guard — if a new kind is added to the union we want
			// a TS error here, not a runtime crash.
			const _exhaustive: never = err;
			void _exhaustive;
			return "Failed to fetch.";
		}
	}
}

function compactIdRanges(ids: (string | number)[]): string {
	const nums = ids
		.map((id) => (typeof id === "number" ? id : Number(id)))
		.filter((n) => Number.isFinite(n))
		.sort((a, b) => a - b);
	if (nums.length === 0) {
		return ids.map((id) => `#${id}`).join(", ");
	}
	const ranges: string[] = [];
	let start = nums[0];
	let prev = nums[0];
	for (let i = 1; i < nums.length; i++) {
		const n = nums[i];
		if (n === prev + 1) {
			prev = n;
			continue;
		}
		ranges.push(start === prev ? `#${start}` : `#${start}–${prev}`);
		start = n;
		prev = n;
	}
	ranges.push(start === prev ? `#${start}` : `#${start}–${prev}`);
	return ranges.join(", ");
}

/**
 * Server-side ID resolution errors (not-found / wrong-board). Does not block
 * Apply — valid IDs still import (FR-5, AC-4, AC-13). Renders nothing when
 * empty. Spec §5.2, §5.5.
 */
export function IssuesRegion({ errors }: IssuesRegionProps) {
	const [open, setOpen] = useState(false);
	if (errors.length === 0) {
		return null;
	}
	const notFound = errors.filter((e) => e.kind === "not_found");
	const wrongBoard = errors.filter((e) => e.kind === "wrong_board");
	const auth = errors.filter((e) => e.kind === "auth");
	const rateLimited = errors.filter((e) => e.kind === "rate_limited");
	const server = errors.filter((e) => e.kind === "server");
	const network = errors.filter((e) => e.kind === "network");
	const summaryParts: string[] = [];
	if (notFound.length > 0) {
		summaryParts.push(
			`${notFound.length} not found · ${compactIdRanges(notFound.map((e) => e.id))}`,
		);
	}
	if (wrongBoard.length > 0) {
		summaryParts.push(
			`${wrongBoard.length} not on board · ${compactIdRanges(wrongBoard.map((e) => e.id))}`,
		);
	}
	if (auth.length > 0) {
		summaryParts.push(
			`${auth.length} auth failed · ${compactIdRanges(auth.map((e) => e.id))}`,
		);
	}
	if (rateLimited.length > 0) {
		summaryParts.push(
			`${rateLimited.length} rate limited · ${compactIdRanges(rateLimited.map((e) => e.id))}`,
		);
	}
	if (server.length > 0) {
		summaryParts.push(
			`${server.length} server error · ${compactIdRanges(server.map((e) => e.id))}`,
		);
	}
	if (network.length > 0) {
		summaryParts.push(
			`${network.length} network error · ${compactIdRanges(network.map((e) => e.id))}`,
		);
	}
	return (
		<Collapsible open={open} onOpenChange={setOpen} asChild>
			<div
				role="alert"
				aria-live="polite"
				className="border-b border-border/40 text-destructive text-sm"
			>
				<CollapsibleTrigger className="w-full flex items-center gap-2 px-4 py-2 hover:bg-destructive/10 transition-colors text-left">
					<AlertCircleIcon
						className="size-4 shrink-0"
						aria-hidden="true"
					/>
					<span className="truncate flex-1">
						{summaryParts.join(" · ")}
					</span>
					<ChevronDownIcon
						className={`size-4 shrink-0 transition-transform ${
							open ? "rotate-180" : ""
						}`}
					/>
				</CollapsibleTrigger>
				<CollapsibleContent className="px-4 pb-2 pl-10">
					<ul className="flex flex-col gap-0.5 text-xs">
						{errors.map((err, i) => (
							<li key={`${err.kind}-${err.id}-${i}`}>
								{describeIssue(err)}
							</li>
						))}
					</ul>
				</CollapsibleContent>
			</div>
		</Collapsible>
	);
}
