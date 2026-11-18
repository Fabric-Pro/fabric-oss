"use client";

import { Button } from "@ui/components/button";
import { ArrowLeftIcon, PencilIcon } from "lucide-react";
import Link from "next/link";

/**
 * The top of a report's page: a way back that does not depend on the
 * breadcrumbs, the report's name, and, for someone who may edit it, a labelled
 * way to rename it.
 */
export function ReportDetailHeading({
	emoji,
	name,
	description,
	backHref,
	backLabel,
	onRename,
}: {
	emoji: string;
	name: string;
	description: string;
	backHref: string;
	backLabel: string;
	/** Left out for someone who may not edit the report. */
	onRename?: () => void;
}) {
	return (
		<div className="min-w-0 space-y-2">
			<Button variant="ghost" size="sm" asChild className="-ml-3">
				<Link href={backHref}>
					<ArrowLeftIcon
						aria-hidden="true"
						className="mr-2 h-4 w-4"
					/>
					{backLabel}
				</Link>
			</Button>
			<div className="flex flex-wrap items-center gap-2">
				<span aria-hidden="true" className="text-2xl">
					{emoji}
				</span>
				<h1 className="text-2xl font-bold">{name}</h1>
				{onRename && (
					<Button
						variant="ghost"
						size="sm"
						onClick={onRename}
						aria-label={`Rename ${name}`}
					>
						<PencilIcon
							aria-hidden="true"
							className="mr-1 h-3 w-3"
						/>
						Rename
					</Button>
				)}
			</div>
			<p className="text-muted-foreground">{description}</p>
		</div>
	);
}
