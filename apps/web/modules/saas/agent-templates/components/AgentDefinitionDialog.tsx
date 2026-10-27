"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@ui/components/dialog";
import { Label } from "@ui/components/label";
import { Textarea } from "@ui/components/textarea";
import { useId, useRef, useState } from "react";

const definitions = orpcClient.agentTemplates.instances.definition;

export function AgentDefinitionImportDialog({
	organizationId,
	onImported,
}: {
	organizationId: string;
	onImported: (id: string) => void;
}) {
	const id = useId();
	const [open, setOpen] = useState(false);
	const [document, setDocument] = useState("");
	const [fileError, setFileError] = useState<string>();
	const [readingFile, setReadingFile] = useState(false);
	const submitting = useRef(false);
	const preview = useMutation({
		mutationFn: (input: Parameters<typeof definitions.preview>[0]) =>
			definitions.preview(input),
		retry: false,
	});
	const importing = useMutation({
		mutationFn: (input: Parameters<typeof definitions.import>[0]) =>
			definitions.import(input),
		retry: false,
	});
	const busy = readingFile || preview.isPending || importing.isPending;

	function changeDocument(value: string) {
		setDocument(value);
		setFileError(undefined);
		preview.reset();
		importing.reset();
	}

	async function importDraft() {
		if (submitting.current || !preview.data) {
			return;
		}
		submitting.current = true;
		try {
			const result = await importing.mutateAsync({
				organizationId,
				document,
			});
			setOpen(false);
			onImported(result.instance.id);
		} catch {
			// The mutation displays a safe error below without echoing file contents.
		} finally {
			submitting.current = false;
		}
	}

	return (
		<Dialog
			open={open}
			onOpenChange={(value) => {
				if (!busy) {
					setOpen(value);
				}
			}}
		>
			<DialogTrigger asChild>
				<Button variant="outline">Import agent</Button>
			</DialogTrigger>
			<DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>Import an agent definition</DialogTitle>
					<DialogDescription>
						Preview a Fabric JSON or YAML definition, then create a
						draft in this organization.
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor={`${id}-file`}>
							Definition file (up to 1 MB)
						</Label>
						<input
							id={`${id}-file`}
							type="file"
							accept=".json,.yaml,.yml"
							disabled={busy}
							className="block w-full text-sm"
							onChange={async (event) => {
								const file = event.target.files?.[0];
								if (!file) {
									return;
								}
								if (file.size > 1024 * 1024) {
									setFileError(
										"Choose a file smaller than 1 MB.",
									);
									preview.reset();
									return;
								}
								setReadingFile(true);
								changeDocument("");
								try {
									changeDocument(await file.text());
								} catch {
									setFileError("Unable to read this file.");
								} finally {
									setReadingFile(false);
								}
							}}
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor={`${id}-document`}>
							Or paste JSON or YAML
						</Label>
						<Textarea
							id={`${id}-document`}
							value={document}
							disabled={busy}
							onChange={(event) =>
								changeDocument(event.target.value)
							}
							rows={8}
							maxLength={1024 * 1024}
							className="font-mono text-xs"
							spellCheck={false}
						/>
					</div>
					{preview.data && (
						<section
							aria-label="Import preview"
							className="space-y-3 rounded-md border p-4"
						>
							<p className="font-medium">
								{preview.data.definition.name}
							</p>
							<p className="text-sm text-muted-foreground">
								{preview.data.definition.description}
							</p>
							<p className="text-sm">
								{preview.data.definition.skills.length} skills ·{" "}
								{preview.data.definition.model.model ??
									"Organization default model"}
							</p>
							{preview.data.definition.requirements.length >
								0 && (
								<div>
									<p className="text-sm font-medium">
										Requires setup after import
									</p>
									<ul className="list-disc pl-5 text-sm">
										{preview.data.definition.requirements.map(
											(item, index) => (
												<li
													key={`${item.kind}-${item.name}-${index}`}
												>
													{item.name} ({item.kind})
												</li>
											),
										)}
									</ul>
								</div>
							)}
							{preview.data.notices.map((notice) => (
								<p
									key={notice}
									className="text-sm text-muted-foreground"
								>
									{notice}
								</p>
							))}
						</section>
					)}
					{(fileError || preview.isError || importing.isError) && (
						<p role="alert" className="text-sm text-destructive">
							{fileError ??
								(importing.isError
									? "Import could not be confirmed. Check your agent list before trying again."
									: "Unable to preview this definition. Check its format and your organization permissions.")}
						</p>
					)}
				</div>
				<DialogFooter>
					<Button
						variant="outline"
						disabled={busy}
						onClick={() => setOpen(false)}
					>
						Cancel
					</Button>
					{preview.data ? (
						<Button
							disabled={busy || !!fileError || importing.isError}
							onClick={importDraft}
						>
							{importing.isPending
								? "Importing…"
								: "Create draft"}
						</Button>
					) : (
						<Button
							disabled={busy || !document.trim() || !!fileError}
							onClick={() =>
								preview.mutate({ organizationId, document })
							}
						>
							{preview.isPending
								? "Reading…"
								: "Preview definition"}
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

export function AgentDefinitionExportDialog({
	organizationId,
	instanceId,
}: {
	organizationId: string;
	instanceId: string;
}) {
	const id = useId();
	const [format, setFormat] = useState<"json" | "yaml">("yaml");
	const exporting = useMutation({
		mutationFn: (input: Parameters<typeof definitions.export>[0]) =>
			definitions.export(input),
		retry: false,
	});
	const [downloaded, setDownloaded] = useState(false);
	const inFlight = useRef(false);
	async function download() {
		if (inFlight.current) {
			return;
		}
		inFlight.current = true;
		setDownloaded(false);
		try {
			const result = await exporting.mutateAsync({
				organizationId,
				id: instanceId,
				format,
			});
			const url = URL.createObjectURL(
				new Blob([result.document], {
					type:
						format === "json"
							? "application/json"
							: "application/yaml",
				}),
			);
			const link = window.document.createElement("a");
			link.href = url;
			link.download = result.filename;
			window.document.body.appendChild(link);
			link.click();
			link.remove();
			setTimeout(() => URL.revokeObjectURL(url), 1000);
			setDownloaded(true);
		} catch {
			// Display the mutation error without exposing server/parser details.
		} finally {
			inFlight.current = false;
		}
	}
	return (
		<Dialog>
			<DialogTrigger asChild>
				<Button variant="outline">Export agent</Button>
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Export agent definition</DialogTitle>
					<DialogDescription>
						Save instructions, skills and model settings as JSON or
						YAML. Review instruction and skill text before sharing
						the file.
					</DialogDescription>
				</DialogHeader>
				<p className="text-sm text-muted-foreground">
					Connections and triggers become setup requirements.
					Credentials, conversation history, learned memory and
					existing approvals are excluded. Model options beyond
					temperature, topP and maxTokens are omitted.
				</p>
				<div className="space-y-2">
					<Label htmlFor={`${id}-format`}>File format</Label>
					<select
						id={`${id}-format`}
						value={format}
						disabled={exporting.isPending}
						onChange={(event) => {
							setFormat(
								event.target.value === "json" ? "json" : "yaml",
							);
							setDownloaded(false);
						}}
						className="w-full rounded-md border bg-background p-2 text-sm"
					>
						<option value="yaml">YAML</option>
						<option value="json">JSON</option>
					</select>
				</div>
				{exporting.isError && (
					<p role="alert" className="text-sm text-destructive">
						Unable to export this agent. Check your access and
						whether its settings are supported.
					</p>
				)}
				{downloaded && (
					<output className="text-sm">Definition downloaded.</output>
				)}
				<DialogFooter>
					<Button disabled={exporting.isPending} onClick={download}>
						{exporting.isPending
							? "Exporting…"
							: "Download definition"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** Show unresolved portable intent on the draft, after the import dialog closes. */
export function AgentDefinitionRequirements({
	requirements,
}: {
	requirements: unknown;
}) {
	if (!Array.isArray(requirements)) {
		return null;
	}
	const labels = requirements.flatMap((item: unknown) => {
		if (
			item &&
			typeof item === "object" &&
			"kind" in item &&
			"name" in item &&
			typeof item.kind === "string" &&
			typeof item.name === "string"
		) {
			return [`${item.name} (${item.kind})`];
		}
		return [];
	});
	return (
		<section
			aria-label="Imported agent setup"
			className="space-y-2 rounded-md border p-4"
		>
			<p className="font-medium">Imported definition</p>
			<p className="text-sm text-muted-foreground">
				Review the model and skills before publishing. Imported
				connections and triggers require setup in this organization. The
				original setup requirements are listed below; this list does not
				track later configuration changes.
			</p>
			{labels.length > 0 && (
				<ul className="list-disc pl-5 text-sm">
					{labels.map((label, index) => (
						<li key={`${index}:${label}`}>{label}</li>
					))}
				</ul>
			)}
		</section>
	);
}
