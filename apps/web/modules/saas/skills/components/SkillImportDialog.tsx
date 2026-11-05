"use client";
import {
	SKILL_IMPORT_MAX_BYTES,
	type SkillImportCandidate,
	type SkillImportPreview,
	type skillImportSourceSchema,
} from "@repo/ai/skill-authoring-contracts";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { Markdown } from "@ui/components/markdown";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import { Textarea } from "@ui/components/textarea";
import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";
import { toast } from "sonner";
import type { z } from "zod";
import { skillSlug, skillUiError } from "../lib/skill-ui";
import {
	type SkillCreateAttempt,
	SkillCreationRecovery,
} from "./SkillCreationRecovery";
import { SkillRuntimeFiles } from "./SkillRuntimeFiles";

type Source = z.infer<typeof skillImportSourceSchema>;
type Review = { source: Source; preview: SkillImportPreview };
export function SkillImportDialog({
	organizationId,
	basePath,
	onClose,
}: {
	organizationId: string;
	basePath: string;
	onClose: () => void;
}) {
	const id = useId();
	const router = useRouter();
	const cache = useQueryClient();
	const revision = useRef(0);
	const [tab, setTab] = useState("file");
	const [fileSource, setFileSource] = useState<Source>();
	const [url, setUrl] = useState("");
	const [ref, setRef] = useState("");
	const [reading, setReading] = useState(false);
	const [inputError, setInputError] = useState<string>();
	const [review, setReview] = useState<Review>();
	const [created, setCreated] = useState(false);
	const attemptedCreate = useRef<SkillCreateAttempt | undefined>(undefined);
	const [unconfirmedCreate, setUnconfirmedCreate] =
		useState<SkillCreateAttempt>();
	const [candidateKey, setCandidateKey] = useState("");
	const [name, setName] = useState("");
	const [slug, setSlug] = useState("");
	const [description, setDescription] = useState("");
	const resetReview = () => {
		revision.current += 1;
		setReading(false);
		setReview(undefined);
		setCandidateKey("");
		setInputError(undefined);
	};
	function selectCandidate(candidate: SkillImportCandidate) {
		setCandidateKey(candidate.key);
		setName(candidate.draft.name);
		setSlug(candidate.draft.slug);
		setDescription(candidate.draft.description);
	}
	const preview = useMutation({
		mutationFn: async () => {
			const generation = revision.current;
			const source: Source =
				tab === "file"
					? (fileSource ??
						(() => {
							throw new Error("Choose a skill file first.");
						})())
					: {
							kind: "github",
							url: url.trim(),
							...(ref.trim() ? { ref: ref.trim() } : {}),
						};
			const result = await orpcClient.skills.import.preview({
				organizationId,
				source,
			});
			return { source, result, generation };
		},
		retry: false,
		onSuccess: ({ source, result, generation }) => {
			if (generation !== revision.current) {
				return;
			}
			const pinned: Source =
				source.kind === "github" && result.source.commit
					? { ...source, ref: result.source.commit }
					: source;
			setReview({ source: pinned, preview: result });
			if (result.candidates[0]) {
				selectCandidate(result.candidates[0]);
			}
		},
	});
	const candidate = review?.preview.candidates.find(
		(item) => item.key === candidateKey,
	);
	const missingCommit =
		review?.source.kind === "github" && !review.preview.source.commit;
	const create = useMutation({
		mutationFn: async () => {
			if (unconfirmedCreate) {
				throw new Error(
					"Review the previous import before creating another draft.",
				);
			}
			if (!review || !candidate || missingCommit) {
				throw new Error("Preview this skill before creating a draft.");
			}
			attemptedCreate.current = { name: name.trim(), slug: slug.trim() };
			return orpcClient.skills.import.create({
				organizationId,
				source: review.source,
				candidateKey: candidate.key,
				expectedHash: review.preview.source.sha256,
				overrides: {
					name: name.trim(),
					slug: slug.trim(),
					description: description.trim(),
				},
			});
		},
		retry: false,
		onError: () => {
			if (attemptedCreate.current) {
				setUnconfirmedCreate(attemptedCreate.current);
			}
		},
		onSuccess: async (result) => {
			setCreated(true);
			await cache.invalidateQueries({
				queryKey: ["skills", organizationId],
			});
			toast.success("Skill imported as your draft");
			router.push(
				`${basePath}/skills/${encodeURIComponent(result.skill.id)}/edit`,
			);
		},
	});
	async function loadFile(file: File | undefined) {
		resetReview();
		setFileSource(undefined);
		if (!file) {
			return;
		}
		if (file.size > SKILL_IMPORT_MAX_BYTES) {
			setInputError("Choose a file under 8 MiB.");
			return;
		}
		if (!/\.(md|zip|skill)$/i.test(file.name)) {
			setInputError("Choose a Markdown, .zip, or .skill file.");
			return;
		}
		const generation = revision.current;
		setReading(true);
		try {
			const base64 = await new Promise<string>((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () =>
					resolve(String(reader.result).split(",")[1] ?? "");
				reader.onerror = () =>
					reject(new Error("File could not be read"));
				reader.readAsDataURL(file);
			});
			if (generation === revision.current) {
				setFileSource({ kind: "file", fileName: file.name, base64 });
			}
		} catch {
			if (generation === revision.current) {
				setInputError("This file could not be read. Choose it again.");
			}
		} finally {
			if (generation === revision.current) {
				setReading(false);
			}
		}
	}
	const warnings = [
		...(review?.preview.warnings ?? []),
		...(candidate?.warnings ?? []),
	];
	const error = create.error ?? preview.error;
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !create.isPending) {
					onClose();
				}
			}}
		>
			<DialogContent className="max-w-3xl">
				<DialogHeader>
					<DialogTitle>Import a skill</DialogTitle>
					<DialogDescription>
						Preview its instructions and files before creating your
						private draft.
					</DialogDescription>
				</DialogHeader>
				<Tabs
					value={tab}
					onValueChange={(value) => {
						if (create.isPending) {
							return;
						}
						setTab(value);
						resetReview();
						preview.reset();
					}}
				>
					<TabsList aria-label="Skill import source">
						<TabsTrigger value="file">Files</TabsTrigger>
						<TabsTrigger value="github">
							GitHub repository
						</TabsTrigger>
					</TabsList>
					<TabsContent value="file" className="space-y-2">
						<Label htmlFor={`${id}-file`}>Skill file</Label>
						<Input
							id={`${id}-file`}
							type="file"
							accept=".md,.zip,.skill"
							disabled={create.isPending}
							onChange={(event) =>
								void loadFile(event.target.files?.[0])
							}
						/>
						<p className="text-xs text-muted-foreground">
							Use SKILL.md, another Markdown file, or a
							.zip/.skill bundle containing SKILL.md with YAML
							name and description. Up to 8 MiB per upload.
						</p>
					</TabsContent>
					<TabsContent value="github" className="space-y-3">
						<div className="space-y-2">
							<Label htmlFor={`${id}-url`}>
								Public GitHub repository URL
							</Label>
							<Input
								id={`${id}-url`}
								type="url"
								value={url}
								maxLength={1000}
								placeholder="https://github.com/example/skills"
								onChange={(event) => {
									setUrl(event.target.value);
									resetReview();
								}}
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor={`${id}-ref`}>
								Branch or commit (optional)
							</Label>
							<Input
								id={`${id}-ref`}
								value={ref}
								maxLength={150}
								onChange={(event) => {
									setRef(event.target.value);
									resetReview();
								}}
							/>
						</div>
						<p className="text-xs text-muted-foreground">
							For a private repository, upload a bundle. A
							reviewed import is pinned to the repository commit
							shown in its preview.
						</p>
					</TabsContent>
				</Tabs>
				{inputError && (
					<Alert variant="error">
						<AlertDescription>{inputError}</AlertDescription>
					</Alert>
				)}
				{error && (
					<Alert variant="error">
						<AlertTitle>Import needs attention</AlertTitle>
						<AlertDescription>
							{skillUiError(error)}
						</AlertDescription>
					</Alert>
				)}
				<Button
					type="button"
					variant="outline"
					size="sm"
					loading={preview.isPending || reading}
					disabled={
						preview.isPending ||
						reading ||
						create.isPending ||
						(tab === "file" ? !fileSource : !url.trim())
					}
					onClick={() => preview.mutate()}
				>
					Preview skills
				</Button>
				{review && (
					<section
						aria-label="Review imported skill"
						className="space-y-4 border-t border-border pt-4"
					>
						{!review.preview.candidates.length ? (
							<p className="text-sm text-muted-foreground">
								No valid skills were found in this source.
								Review the file requirements and try another
								source.
							</p>
						) : (
							<>
								<div className="space-y-2">
									<Label htmlFor={`${id}-candidate`}>
										Skill to import
									</Label>
									<Select
										value={candidateKey}
										onValueChange={(value) => {
											const item =
												review.preview.candidates.find(
													(x) => x.key === value,
												);
											if (item) {
												selectCandidate(item);
											}
										}}
									>
										<SelectTrigger id={`${id}-candidate`}>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{review.preview.candidates.map(
												(item) => (
													<SelectItem
														key={item.key}
														value={item.key}
													>
														{item.draft.name ||
															item.key}
													</SelectItem>
												),
											)}
										</SelectContent>
									</Select>
								</div>
								<div className="grid gap-3 sm:grid-cols-2">
									<div className="space-y-2">
										<Label htmlFor={`${id}-name`}>
											Draft name
										</Label>
										<Input
											id={`${id}-name`}
											maxLength={200}
											value={name}
											onChange={(event) => {
												setName(event.target.value);
												setSlug(
													skillSlug(
														event.target.value,
													),
												);
											}}
										/>
									</div>
									<div className="space-y-2">
										<Label htmlFor={`${id}-slug`}>
											Identifier
										</Label>
										<Input
											id={`${id}-slug`}
											maxLength={100}
											value={slug}
											onChange={(event) =>
												setSlug(event.target.value)
											}
										/>
									</div>
								</div>
								<div className="space-y-2">
									<Label htmlFor={`${id}-purpose`}>
										When to use
									</Label>
									<Textarea
										id={`${id}-purpose`}
										value={description}
										maxLength={4000}
										rows={2}
										onChange={(event) =>
											setDescription(event.target.value)
										}
									/>
								</div>
								<div className="space-y-2">
									<h3 className="text-sm font-semibold">
										Instructions
									</h3>
									<div className="max-h-64 overflow-y-auto rounded-md border border-border p-3">
										<Markdown>
											{candidate?.draft.content ?? ""}
										</Markdown>
									</div>
								</div>
								<div className="space-y-2">
									<h3 className="text-sm font-semibold">
										Runtime files ·{" "}
										{candidate?.files.length ?? 0}
									</h3>
									{candidate && (
										<SkillRuntimeFiles
											files={candidate.files}
											identity={`${organizationId}:${review.preview.source.sha256}:${candidate.key}`}
											disabled={create.isPending}
											readFile={(path) =>
												orpcClient.skills.import.readFile(
													{
														organizationId,
														source: review.source,
														candidateKey:
															candidate.key,
														expectedHash:
															review.preview
																.source.sha256,
														path,
													},
												)
											}
										/>
									)}
								</div>
								{review.preview.source.commit && (
									<p className="break-all text-xs text-muted-foreground">
										Reviewed commit:{" "}
										{review.preview.source.commit}
									</p>
								)}
							</>
						)}
						{warnings.length > 0 && (
							<Alert>
								<AlertTitle>Review before importing</AlertTitle>
								<AlertDescription>
									<ul className="list-disc space-y-1 pl-4">
										{warnings.map((warning, index) => (
											<li key={`${index}-${warning}`}>
												{warning}
											</li>
										))}
									</ul>
								</AlertDescription>
							</Alert>
						)}
						{missingCommit && (
							<Alert variant="error">
								<AlertDescription>
									The repository revision could not be
									confirmed. Preview again before creating a
									draft.
								</AlertDescription>
							</Alert>
						)}
						<p className="text-xs text-muted-foreground">
							Imported files may contain scripts. Importing or
							previewing never executes them. Review untrusted
							instructions and files before attaching the skill to
							an agent.
						</p>
					</section>
				)}
				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						disabled={create.isPending}
						onClick={onClose}
					>
						Cancel
					</Button>
					<Button
						type="button"
						loading={create.isPending}
						disabled={
							created ||
							!!unconfirmedCreate ||
							!review ||
							!candidate ||
							missingCommit ||
							create.isPending ||
							!name.trim() ||
							!description.trim() ||
							!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)
						}
						onClick={() => create.mutate()}
					>
						Create draft
					</Button>
				</DialogFooter>
				{unconfirmedCreate && (
					<SkillCreationRecovery
						organizationId={organizationId}
						attempt={unconfirmedCreate}
						onReviewed={() => {
							setUnconfirmedCreate(undefined);
							create.reset();
						}}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}
