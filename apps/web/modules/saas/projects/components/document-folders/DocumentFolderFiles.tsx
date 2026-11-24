"use client";

/**
 * The files of a document folder that need attention (Fizzy #2808): skipped
 * and failed files with the reason for each, and the files someone removed
 * from the context list, which stay out until they change at the source.
 *
 * The list holds the most recent skipped and failed files the folder list
 * returns; any beyond them are counted, not listed.
 */

import { Button } from "@ui/components/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ui/components/collapsible";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";
import {
	type EditorDocumentFolder,
	filesLabel,
	providerName,
} from "./use-document-folders";

type AttentionFile = EditorDocumentFolder["attention"][number];

function reasonFor(file: AttentionFile, provider: string): string {
	switch (file.skipCode) {
		case "UNSUPPORTED":
			return "This file type is not supported.";
		case "TOO_BIG":
			return "Larger than the upload limit for its type.";
		case "CAP_REACHED":
			return "Outside the 500 most recently modified files.";
	}
	switch (file.failureCode) {
		case "DOWNLOAD_FAILED":
			return `Could not be downloaded from ${providerName(provider)}.`;
		case "PROCESSING_FAILED":
			return "Downloaded, but its text could not be read.";
	}
	return file.status === "FAILED"
		? "Could not be imported."
		: "Not imported.";
}

export function DocumentFolderFiles({
	provider,
	attention,
	counts,
}: {
	provider: string;
	attention: AttentionFile[];
	counts: EditorDocumentFolder["counts"];
}) {
	const [open, setOpen] = useState(false);
	const notImported = counts.skipped + counts.failed;
	const total = notImported + counts.excluded;
	if (total === 0) {
		return null;
	}
	const more = Math.max(0, notImported - attention.length);

	return (
		<Collapsible open={open} onOpenChange={setOpen}>
			<CollapsibleTrigger asChild>
				<Button variant="ghost" size="sm" className="-ml-2 gap-1">
					<ChevronRightIcon
						aria-hidden="true"
						className={open ? "size-4 rotate-90" : "size-4"}
					/>
					Files that need attention ({total})
				</Button>
			</CollapsibleTrigger>
			<CollapsibleContent className="space-y-2 pt-1">
				{attention.length > 0 && (
					<ul className="divide-y rounded-md border text-sm">
						{attention.map((file) => (
							<li key={file.id} className="space-y-0.5 px-3 py-2">
								<p className="break-all font-medium">
									{file.relativePath || file.name}
								</p>
								<p className="text-muted-foreground text-xs">
									{reasonFor(file, provider)}
								</p>
							</li>
						))}
					</ul>
				)}
				{more > 0 && (
					<p className="text-muted-foreground text-xs">
						And {more} more skipped or failed{" "}
						{more === 1 ? "file" : "files"}.
					</p>
				)}
				{counts.excluded > 0 && (
					<p className="text-muted-foreground text-xs">
						{filesLabel(counts.excluded)}{" "}
						{counts.excluded === 1 ? "was" : "were"} removed from
						the context list, so{" "}
						{counts.excluded === 1 ? "it is" : "they are"} left out.
						Each returns when it changes in {providerName(provider)}
						.
					</p>
				)}
			</CollapsibleContent>
		</Collapsible>
	);
}
