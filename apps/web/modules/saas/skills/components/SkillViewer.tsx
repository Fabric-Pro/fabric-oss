"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { ArrowLeftIcon, PencilIcon } from "lucide-react";
import { useRouter } from "next/navigation";

interface SkillViewerProps {
	skill: {
		id: string;
		slug: string;
		name: string;
		description: string;
		content: string;
		category: string | null;
		tags: string[];
		scope: string;
	};
}

export function SkillViewer({ skill }: SkillViewerProps) {
	const router = useRouter();
	const { basePath } = useOrganizationContext();

	const isEditable = skill.scope !== "SYSTEM";

	return (
		<div className="space-y-6 max-w-3xl">
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-3">
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						onClick={() => router.push(`${basePath}/skills`)}
					>
						<ArrowLeftIcon className="h-4 w-4" />
					</Button>
					<h1
						className="text-2xl tracking-tight"
						style={{
							fontFamily:
								"var(--font-sans, 'EB Garamond', Georgia, serif)",
							fontWeight: 400,
						}}
					>
						{skill.name}
					</h1>
				</div>
				{isEditable && (
					<Button
						variant="outline"
						onClick={() =>
							router.push(`${basePath}/skills/${skill.id}/edit`)
						}
					>
						<PencilIcon className="h-4 w-4 mr-2" />
						Edit
					</Button>
				)}
			</div>

			<div className="flex flex-wrap gap-2">
				<Badge variant="outline">
					{skill.scope === "SYSTEM"
						? "System"
						: skill.scope === "ORGANIZATION"
							? "Organization"
							: "Personal"}
				</Badge>
				{skill.category && (
					<Badge variant="secondary">{skill.category}</Badge>
				)}
				{skill.tags.map((tag) => (
					<Badge key={tag} variant="outline" className="font-normal">
						{tag}
					</Badge>
				))}
			</div>

			<div className="space-y-1">
				<p className="text-sm font-medium text-muted-foreground">
					Description
				</p>
				<p className="text-sm">{skill.description}</p>
			</div>

			<div className="space-y-1">
				<p className="text-sm font-medium text-muted-foreground">
					Slug
				</p>
				<p className="text-sm font-mono">{skill.slug}</p>
			</div>

			<div className="space-y-2">
				<p className="text-sm font-medium text-muted-foreground">
					Skill Content
				</p>
				<div className="rounded-lg border bg-muted/30 p-4">
					<pre className="whitespace-pre-wrap text-sm font-mono">
						{skill.content}
					</pre>
				</div>
			</div>
		</div>
	);
}
