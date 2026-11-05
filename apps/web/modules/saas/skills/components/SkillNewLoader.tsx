"use client";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import { Skeleton } from "@ui/components/skeleton";
import { skillReadCanRetry, skillSlug, skillUiError } from "../lib/skill-ui";
import { SkillEditor } from "./SkillEditor";
export function SkillNewLoader({
	mode = "scratch",
	sourceSkillId,
}: {
	mode?: "scratch" | "conversation";
	sourceSkillId?: string;
}) {
	const { organizationId } = useOrganizationContext();
	const source = useQuery({
		queryKey: ["skills", organizationId, "seed", sourceSkillId],
		queryFn: () =>
			orpcClient.skills.get({
				organizationId: organizationId ?? undefined,
				id: sourceSkillId ?? "",
			}),
		enabled: !!sourceSkillId && !!organizationId,
		retry: false,
	});
	if (sourceSkillId) {
		if (source.isError) {
			return (
				<Alert variant="error">
					<AlertDescription>
						{skillUiError(source.error)}
						{skillReadCanRetry(source.error) && (
							<Button
								type="button"
								variant="link"
								size="sm"
								disabled={source.isFetching}
								onClick={() => void source.refetch()}
							>
								Retry
							</Button>
						)}
					</AlertDescription>
				</Alert>
			);
		}
		if (source.isPending) {
			return <Skeleton className="h-52 w-full" />;
		}
		const skill = source.data.skill;
		const name = `${skill.name} copy`.slice(0, 200);
		return (
			<SkillEditor
				key={`${organizationId}:${sourceSkillId}`}
				mode={mode}
				initialDraft={{
					name,
					slug: skillSlug(name),
					description: skill.description,
					content: skill.content,
					category: skill.category ?? undefined,
					tags: skill.tags,
				}}
				copiedFiles={
					skill.files.length > 0 || !skill.fileManifestComplete
				}
			/>
		);
	}
	return <SkillEditor mode={mode} />;
}
