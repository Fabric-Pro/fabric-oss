"use client";

import { parseFrontmatter } from "@repo/instructions";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Markdown } from "@ui/components/markdown";
import { Skeleton } from "@ui/components/skeleton";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { toast } from "sonner";

// Script/settings/other files render as plain preformatted text — no
// Markdown or frontmatter parsing, since they are not Markdown documents.
const PLAIN_KINDS = new Set(["SCRIPT", "SETTINGS", "OTHER"]);

async function copyMcpCall(
	text: string,
	copied: string,
	failed: string,
): Promise<void> {
	try {
		if (!navigator.clipboard) {
			throw new Error("clipboard unavailable");
		}
		await navigator.clipboard.writeText(text);
		toast.success(copied);
	} catch {
		toast.error(failed);
	}
}

function invocationLabel(
	fields: Record<string, string>,
	t: (key: string) => string,
): string | null {
	if (fields["disable-model-invocation"] === "true") {
		return t("invocationDisabled");
	}
	if ("disable-model-invocation" in fields) {
		return t("invocationAllowed");
	}
	return null;
}

/**
 * Reads one file of the published snapshot. The header shows the file's
 * CLASSIFIED name/description (`f.name`/`f.description`, set once at
 * ingest — see `packages/database/prisma/queries/instructions.ts`) rather
 * than re-deriving them from the frontmatter block: a file can be
 * classified with a description that isn't itself a `description:`
 * frontmatter key (e.g. inferred from surrounding context), so the stored
 * field is the source of truth and frontmatter parsing below is used only
 * for the metadata rows (`allowed-tools`, `model`, …) that have no
 * dedicated column.
 */
export function InstructionFileView({
	projectId,
	snapshotId,
	path,
}: {
	projectId: string;
	snapshotId: string;
	path: string;
}) {
	const t = useTranslations("projects.codingInstructions.fileView");
	const kindLabels = t.raw("kindLabels") as Record<string, string>;
	const q = useQuery(
		orpc.projects.instructions.getFile.queryOptions({
			input: {
				projectId,
				snapshotId,
				path,
				offset: 0,
				maxLength: 200_000,
			},
		}),
	);
	const parsed = useMemo(
		() =>
			q.data?.body != null && !PLAIN_KINDS.has(q.data.kind)
				? parseFrontmatter(q.data.body)
				: null,
		[q.data],
	);
	if (q.isLoading) {
		return <Skeleton className="h-64 w-full" />;
	}
	if (!q.data) {
		return <p className="text-muted-foreground">{t("couldNotLoad")}</p>;
	}
	const f = q.data;
	const showHeader = Boolean(f.name || f.description);
	return (
		<div className="flex h-full min-w-0 flex-col overflow-hidden rounded-lg border border-border">
			<div className="flex items-center justify-between border-border border-b bg-muted/40 px-4 py-3">
				<code className="min-w-0 truncate text-muted-foreground text-xs">
					{f.path}
				</code>
				<div className="flex items-center gap-2">
					<Badge variant="secondary">
						{kindLabels[f.kind] ?? kindLabels.OTHER}
					</Badge>
					<span className="text-muted-foreground text-xs">
						{Math.round(f.size / 1024)} KB
					</span>
					<Button
						size="sm"
						variant="ghost"
						onClick={() => {
							// Not returned: the shared Button keeps a spinner up
							// until a returned promise settles, and a clipboard
							// write can stay pending indefinitely (document not
							// focused, permission blocked), so the button spun
							// forever. Fire it, report the outcome, move on.
							void copyMcpCall(
								`fabric_get_project_instruction({ projectId: "${projectId}", path: "${f.path}" })`,
								t("copied"),
								t("copyFailed"),
							);
						}}
					>
						{t("copyMcpCall")}
					</Button>
				</div>
			</div>
			<div className="flex min-w-0 flex-col gap-4 overflow-auto p-5 [overflow-wrap:anywhere]">
				{showHeader ? (
					<div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/40 p-4">
						{f.name ? (
							<h2 className="font-semibold text-base">
								{f.name}
							</h2>
						) : null}
						{f.description ? <p>{f.description}</p> : null}
						{parsed ? (
							<dl className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
								{parsed.fields["argument-hint"] ? (
									<>
										<dt className="text-muted-foreground">
											{t("argumentHint")}
										</dt>
										<dd>
											{parsed.fields["argument-hint"]}
										</dd>
									</>
								) : null}
								{(parsed.fields["allowed-tools"] ??
								parsed.fields.tools) ? (
									<>
										<dt className="text-muted-foreground">
											{t("allowedTools")}
										</dt>
										<dd>
											{parsed.fields["allowed-tools"] ??
												parsed.fields.tools}
										</dd>
									</>
								) : null}
								{parsed.fields.model ? (
									<>
										<dt className="text-muted-foreground">
											{t("model")}
										</dt>
										<dd>{parsed.fields.model}</dd>
									</>
								) : null}
								{parsed.fields.paths ? (
									<>
										<dt className="text-muted-foreground">
											{t("appliesTo")}
										</dt>
										<dd className="whitespace-pre-line font-mono text-xs">
											{parsed.fields.paths}
										</dd>
									</>
								) : null}
								{invocationLabel(parsed.fields, t) ? (
									<>
										<dt className="text-muted-foreground">
											{t("modelInvocation")}
										</dt>
										<dd>
											{invocationLabel(parsed.fields, t)}
										</dd>
									</>
								) : null}
							</dl>
						) : null}
					</div>
				) : null}
				{f.body == null ? (
					<p className="text-muted-foreground">
						{t("binaryFile")}{" "}
						{f.url ? (
							<a
								href={f.url}
								target="_blank"
								rel="noopener noreferrer"
								className="underline"
							>
								{t("downloadIt")}
							</a>
						) : null}
					</p>
				) : PLAIN_KINDS.has(f.kind) ? (
					<pre className="whitespace-pre-wrap font-mono text-xs">
						{f.body}
					</pre>
				) : (
					<Markdown>{parsed ? parsed.body : f.body}</Markdown>
				)}
				{f.truncated ? (
					<p className="text-muted-foreground text-xs">
						{t("truncated", { offset: f.nextOffset ?? 0 })}
					</p>
				) : null}
			</div>
		</div>
	);
}
