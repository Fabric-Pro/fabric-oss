"use client";

import type { AdoStoryReviewConfig } from "@repo/temporal/ado-story-review-config";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Textarea } from "@ui/components/textarea";
import { useId, useState } from "react";
import { useDebounceValue } from "usehooks-ts";

interface Props {
	agentId: string;
	skills: AdoStoryReviewConfig["skills"];
	onAgentChange: (id: string | undefined) => void;
	onSkillsChange: (skills: AdoStoryReviewConfig["skills"]) => void;
}

const PAGE_SIZE = 20;

export function AdoReviewInstructionFields({
	agentId,
	skills,
	onAgentChange,
	onSkillsChange,
}: Props) {
	const id = useId();
	const { organizationId } = useOrganizationContext();
	const [agentSearch, setAgentSearch] = useState("");
	const [agentOffset, setAgentOffset] = useState(0);
	const [skillSearch, setSkillSearch] = useState("");
	const [skillOffset, setSkillOffset] = useState(0);
	const [debouncedAgentSearch] = useDebounceValue(agentSearch, 300);
	const [debouncedSkillSearch] = useDebounceValue(skillSearch, 300);
	const agents = useQuery({
		...orpc.agentTemplates.instances.list.queryOptions({
			input: {
				organizationId,
				status: "ACTIVE",
				latestVersionOnly: true,
				search: debouncedAgentSearch || undefined,
				limit: PAGE_SIZE,
				offset: agentOffset,
			},
		}),
		enabled: Boolean(organizationId),
	});
	const catalog = useQuery({
		...orpc.skills.list.queryOptions({
			input: {
				organizationId,
				isPublished: true,
				search: debouncedSkillSearch || undefined,
				limit: PAGE_SIZE,
				offset: skillOffset,
			},
		}),
		enabled: Boolean(organizationId),
	});
	const instances = (agents.data?.instances ?? []).filter(
		(instance) => instance.organizationId === organizationId,
	);
	const availableSkills = (catalog.data?.skills ?? []).filter(
		(skill) =>
			(skill.scope === "SYSTEM" ||
				skill.organizationId === organizationId) &&
			!skills.some((selected) => selected.slug === skill.slug),
	);

	return (
		<fieldset className="space-y-4 rounded-md border p-3">
			<legend className="px-1 text-sm font-medium">
				Review instructions
			</legend>
			<p className="text-xs text-muted-foreground">
				Agent selections reuse instructions and model preferences only.
				They do not invoke agent tools or a remote agent. Skills load
				SKILL.md and the text files you select.
			</p>
			<div className="space-y-2">
				<Label htmlFor={`${id}-agent-search`}>
					Find agent instructions
				</Label>
				<Input
					id={`${id}-agent-search`}
					value={agentSearch}
					onChange={(event) => {
						setAgentSearch(event.target.value);
						setAgentOffset(0);
					}}
				/>
				<Label htmlFor={`${id}-agent`}>
					Agent instructions and model (optional)
				</Label>
				<Select
					value={agentId || "none"}
					onValueChange={(value) =>
						onAgentChange(value === "none" ? undefined : value)
					}
				>
					<SelectTrigger id={`${id}-agent`}>
						<SelectValue placeholder="No agent instructions" />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="none">
							No agent instructions
						</SelectItem>
						{agentId &&
							!instances.some(
								(instance) => instance.id === agentId,
							) && (
								<SelectItem value={agentId}>
									Saved instance: {agentId}
								</SelectItem>
							)}
						{instances.map((instance) => (
							<SelectItem key={instance.id} value={instance.id}>
								{instance.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				{agents.isLoading && (
					<p role="status" className="text-xs text-muted-foreground">
						Loading agent instructions…
					</p>
				)}
				{agents.isError && (
					<p role="alert" className="text-xs text-destructive">
						Agent instructions could not be loaded.
					</p>
				)}
				<div className="flex gap-2">
					<Button
						type="button"
						size="sm"
						variant="outline"
						disabled={agentOffset === 0 || agents.isFetching}
						onClick={() =>
							setAgentOffset(Math.max(0, agentOffset - PAGE_SIZE))
						}
					>
						Previous agents
					</Button>
					<Button
						type="button"
						size="sm"
						variant="outline"
						disabled={!agents.data?.hasMore || agents.isFetching}
						onClick={() => setAgentOffset(agentOffset + PAGE_SIZE)}
					>
						Next agents
					</Button>
				</div>
			</div>
			<div className="space-y-2">
				<Label htmlFor={`${id}-skill-search`}>
					Find published skills
				</Label>
				<Input
					id={`${id}-skill-search`}
					value={skillSearch}
					onChange={(event) => {
						setSkillSearch(event.target.value);
						setSkillOffset(0);
					}}
				/>
				<Label htmlFor={`${id}-skill`}>
					Add published skill (up to 5)
				</Label>
				<Select
					value=""
					disabled={skills.length >= 5}
					onValueChange={(slug) =>
						onSkillsChange([...skills, { slug, textFiles: [] }])
					}
				>
					<SelectTrigger id={`${id}-skill`}>
						<SelectValue placeholder="Select a published skill" />
					</SelectTrigger>
					<SelectContent>
						{availableSkills.map((skill) => (
							<SelectItem key={skill.id} value={skill.slug}>
								{skill.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				{catalog.isLoading && (
					<p role="status" className="text-xs text-muted-foreground">
						Loading published skills…
					</p>
				)}
				{catalog.isError && (
					<p role="alert" className="text-xs text-destructive">
						Published skills could not be loaded.
					</p>
				)}
				<div className="flex gap-2">
					<Button
						type="button"
						size="sm"
						variant="outline"
						disabled={skillOffset === 0 || catalog.isFetching}
						onClick={() =>
							setSkillOffset(Math.max(0, skillOffset - PAGE_SIZE))
						}
					>
						Previous skills
					</Button>
					<Button
						type="button"
						size="sm"
						variant="outline"
						disabled={!catalog.data?.hasMore || catalog.isFetching}
						onClick={() => setSkillOffset(skillOffset + PAGE_SIZE)}
					>
						Next skills
					</Button>
				</div>
			</div>
			{skills.map((skill, index) => (
				<div key={skill.slug} className="space-y-2 border-t pt-3">
					<div className="flex items-center justify-between gap-2">
						<span className="break-all text-sm">{skill.slug}</span>
						<Button
							type="button"
							variant="outline"
							size="sm"
							aria-label={`Remove skill ${skill.slug}`}
							onClick={() =>
								onSkillsChange(
									skills.filter(
										(item) => item.slug !== skill.slug,
									),
								)
							}
						>
							Remove
						</Button>
					</div>
					<Label htmlFor={`${id}-files-${index}`}>
						Additional text file paths for {skill.slug}
					</Label>
					<Textarea
						id={`${id}-files-${index}`}
						rows={2}
						value={skill.textFiles.join("\n")}
						onChange={(event) =>
							onSkillsChange(
								skills.map((item) =>
									item.slug === skill.slug
										? {
												...item,
												textFiles: event.target.value
													? event.target.value.split(
															"\n",
														)
													: [],
											}
										: item,
								),
							)
						}
					/>
					<p className="text-xs text-muted-foreground">
						Optional, one path per line; clear the field to load
						SKILL.md only. Use .md, .txt, .json, .yaml, .yml or .csv
						files from this published skill. Paths and size limits
						are checked before activation. Scripts and binary files
						are excluded.
					</p>
				</div>
			))}
		</fieldset>
	);
}
