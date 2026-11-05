"use client";
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
import { Markdown } from "@ui/components/markdown";
import { ArrowLeftIcon, PencilIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import {
	type SkillDetail,
	skillAvailabilityLabel,
	skillListReturnHref,
	skillUiError,
} from "../lib/skill-ui";
import { SkillAvailability } from "./SkillAvailability";
import { SkillDeleteAction } from "./SkillDeleteAction";
import { SkillRuntimeFiles } from "./SkillRuntimeFiles";
export function SkillViewer({
	skill,
	embedded = false,
	returnTo,
	onDeleted,
}: {
	skill: SkillDetail;
	embedded?: boolean;
	returnTo?: string;
	onDeleted?: () => void;
}) {
	const { organizationId, basePath } = useOrganizationContext();
	const returnHref = skillListReturnHref(basePath, returnTo);
	const cache = useQueryClient();
	const [confirm, setConfirm] = useState(false);
	const [deleted, setDeleted] = useState(false);
	const governance = useQuery({
		queryKey: ["skill-governance", organizationId],
		queryFn: () =>
			orpcClient.skills.governance.get({
				organizationId: organizationId ?? undefined,
			}),
		enabled: !!organizationId,
		retry: false,
	});
	const changed = async (result: { skill: SkillDetail }) => {
		setConfirm(false);
		cache.setQueryData(
			["skills", organizationId, "detail", skill.id],
			result,
		);
		await cache.invalidateQueries({ queryKey: ["skills", organizationId] });
	};
	const archive = useMutation({
		mutationFn: () =>
			orpcClient.skills.archive({
				organizationId: organizationId ?? undefined,
				id: skill.id,
				expectedVersion: skill.version,
			}),
		retry: false,
		onSuccess: async (result) => {
			await changed(result);
			toast.success("Skill archived");
		},
	});
	const restore = useMutation({
		mutationFn: () =>
			orpcClient.skills.restore({
				organizationId: organizationId ?? undefined,
				id: skill.id,
				expectedVersion: skill.version,
			}),
		retry: false,
		onSuccess: async (result) => {
			await changed(result);
			toast.success("Skill restored as your draft");
		},
	});
	const error = archive.error ?? restore.error;
	if (deleted) {
		return (
			<Alert>
				<AlertTitle>Skill permanently deleted</AlertTitle>
				<AlertDescription>
					<Button variant="link" asChild>
						<Link href={returnHref}>Back to skills</Link>
					</Button>
				</AlertDescription>
			</Alert>
		);
	}
	return (
		<div
			className="mx-auto max-w-4xl space-y-6"
			data-onboarding-target="skill-details"
		>
			<header className="space-y-4">
				<div className="flex flex-wrap items-start justify-between gap-3">
					<div className="flex min-w-0 items-center gap-3">
						{!embedded && (
							<Button
								type="button"
								variant="ghost"
								size="icon"
								aria-label="Back to skills"
								asChild
							>
								<Link href={`${basePath}/skills`}>
									<ArrowLeftIcon className="size-4" />
								</Link>
							</Button>
						)}
						<PuzzleIcon
							className="size-6 shrink-0 text-primary"
							aria-hidden="true"
						/>
						<h1 className="min-w-0 break-words text-xl font-semibold">
							{skill.name}
						</h1>
					</div>
					<div className="flex flex-wrap gap-2">
						{organizationId && (
							<SkillDeleteAction
								skill={skill}
								organizationId={organizationId}
								onDeleted={() => {
									if (onDeleted) {
										onDeleted();
									} else {
										setDeleted(true);
									}
								}}
							/>
						)}
						{skill.capabilities.canEdit && !skill.archivedAt && (
							<Button size="sm" variant="outline" asChild>
								<Link
									href={`${basePath}/skills/${encodeURIComponent(skill.id)}/edit${returnTo ? `?returnTo=${encodeURIComponent(returnHref)}` : ""}`}
								>
									<PencilIcon className="size-4" />
									Edit
								</Link>
							</Button>
						)}
						{skill.capabilities.canRestore && (
							<Button
								type="button"
								size="sm"
								variant="outline"
								loading={restore.isPending}
								onClick={() => restore.mutate()}
							>
								Restore as draft
							</Button>
						)}
						{skill.capabilities.canArchive && (
							<Button
								type="button"
								size="sm"
								variant="ghost"
								disabled={archive.isPending}
								onClick={() => setConfirm(true)}
							>
								Archive
							</Button>
						)}
					</div>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<Badge variant="outline">
						{skill.archivedAt
							? "Archived"
							: skillAvailabilityLabel(skill.availability)}
					</Badge>
					<span className="text-xs text-muted-foreground">
						Version {skill.version}
					</span>
					{skill.category && (
						<Badge variant="secondary">{skill.category}</Badge>
					)}
				</div>
			</header>
			{error && (
				<Alert variant="error">
					<AlertTitle>Skill could not be updated</AlertTitle>
					<AlertDescription>{skillUiError(error)}</AlertDescription>
				</Alert>
			)}
			<section className="space-y-2">
				<h2 className="text-base font-semibold">
					When to use this skill
				</h2>
				<p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
					{skill.description}
				</p>
			</section>
			<section className="space-y-3 border-t border-border pt-5">
				<h2 className="text-base font-semibold">Instructions</h2>
				<Markdown>{skill.content}</Markdown>
			</section>
			<section className="space-y-3 border-t border-border pt-5">
				<h2 className="text-base font-semibold">Runtime files</h2>
				<SkillRuntimeFiles
					files={skill.files}
					complete={skill.fileManifestComplete}
					identity={`${organizationId}:${skill.id}:${skill.version}`}
					readFile={(path) =>
						orpcClient.skills.files.read({
							organizationId: organizationId ?? undefined,
							id: skill.id,
							path,
							expectedVersion: skill.version,
						})
					}
				/>
				<p className="text-xs text-muted-foreground">
					Viewing a skill does not execute its files or grant resource
					credentials.
				</p>
			</section>
			{organizationId && (
				<SkillAvailability
					key={`${skill.id}:${skill.version}`}
					skill={skill}
					organizationId={organizationId}
				/>
			)}
			{governance.data?.capabilities.canCreate && (
				<section className="space-y-2 border-t border-border pt-5">
					<Button variant="outline" size="sm" asChild>
						<Link
							href={`${basePath}/skills/new?source=${encodeURIComponent(skill.id)}`}
						>
							Use instructions as a starting point
						</Link>
					</Button>
					<p className="text-xs text-muted-foreground">
						Opens a new draft editor. Runtime files and resource
						permissions are not copied.
					</p>
				</section>
			)}
			<details className="border-t border-border pt-5">
				<summary className="cursor-pointer text-sm font-medium">
					Details
				</summary>
				<dl className="mt-3 space-y-3 text-sm">
					<div>
						<dt className="font-medium">Identifier</dt>
						<dd className="break-all font-mono text-muted-foreground">
							{skill.slug}
						</dd>
					</div>
					{skill.tags.length > 0 && (
						<div>
							<dt className="font-medium">Tags</dt>
							<dd className="mt-2 flex flex-wrap gap-1">
								{skill.tags.map((tag) => (
									<Badge
										key={tag}
										variant="secondary"
										className="max-w-48 truncate font-sans"
									>
										{tag}
									</Badge>
								))}
							</dd>
						</div>
					)}
				</dl>
			</details>
			<AlertDialog open={confirm} onOpenChange={setConfirm}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Archive this skill?</AlertDialogTitle>
						<AlertDialogDescription>
							It will be removed from shared availability and
							agent discovery. Restoring it creates an owner-only
							draft; sharing it again is an explicit choice.
						</AlertDialogDescription>
					</AlertDialogHeader>
					{archive.isError && (
						<Alert variant="error">
							<AlertDescription>
								{skillUiError(archive.error)}
							</AlertDescription>
						</Alert>
					)}
					<AlertDialogFooter>
						<AlertDialogCancel disabled={archive.isPending}>
							Keep skill
						</AlertDialogCancel>
						<AlertDialogAction
							disabled={archive.isPending}
							onClick={(event) => {
								event.preventDefault();
								archive.mutate();
							}}
						>
							Archive skill
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
