"use client";
import type { SkillFileContent } from "@repo/ai/skill-authoring-contracts";
import { useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { DownloadIcon } from "lucide-react";
import { useState } from "react";
import { skillUiError } from "../lib/skill-ui";
export type SkillFileContents = SkillFileContent;
type FileEntry = {
	path: string;
	contentType: string;
	sizeBytes: number;
	version?: number;
};
export function SkillRuntimeFiles({
	files,
	complete = true,
	identity,
	readFile,
	disabled = false,
}: {
	files: FileEntry[];
	complete?: boolean;
	identity: string;
	readFile: (path: string) => Promise<SkillFileContents>;
	disabled?: boolean;
}) {
	const [selected, setSelected] = useState<string>();
	const grouped = new Map<string, FileEntry[]>();
	for (const file of files) {
		const folder = file.path.includes("/")
			? file.path.slice(0, file.path.lastIndexOf("/"))
			: "Root files";
		const entries = grouped.get(folder) || [];
		entries.push(file);
		grouped.set(folder, entries);
	}

	return (
		<div className="space-y-3">
			{files.length ? (
				<details className="group/files">
					<summary className="cursor-pointer text-sm font-medium">
						{files.length} supporting{" "}
						{files.length === 1 ? "file" : "files"}
					</summary>
					<div className="mt-3 space-y-2">
						{Array.from(grouped.entries()).map(
							([folder, entries]) => (
								<details
									key={folder}
									open={folder === "Root files"}
									className="rounded-md border border-border px-3 py-2"
								>
									<summary className="cursor-pointer break-all text-sm">
										{folder}{" "}
										<span className="text-muted-foreground">
											({entries?.length})
										</span>
									</summary>
									<ul className="mt-2 space-y-2 text-sm">
										{entries?.map((file) => (
											<li
												key={file.path}
												className="flex flex-wrap items-center justify-between gap-2"
											>
												<Button
													type="button"
													variant="link"
													size="sm"
													className="h-auto min-w-0 max-w-full justify-start whitespace-normal break-all p-0 text-left font-mono"
													disabled={disabled}
													onClick={() =>
														setSelected(file.path)
													}
												>
													{file.path
														.split("/")
														.at(-1)}
												</Button>
											</li>
										))}
									</ul>
								</details>
							),
						)}
					</div>
				</details>
			) : (
				<p className="text-sm text-muted-foreground">
					No additional files.
				</p>
			)}
			{!complete && (
				<p className="text-xs text-muted-foreground">
					The file manifest is incomplete. Review the original bundle
					before relying on its resources.
				</p>
			)}
			<p className="text-xs text-muted-foreground">
				Open files to inspect them as text or download them. Viewing and
				importing never executes a file.
			</p>
			{selected && (
				<SkillFileInspector
					key={`${identity}:${selected}`}
					identity={identity}
					path={selected}
					readFile={readFile}
					version={
						files.find((file) => file.path === selected)?.version
					}
					onClose={() => setSelected(undefined)}
				/>
			)}
		</div>
	);
}
function SkillFileInspector({
	version,
	identity,
	path,
	readFile,
	onClose,
}: {
	identity: string;
	version?: number;
	path: string;
	readFile: (path: string) => Promise<SkillFileContents>;
	onClose: () => void;
}) {
	const query = useQuery({
		queryKey: ["skill-file-read", identity, path],
		queryFn: () => readFile(path),
		retry: false,
		gcTime: 0,
		staleTime: 0,
	});
	function download(file: SkillFileContents) {
		const bytes =
			file.encoding === "base64"
				? Uint8Array.from(atob(file.data), (character) =>
						character.charCodeAt(0),
					)
				: file.data;
		const blob = new Blob([bytes], {
			type:
				file.encoding === "utf-8"
					? "text/plain;charset=utf-8"
					: "application/octet-stream",
		});
		const url = URL.createObjectURL(blob);
		const link = document.createElement("a");
		link.href = url;
		link.download = Array.from(file.path.split("/").at(-1) || "skill-file")
			.filter((character) => {
				const value = character.codePointAt(0) ?? 0;
				return value >= 32 && value !== 127;
			})
			.join("");
		document.body.appendChild(link);
		link.click();
		link.remove();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) {
					onClose();
				}
			}}
		>
			<DialogContent className="max-w-3xl">
				<DialogHeader>
					<DialogTitle className="break-all">{path}</DialogTitle>
					<DialogDescription>
						Read-only inspection. File contents are displayed as
						plain text and are never executed.
					</DialogDescription>
				</DialogHeader>
				{query.isError ? (
					<Alert variant="error">
						<AlertDescription>
							{skillUiError(query.error)}
						</AlertDescription>
					</Alert>
				) : query.isPending ? (
					<output>Loading file…</output>
				) : (
					<>
						<p className="text-xs text-muted-foreground">
							{query.data.contentType} ·{" "}
							{query.data.sizeBytes.toLocaleString()} bytes
							{version ? ` · v${version}` : ""}
						</p>
						{query.data.encoding === "utf-8" ? (
							<pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-muted/20 p-4 text-xs">
								{query.data.data}
							</pre>
						) : (
							<p className="text-sm text-muted-foreground">
								Binary file. Download it to inspect it in an
								appropriate application.
							</p>
						)}
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => download(query.data)}
						>
							<DownloadIcon className="size-4" />
							Download file
						</Button>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
