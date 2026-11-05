"use client";
import type {
	SkillGovernancePolicy,
	SkillGovernanceResult,
} from "@repo/ai/skill-contracts";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { SettingsHero } from "@saas/settings/components/SettingsHero";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Skeleton } from "@ui/components/skeleton";
import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { skillUiError } from "../lib/skill-ui";

const ROWS = [
	{
		key: "create",
		title: "Create skills",
		description:
			"Who may create private skill drafts, including assisted drafts and imports.",
	},
	{
		key: "publish",
		title: "Share skills with members",
		description:
			"Who may make their skill instructions and files available to the organization.",
	},
	{
		key: "discover",
		title: "Make skills discoverable to agents",
		description:
			"Who may allow eligible agents to find a shared skill automatically.",
	},
] as const;
export function SkillGovernanceSettings({
	organizationId,
}: {
	organizationId: string;
}) {
	const query = useQuery({
		queryKey: ["skill-governance", organizationId],
		queryFn: () => orpcClient.skills.governance.get({ organizationId }),
		retry: false,
	});
	return (
		<div className="space-y-6" data-onboarding-target="skill-governance">
			<SettingsHero
				title="Skill governance"
				description="Decide who can create, share, and enable discovery for your organization’s skills."
			/>
			{query.isError ? (
				<Alert variant="error">
					<AlertTitle>Policy could not be loaded</AlertTitle>
					<AlertDescription>
						{skillUiError(query.error)}
						<Button
							type="button"
							variant="link"
							size="sm"
							onClick={() => void query.refetch()}
						>
							Try again
						</Button>
					</AlertDescription>
				</Alert>
			) : query.isPending ? (
				<Skeleton className="h-52 w-full" />
			) : (
				<SkillPolicyForm
					organizationId={organizationId}
					current={query.data}
				/>
			)}
		</div>
	);
}
function SkillPolicyForm({
	organizationId,
	current,
}: {
	organizationId: string;
	current: SkillGovernanceResult;
}) {
	const id = useId();
	const cache = useQueryClient();
	const { basePath } = useOrganizationContext();
	const [draft, setDraft] = useState(current.policy);
	const [base, setBase] = useState(current.policy);
	const [revision, setRevision] = useState(current.revision);
	const dirty = JSON.stringify(draft) !== JSON.stringify(base);
	const changed = current.revision !== revision;
	useEffect(() => {
		if (!dirty && current.revision !== revision) {
			setDraft(current.policy);
			setBase(current.policy);
			setRevision(current.revision);
		}
	}, [current, dirty, revision]);
	const mutation = useMutation({
		mutationFn: () =>
			orpcClient.skills.governance.update({
				organizationId,
				expectedRevision: revision,
				policy: draft,
			}),
		retry: false,
		onSuccess: async (result) => {
			setDraft(result.policy);
			setBase(result.policy);
			setRevision(result.revision);
			cache.setQueryData(["skill-governance", organizationId], result);
			await cache.invalidateQueries({
				queryKey: ["skills", organizationId],
			});
			toast.success("Skill governance saved");
		},
	});
	const reset = () => {
		setDraft(current.policy);
		setBase(current.policy);
		setRevision(current.revision);
		mutation.reset();
	};
	return (
		<div className="space-y-6">
			<section
				className="divide-y divide-border rounded-lg border border-border bg-card px-5"
				aria-label="Skill permissions"
			>
				{ROWS.map((row) => (
					<div
						key={row.key}
						className="grid gap-4 py-5 sm:grid-cols-2 sm:items-center"
					>
						<div className="space-y-1">
							<Label
								htmlFor={`${id}-${row.key}`}
								className="text-sm font-semibold"
							>
								{row.title}
							</Label>
							<p className="text-sm text-muted-foreground">
								{row.description}
							</p>
						</div>
						<Select
							value={draft[row.key]}
							onValueChange={(value) =>
								setDraft((previous) => ({
									...previous,
									[row.key]:
										value as SkillGovernancePolicy[typeof row.key],
								}))
							}
							disabled={!current.canManage || mutation.isPending}
						>
							<SelectTrigger id={`${id}-${row.key}`}>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="permitted_members">
									All permitted members
								</SelectItem>
								<SelectItem value="administrators">
									Admins only
								</SelectItem>
							</SelectContent>
						</Select>
					</div>
				))}
			</section>
			<p className="text-sm text-muted-foreground">
				These settings restrict the permissions of current organization
				roles. They do not grant new permissions, data access, or
				credentials.
			</p>
			{!current.canManage && (
				<p className="text-sm text-muted-foreground">
					Only organization owners and admins can update this policy.
				</p>
			)}
			{changed && dirty && (
				<Alert>
					<AlertTitle>
						The policy changed while you were editing
					</AlertTitle>
					<AlertDescription>
						Your choices are preserved. Cancel to load the current
						policy before making another change.
					</AlertDescription>
				</Alert>
			)}
			{mutation.isError && (
				<Alert variant="error">
					<AlertTitle>Policy was not saved</AlertTitle>
					<AlertDescription>
						{skillUiError(mutation.error)}
					</AlertDescription>
				</Alert>
			)}
			{current.canManage && (
				<div className="flex flex-wrap items-center gap-3">
					<Button
						type="button"
						loading={mutation.isPending}
						disabled={!dirty || changed || mutation.isPending}
						onClick={() => mutation.mutate()}
					>
						Save policy
					</Button>
					<Button
						type="button"
						variant="outline"
						disabled={!dirty || mutation.isPending}
						onClick={reset}
					>
						Cancel
					</Button>
				</div>
			)}
			<section className="space-y-2 border-t border-border pt-5">
				<h2 className="text-base font-semibold">
					Agent creation and data access
				</h2>
				<p className="text-sm text-muted-foreground">
					Agent creation continues to follow organization roles.
					Manage those roles in{" "}
					<Link
						className="underline underline-offset-4"
						href={`${basePath}/settings/members`}
					>
						Members
					</Link>
					.
				</p>
				<p className="text-sm text-muted-foreground">
					Publishing a skill does not grant access to workspace
					documents, project context, or connected tools. Fabric
					checks the caller’s permissions when those resources are
					used.
				</p>
			</section>
		</div>
	);
}
