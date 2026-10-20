"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { ChevronDownIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";

/**
 * The published instruction files a coding-tool plugin has no place for, and
 * why, computed on the server (`getPluginReport`) so an admin sees them
 * without any developer running the CLI. Nothing is shown when the plugin
 * carries every file, while nothing is published, or when the answer is not
 * available: a report is only worth a place on the page when it has something
 * to say.
 */
export function InstructionsPluginReport({ projectId }: { projectId: string }) {
	const t = useTranslations("projects.codingInstructions.pluginReport");
	const listId = useId();
	const [open, setOpen] = useState(false);
	const report = useQuery(
		orpc.projects.instructions.getPluginReport.queryOptions({
			input: { projectId },
		}),
	);
	const data = report.data;
	if (!data || data.state !== "ready" || data.leftOutCount === 0) {
		return null;
	}
	return (
		<section
			data-testid="instructions-plugin-report"
			className="rounded-[10px] border border-border bg-card px-5 py-3 text-sm"
		>
			<button
				type="button"
				className="flex w-full items-center justify-between gap-3 text-left font-medium"
				aria-expanded={open}
				aria-controls={listId}
				onClick={() => setOpen((shown) => !shown)}
			>
				{t("title", { count: data.leftOutCount })}
				<ChevronDownIcon
					className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
					aria-hidden="true"
				/>
			</button>
			{open ? (
				<div id={listId} className="mt-3 flex flex-col gap-3">
					<p className="text-muted-foreground">{t("layoutHint")}</p>
					<ul className="m-0 flex list-none flex-col gap-2 p-0">
						{data.leftOut.map((entry) => (
							<li
								key={entry.path}
								className="flex flex-col gap-0.5"
							>
								<code className="[overflow-wrap:anywhere]">
									{entry.path}
								</code>
								<span className="text-muted-foreground text-xs">
									{t(`reasons.${entry.reason}`)}
								</span>
							</li>
						))}
					</ul>
					{data.truncated ? (
						<p className="text-muted-foreground text-xs">
							{t("truncated", {
								shown: data.leftOut.length,
								total: data.leftOutCount,
							})}
						</p>
					) : null}
				</div>
			) : null}
		</section>
	);
}
