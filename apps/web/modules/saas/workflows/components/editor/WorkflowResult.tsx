"use client";

import { Button } from "@ui/components/button";
import { Markdown } from "@ui/components/markdown";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

/** Readable results with the exact stored output available; HTML remains inert. */
export function WorkflowResult({
	output,
	nodeType,
}: {
	output: unknown;
	nodeType?: string;
}) {
	const t = useTranslations("workflows.authoring");
	const copy = (key: string, fallback: string) =>
		t.has(key) ? t(key) : fallback;
	const [copied, setCopied] = useState(false);
	const [copyFailed, setCopyFailed] = useState(false);
	const [view, setView] = useState("formatted");
	const markdown =
		output &&
		typeof output === "object" &&
		"markdown" in output &&
		typeof output.markdown === "string"
			? output.markdown
			: null;
	const text =
		markdown ??
		(typeof output === "string"
			? output
			: output &&
					typeof output === "object" &&
					"text" in output &&
					typeof output.text === "string"
				? output.text
				: null);
	const raw =
		typeof output === "string"
			? output
			: (JSON.stringify(output, null, 2) ?? "");
	useEffect(() => {
		setCopied(false);
		setCopyFailed(false);
	}, [raw]);
	const formatted =
		text !== null &&
		(nodeType === "ai-generate-text" ||
			nodeType === "agent-task" ||
			typeof output === "string");
	return (
		<section aria-label="Step output" className="min-w-0 space-y-2">
			<Tabs
				value={view}
				onValueChange={(value) => {
					setView(value);
					setCopied(false);
					setCopyFailed(false);
				}}
			>
				<div className="flex flex-wrap items-center justify-between gap-2">
					<TabsList aria-label="Output view">
						<TabsTrigger value="formatted">
							{copy("formatted", "Formatted")}
						</TabsTrigger>
						<TabsTrigger value="raw">
							{copy("raw", "Raw output")}
						</TabsTrigger>
					</TabsList>
					<Button
						type="button"
						size="sm"
						variant="ghost"
						onClick={async () => {
							try {
								setCopyFailed(false);
								await navigator.clipboard.writeText(
									view === "raw" || !formatted
										? raw
										: (text ?? raw),
								);
								setCopied(true);
							} catch {
								setCopyFailed(true);
								setCopied(false);
							}
						}}
					>
						{copied
							? copy("copied", "Copied")
							: copy("copy", "Copy result")}
					</Button>
				</div>
				<TabsContent value="formatted" className="min-w-0">
					{formatted ? (
						<Markdown
							className="prose prose-sm max-w-none break-words"
							components={{
								th: ({ children }) => (
									<th scope="col">{children}</th>
								),
								table: ({ children }) => (
									<div className="max-w-full overflow-x-auto">
										<table>{children}</table>
									</div>
								),
								img: ({ alt }) => (
									<span>
										{alt ? `[Image: ${alt}]` : "[Image]"}
									</span>
								),
								a: ({ children, href }) => (
									<a
										href={href}
										target="_blank"
										rel="noopener noreferrer"
									>
										{children}
									</a>
								),
							}}
						>
							{text}
						</Markdown>
					) : (
						<pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">
							{raw}
						</pre>
					)}
				</TabsContent>
				<TabsContent value="raw" className="max-h-96 overflow-auto">
					<section aria-label="Raw step output">
						<pre className="whitespace-pre-wrap break-words font-mono text-xs">
							{raw}
						</pre>
					</section>
				</TabsContent>
			</Tabs>
			{copyFailed && (
				<p role="alert" className="text-xs text-destructive">
					{copy("copyFailed", "Could not copy. Try again.")}
				</p>
			)}
		</section>
	);
}
