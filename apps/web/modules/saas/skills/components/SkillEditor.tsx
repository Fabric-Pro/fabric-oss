"use client";
import { skillCreateSchema } from "@repo/ai/skill-contracts";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { PuzzleIcon } from "@saas/shared/components/icons/PuzzleIcon";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ui/components/alert-dialog";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { Markdown } from "@ui/components/markdown";
import { Textarea } from "@ui/components/textarea";
import { MessagesSquareIcon, XIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import {
	EMPTY_SKILL_DRAFT,
	type SkillDetail,
	type SkillDraft,
	skillAvailabilityLabel,
	skillListReturnHref,
	skillSlug,
	skillUiError,
} from "../lib/skill-ui";
import { SkillAssistant } from "./SkillAssistant";
import { SkillAvailability } from "./SkillAvailability";
import {
	type SkillCreateAttempt,
	SkillCreationRecovery,
} from "./SkillCreationRecovery";
import { SkillDeleteAction } from "./SkillDeleteAction";
import { SkillRuntimeFiles } from "./SkillRuntimeFiles";

function draftFor(skill: SkillDetail): SkillDraft {
	return {
		name: skill.name,
		slug: skill.slug,
		description: skill.description,
		content: skill.content,
		category: skill.category ?? undefined,
		tags: skill.tags,
	};
}
export function SkillEditor(props: {
	skill?: SkillDetail;
	initialDraft?: SkillDraft;
	mode?: "scratch" | "conversation";
	copiedFiles?: boolean;
	returnTo?: string;
}) {
	const { organizationId } = useOrganizationContext();
	if (!organizationId) {
		return (
			<p className="text-sm text-muted-foreground">
				Select an organization to author a skill.
			</p>
		);
	}
	return (
		<SkillEditorForm
			key={`${organizationId}:${props.skill?.id ?? "new"}`}
			{...props}
			organizationId={organizationId}
		/>
	);
}
function SkillEditorForm({
	organizationId,
	skill,
	initialDraft,
	mode = "scratch",
	copiedFiles = false,
	returnTo,
}: {
	organizationId: string;
	skill?: SkillDetail;
	initialDraft?: SkillDraft;
	mode?: "scratch" | "conversation";
	copiedFiles?: boolean;
	returnTo?: string;
}) {
	const id = useId();
	const router = useRouter();
	const cache = useQueryClient();
	const { basePath } = useOrganizationContext();
	const returnHref = skillListReturnHref(basePath, returnTo);
	const initial = skill
		? draftFor(skill)
		: (initialDraft ?? EMPTY_SKILL_DRAFT);
	const [draft, setDraft] = useState<SkillDraft>(initial);
	const [base, setBase] = useState(JSON.stringify(initial));
	const [baseVersion, setBaseVersion] = useState(skill?.version);
	const [tagText, setTagText] = useState(initial.tags.join(", "));
	const [manualSlug, setManualSlug] = useState(!!skill || !!initialDraft);
	const [assistantOpen, setAssistantOpen] = useState(mode === "conversation");
	const [leave, setLeave] = useState<"close" | "reload">();
	const [createdId, setCreatedId] = useState<string>();
	const confirmedCreate = useRef<string | undefined>(undefined);
	const attemptedCreate = useRef<SkillCreateAttempt | undefined>(undefined);
	const [unconfirmedCreate, setUnconfirmedCreate] =
		useState<SkillCreateAttempt>();
	const tags = tagText
		.split(",")
		.map((tag) => tag.trim())
		.filter(Boolean);
	const values: SkillDraft = {
		...draft,
		category: draft.category?.trim() || undefined,
		tags,
	};
	const fingerprint = JSON.stringify(values);
	const dirty = fingerprint !== base;
	const changed = !!skill && skill.version !== baseVersion;
	const governance = useQuery({
		queryKey: ["skill-governance", organizationId],
		queryFn: () => orpcClient.skills.governance.get({ organizationId }),
		retry: false,
	});
	const canEdit = skill
		? skill.capabilities.canEdit && !skill.archivedAt
		: governance.data?.capabilities.canCreate === true;
	const valid = skillCreateSchema.safeParse({
		...values,
		isPublished: false,
		isDiscoverable: false,
	});
	function loadCurrent() {
		if (!skill) {
			return;
		}
		const next = draftFor(skill);
		setDraft(next);
		setTagText(next.tags.join(", "));
		setBase(JSON.stringify(next));
		setBaseVersion(skill.version);
	}
	useEffect(() => {
		if (skill && !dirty && skill.version !== baseVersion) {
			loadCurrent();
		}
	}, [skill, dirty, baseVersion]);
	useEffect(() => {
		if (!dirty) {
			return;
		}
		const handler = (event: BeforeUnloadEvent) => {
			event.preventDefault();
			event.returnValue = "";
		};
		window.addEventListener("beforeunload", handler);
		return () => window.removeEventListener("beforeunload", handler);
	}, [dirty]);
	const save = useMutation({
		mutationFn: () => {
			if (skill) {
				return orpcClient.skills.update({
					organizationId,
					id: skill.id,
					expectedVersion: baseVersion,
					...values,
					category: values.category ?? null,
				});
			}
			if (unconfirmedCreate || confirmedCreate.current) {
				throw new Error(
					"Review the previous save before creating another draft.",
				);
			}
			attemptedCreate.current = { name: values.name, slug: values.slug };
			return orpcClient.skills.create({
				organizationId,
				...values,
				isPublished: false,
				isDiscoverable: false,
			});
		},
		retry: false,
		onSuccess: async (result) => {
			if (!skill) {
				confirmedCreate.current = result.skill.id;
				setCreatedId(result.skill.id);
			}
			const next = draftFor(result.skill);
			setDraft(next);
			setTagText(next.tags.join(", "));
			setBase(JSON.stringify(next));
			setBaseVersion(result.skill.version);
			cache.setQueryData(
				["skills", organizationId, "detail", result.skill.id],
				result,
			);
			await cache.invalidateQueries({
				queryKey: ["skills", organizationId],
			});
			toast.success(
				skill ? "Skill saved" : "Private skill draft created",
			);
			if (!skill) {
				setCreatedId(result.skill.id);
				router.replace(
					`${basePath}/skills/${encodeURIComponent(result.skill.id)}/edit`,
				);
			}
		},
		onError: () => {
			if (!skill && !confirmedCreate.current && attemptedCreate.current) {
				setUnconfirmedCreate(attemptedCreate.current);
			}
		},
	});
	const close = () => {
		if (dirty) {
			setLeave("close");
		} else {
			router.push(returnHref);
		}
	};
	return (
		<div
			className="mx-auto w-full max-w-5xl space-y-6 pb-6"
			data-onboarding-target="skill-editor"
		>
			<div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
				<div className="flex min-w-0 items-center gap-3">
					<PuzzleIcon
						className="size-6 shrink-0 text-primary"
						aria-hidden="true"
					/>
					<div className="min-w-0">
						<h1 className="truncate text-xl font-semibold">
							{skill ? `Edit ${skill.name}` : "Create skill"}
						</h1>
						<p className="text-sm text-muted-foreground">
							{skill
								? skillAvailabilityLabel(skill.availability)
								: "Your draft · Private within this organization"}
						</p>
					</div>
				</div>
				<div className="flex items-center gap-2">
					{skill && (
						<SkillDeleteAction
							skill={skill}
							organizationId={organizationId}
							disabled={dirty || save.isPending}
							onDeleted={() => router.push(returnHref)}
						/>
					)}
					<Button
						type="button"
						size="sm"
						variant="outline"
						disabled={!governance.data?.capabilities.canCreate}
						onClick={() => setAssistantOpen(true)}
					>
						<MessagesSquareIcon className="size-4" />
						Ask Fabric
					</Button>
					<Button
						type="button"
						variant="ghost"
						size="icon"
						aria-label="Close skill editor"
						disabled={save.isPending}
						onClick={close}
					>
						<XIcon className="size-4" />
					</Button>
				</div>
			</div>
			{copiedFiles && (
				<Alert>
					<AlertTitle>
						Instructions copied as a starting point
					</AlertTitle>
					<AlertDescription>
						Runtime files and resource permissions are not copied.
						Import the full skill bundle if its instructions depend
						on attached files.
					</AlertDescription>
				</Alert>
			)}
			{!canEdit && !governance.isPending && (
				<Alert>
					<AlertTitle>Editing is not available</AlertTitle>
					<AlertDescription>
						{governance.isError
							? "Authoring permissions could not be checked. Your current draft is preserved."
							: "Your role, ownership, skill state, or organization policy does not allow editing this skill."}
					</AlertDescription>
				</Alert>
			)}
			{changed && dirty && (
				<Alert>
					<AlertTitle>
						This skill changed while you were editing
					</AlertTitle>
					<AlertDescription>
						Your edits are preserved. Load the current version
						before saving further changes.
						<Button
							type="button"
							variant="link"
							size="sm"
							onClick={() => setLeave("reload")}
						>
							Load current version
						</Button>
					</AlertDescription>
				</Alert>
			)}
			<form
				className="space-y-6"
				onSubmit={(event) => {
					event.preventDefault();
					if (
						valid.success &&
						canEdit &&
						!changed &&
						!unconfirmedCreate &&
						!save.isPending
					) {
						save.mutate();
					}
				}}
			>
				<section className="space-y-5" aria-label="Skill instructions">
					<div className="space-y-2">
						<Label
							htmlFor={`${id}-purpose`}
							className="text-base font-semibold"
						>
							When to use this skill
						</Label>
						<p className="text-sm text-muted-foreground">
							Describe the tasks it helps with, the context it
							needs, and when an agent should choose it.
						</p>
						<Textarea
							id={`${id}-purpose`}
							rows={3}
							value={draft.description}
							maxLength={4000}
							required
							disabled={!canEdit}
							onChange={(event) =>
								setDraft((previous) => ({
									...previous,
									description: event.target.value,
								}))
							}
							placeholder="Use this skill when preparing a project delivery update with progress, evidence, risks and next steps."
						/>
					</div>
					<div className="space-y-2">
						<Label
							htmlFor={`${id}-instructions`}
							className="text-base font-semibold"
						>
							Instructions
						</Label>
						<p className="text-sm text-muted-foreground">
							Write the process, examples, and checks an agent
							should follow. Markdown is supported.
						</p>
						<Textarea
							id={`${id}-instructions`}
							rows={16}
							value={draft.content}
							maxLength={200000}
							required
							disabled={!canEdit}
							onChange={(event) =>
								setDraft((previous) => ({
									...previous,
									content: event.target.value,
								}))
							}
							placeholder="Describe the steps and expected outcome…"
						/>
						<details className="text-sm">
							<summary className="cursor-pointer font-medium">
								Preview formatting
							</summary>
							<div className="mt-3 rounded-md border border-border p-4">
								<Markdown>
									{draft.content ||
										"Add instructions to preview their formatting."}
								</Markdown>
							</div>
						</details>
					</div>
				</section>
				<section className="space-y-3 border-t border-border pt-5">
					<Label
						htmlFor={`${id}-name`}
						className="text-base font-semibold"
					>
						Skill name
					</Label>
					<Input
						id={`${id}-name`}
						value={draft.name}
						maxLength={200}
						required
						disabled={!canEdit}
						onChange={(event) => {
							const value = event.target.value;
							setDraft((previous) => ({
								...previous,
								name: value,
								...(!manualSlug
									? { slug: skillSlug(value) }
									: {}),
							}));
						}}
						placeholder="Delivery update"
					/>
					<p className="text-xs text-muted-foreground">
						Choose a short name your team can recognize.
					</p>
				</section>
				<details className="space-y-3 border-t border-border pt-5">
					<summary className="cursor-pointer text-sm font-semibold">
						Details and organization
					</summary>
					<div className="mt-4 grid gap-4 sm:grid-cols-2">
						<div className="space-y-2">
							<Label htmlFor={`${id}-slug`}>Identifier</Label>
							<Input
								id={`${id}-slug`}
								value={draft.slug}
								maxLength={100}
								disabled={!canEdit}
								onChange={(event) => {
									setManualSlug(true);
									setDraft((previous) => ({
										...previous,
										slug: event.target.value,
									}));
								}}
							/>
							<p className="text-xs text-muted-foreground">
								Lowercase letters, numbers, and hyphens. Used by
								agents, APIs, and the CLI.
							</p>
						</div>
						<div className="space-y-2">
							<Label htmlFor={`${id}-category`}>
								Category (optional)
							</Label>
							<Input
								id={`${id}-category`}
								value={draft.category ?? ""}
								maxLength={100}
								disabled={!canEdit}
								onChange={(event) =>
									setDraft((previous) => ({
										...previous,
										category: event.target.value,
									}))
								}
							/>
						</div>
						<div className="space-y-2 sm:col-span-2">
							<Label htmlFor={`${id}-tags`}>
								Tags (optional)
							</Label>
							<Input
								id={`${id}-tags`}
								value={tagText}
								maxLength={1400}
								disabled={!canEdit}
								onChange={(event) =>
									setTagText(event.target.value)
								}
								placeholder="delivery, reporting"
							/>
							<p className="text-xs text-muted-foreground">
								Separate tags with commas. Up to 20 tags, 64
								characters each.
							</p>
						</div>
					</div>
				</details>
				<section className="space-y-3 border-t border-border pt-5">
					<h2 className="text-base font-semibold">Runtime files</h2>
					{skill ? (
						<SkillRuntimeFiles
							files={skill.files}
							complete={skill.fileManifestComplete}
							identity={`${organizationId}:${skill.id}:${skill.version}`}
							readFile={(path) =>
								orpcClient.skills.files.read({
									organizationId,
									id: skill.id,
									path,
									expectedVersion: skill.version,
								})
							}
						/>
					) : (
						<p className="text-sm text-muted-foreground">
							Import a skill bundle to include runtime templates,
							schemas, scripts, or references.
						</p>
					)}
					<p className="text-xs text-muted-foreground">
						Skills provide instructions and files. Connect knowledge
						and tools when configuring the agent; the skill itself
						does not grant source access or credentials.
					</p>
				</section>
				{!skill && (
					<section className="space-y-2 border-t border-border pt-5">
						<h2 className="text-base font-semibold">
							Availability
						</h2>
						<Badge variant="outline">Your draft</Badge>
						<p className="text-sm text-muted-foreground">
							Save your draft before sharing it with members or
							enabling agent discovery. Only you can access the
							draft.
						</p>
					</section>
				)}
				{createdId && (
					<output className="block text-sm text-muted-foreground">
						Draft saved. Opening the editor…
					</output>
				)}
				{save.isError && (
					<Alert variant="error">
						<AlertTitle>Skill was not saved</AlertTitle>
						<AlertDescription>
							{skillUiError(save.error)}
						</AlertDescription>
					</Alert>
				)}
				{unconfirmedCreate && (
					<SkillCreationRecovery
						organizationId={organizationId}
						attempt={unconfirmedCreate}
						onReviewed={() => {
							setUnconfirmedCreate(undefined);
							save.reset();
						}}
					/>
				)}
				{!valid.success && dirty && (
					<p className="text-xs text-muted-foreground">
						Add a name, purpose and instructions, and check the
						identifier and tag limits before saving.
					</p>
				)}
				<div className="sticky bottom-0 flex flex-wrap justify-between gap-3 border-t border-border bg-background py-4">
					<Button
						type="button"
						variant="outline"
						disabled={save.isPending}
						onClick={close}
					>
						Cancel
					</Button>
					<Button
						type="submit"
						loading={save.isPending}
						disabled={
							!canEdit ||
							!valid.success ||
							save.isPending ||
							changed ||
							(!dirty && !!skill) ||
							!!createdId ||
							!!unconfirmedCreate
						}
					>
						{skill ? "Save changes" : "Save draft"}
					</Button>
				</div>
			</form>
			{skill && (
				<SkillAvailability
					key={`${skill.id}:${skill.version}`}
					skill={skill}
					organizationId={organizationId}
					dirty={dirty}
				/>
			)}
			<SkillAssistant
				organizationId={organizationId}
				open={assistantOpen}
				onOpenChange={setAssistantOpen}
				draft={values}
				canCreate={governance.data?.capabilities.canCreate === true}
				checkingPermissions={governance.isPending}
				onApply={(value) => {
					setDraft(value);
					setTagText(value.tags.join(", "));
					setManualSlug(true);
				}}
			/>
			<AlertDialog
				open={!!leave}
				onOpenChange={(open) => {
					if (!open) {
						setLeave(undefined);
					}
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							Discard unsaved changes?
						</AlertDialogTitle>
						<AlertDialogDescription>
							{leave === "reload"
								? "Your current edits will be replaced by the latest saved version."
								: "Your latest edits have not been saved. Leaving will discard them."}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Keep editing</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								if (leave === "reload") {
									loadCurrent();
								} else {
									router.push(returnHref);
								}
								setLeave(undefined);
							}}
						>
							Discard changes
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
