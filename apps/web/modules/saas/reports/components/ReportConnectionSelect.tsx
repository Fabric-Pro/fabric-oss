"use client";

import type { ReportConnectionsState } from "@saas/reports/hooks/use-instance-data-source-setup";
import {
	type ReportConnectionGroups,
	type ReportConnectionOption,
	reportCategoryLabel,
	startsWithAllTools,
} from "@saas/reports/lib/report-source-categories";
import { Button } from "@ui/components/button";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { cn } from "@ui/lib";
import {
	ExternalLinkIcon,
	Loader2Icon,
	RotateCcwIcon,
	ServerIcon,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";

function optionItems(options: ReportConnectionOption[]) {
	return options.map((option) => (
		<SelectItem
			key={option.value}
			value={option.value}
			disabled={option.disabled}
		>
			<span className="flex items-center gap-2">
				<span>{option.label}</span>
				{option.hint && (
					<span className="text-xs text-muted-foreground">
						{option.hint}
					</span>
				)}
			</span>
		</SelectItem>
	));
}

/**
 * The categorical connection picker: the data source's own tools and the
 * other connected tools of its category, with every other connected tool
 * behind "Show all tools". When nothing fits, it links to connecting one.
 */
export function ReportConnectionSelect({
	id,
	groups,
	value,
	onValueChange,
	placeholder,
	connectHref,
	required,
	invalid,
	describedBy,
	connectInNewTab,
	connections = "answered",
	onRetryConnections,
}: {
	id?: string;
	groups: ReportConnectionGroups;
	value: string;
	onValueChange: (value: string) => void;
	placeholder: string;
	/** Where a tool for this source is connected. */
	connectHref: string;
	required?: boolean;
	/** A required choice is still empty: show the trigger in red. */
	invalid?: boolean;
	/** The id of the sentence saying why this choice is needed. */
	describedBy?: string;
	/** Keep the page the person is on, to return to once they have connected. */
	connectInNewTab?: boolean;
	/** Until the list has answered, "nothing is connected" would not be true. */
	connections?: ReportConnectionsState;
	onRetryConnections?: () => void;
}) {
	// Follows the connections as they load until the person toggles the view.
	const [chosenView, setChosenView] = useState<boolean | null>(null);
	const showAll = chosenView ?? startsWithAllTools(groups, value);
	const category = groups.category
		? reportCategoryLabel(groups.category)
		: null;
	const categoryLabel = category ?? "matching";
	const narrowCount = groups.recommended.length + groups.related.length;
	const allCount = groups.others.reduce(
		(count, group) => count + group.options.length,
		narrowCount,
	);
	const visibleCount = showAll ? allCount : narrowCount;

	return (
		<div className="space-y-2">
			{visibleCount > 0 ? (
				<Select value={value} onValueChange={onValueChange}>
					<SelectTrigger
						id={id}
						className={cn(
							"w-full bg-background",
							invalid && "border-destructive",
						)}
						aria-required={required || undefined}
						aria-invalid={invalid || undefined}
						aria-describedby={describedBy}
					>
						<SelectValue placeholder={placeholder} />
					</SelectTrigger>
					<SelectContent>
						{groups.recommended.length > 0 && (
							<SelectGroup>
								<SelectLabel>Recommended</SelectLabel>
								{optionItems(groups.recommended)}
							</SelectGroup>
						)}
						{groups.related.length > 0 && (
							<SelectGroup>
								<SelectLabel>
									Other {categoryLabel} tools
								</SelectLabel>
								{optionItems(groups.related)}
							</SelectGroup>
						)}
						{showAll &&
							groups.others.map((group) => (
								<SelectGroup key={group.label}>
									<SelectLabel>{group.label}</SelectLabel>
									{optionItems(group.options)}
								</SelectGroup>
							))}
					</SelectContent>
				</Select>
			) : connections === "loading" ? (
				<p className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
					<Loader2Icon
						aria-hidden="true"
						className="h-4 w-4 motion-safe:animate-spin"
					/>
					Loading your connected tools...
				</p>
			) : connections === "failed" ? (
				<div className="space-y-2 rounded-lg border border-dashed p-3">
					<p role="alert" className="text-sm text-destructive">
						Your connected tools could not be loaded.
					</p>
					{onRetryConnections && (
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={onRetryConnections}
						>
							<RotateCcwIcon
								aria-hidden="true"
								className="mr-1 h-3 w-3"
							/>
							Try again
						</Button>
					)}
				</div>
			) : (
				<div className="rounded-lg border border-dashed p-3 text-center">
					<p className="text-sm text-muted-foreground">
						{allCount > 0
							? `No ${categoryLabel} tool is connected yet.`
							: "No tools are connected yet."}
					</p>
				</div>
			)}
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
				{groups.others.length > 0 && narrowCount > 0 && (
					<Button
						type="button"
						variant="link"
						size="sm"
						className="h-auto px-0 text-xs"
						aria-expanded={showAll}
						onClick={() => setChosenView(!showAll)}
					>
						{showAll
							? `Show only ${categoryLabel} tools`
							: `Show all tools (${allCount})`}
					</Button>
				)}
				{narrowCount === 0 && connections === "answered" && (
					<Button type="button" variant="outline" size="sm" asChild>
						<Link
							href={connectHref}
							{...(connectInNewTab
								? {
										target: "_blank",
										rel: "noopener noreferrer",
									}
								: {})}
						>
							<ServerIcon className="mr-1 h-3 w-3" />
							{category
								? `Connect a tool for ${category}`
								: "Connect a tool"}
							{connectInNewTab && (
								<>
									<ExternalLinkIcon
										aria-hidden="true"
										className="ml-1 h-3 w-3"
									/>
									<span className="sr-only">
										{" "}
										(opens in a new tab)
									</span>
								</>
							)}
						</Link>
					</Button>
				)}
			</div>
		</div>
	);
}
