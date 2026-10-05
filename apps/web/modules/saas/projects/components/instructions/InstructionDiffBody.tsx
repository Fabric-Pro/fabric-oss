"use client";

import { cn } from "@ui/lib";
import { diffLines } from "diff";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { countDiffLines, toDiffRows } from "./lib/instruction-diff";

/**
 * A unified line diff of one file's text, as `<pre>` rows with the counts above
 * it: the part of a changed row that both the snapshot compare and the commit
 * compare draw once they have the two bodies.
 *
 * Equal bodies are said in words, not drawn as an empty box that would read as
 * a loading failure; and not in the same words when a side was cut short. The
 * manifest already proved the file changed, so with a truncated side "the text
 * did not change" would contradict it and send a reviewer away believing the
 * file is untouched. Only the loaded prefix is unchanged, and the message says
 * exactly that much.
 */
export function InstructionDiffBody({
	path,
	before,
	after,
	truncated,
}: {
	path: string;
	before: string;
	after: string;
	/** Either side was longer than what was loaded. */
	truncated: boolean;
}) {
	const t = useTranslations("projects.codingInstructions.compare");
	const parts = useMemo(() => diffLines(before, after), [before, after]);
	const counts = useMemo(() => countDiffLines(parts), [parts]);
	const rows = useMemo(() => toDiffRows(parts), [parts]);
	if (before === after) {
		return (
			<p className="text-muted-foreground text-sm">
				{t(truncated ? "noChangesInLoadedPrefix" : "noTextualChanges")}
			</p>
		);
	}
	return (
		<div className="flex flex-col gap-1">
			<p className="text-muted-foreground text-xs">
				{t("lineCounts", counts)}
			</p>
			{truncated ? (
				<p className="text-muted-foreground text-xs">
					{t("diffTruncated")}
				</p>
			) : null}
			<pre
				data-testid={`instruction-file-diff-${path}`}
				className="max-h-72 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs"
			>
				{rows.map((row, index) => (
					<span
						key={`${index}-${row.text.length}`}
						className={cn(
							row.added &&
								"bg-emerald-500/15 text-emerald-800 dark:text-emerald-300",
							row.removed &&
								"bg-red-500/15 text-red-800 dark:text-red-300",
						)}
					>
						{row.text}
					</span>
				))}
			</pre>
		</div>
	);
}
