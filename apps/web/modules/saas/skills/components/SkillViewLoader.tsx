"use client";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import { Skeleton } from "@ui/components/skeleton";
import { skillReadCanRetry, skillUiError } from "../lib/skill-ui";
import { SkillViewer } from "./SkillViewer";
export function SkillViewLoader({
	skillId,
	embedded = false,
	returnTo,
	onDeleted,
}: {
	skillId: string;
	embedded?: boolean;
	returnTo?: string;
	onDeleted?: () => void;
}) {
	const { organizationId } = useOrganizationContext();
	const query = useQuery({
		queryKey: ["skills", organizationId, "detail", skillId],
		queryFn: () =>
			orpcClient.skills.get({
				organizationId: organizationId ?? undefined,
				id: skillId,
			}),
		enabled: !!organizationId,
		retry: false,
	});
	if (query.isError) {
		return (
			<Alert variant="error">
				<AlertDescription>
					{skillUiError(query.error)}
					{skillReadCanRetry(query.error) && (
						<Button
							type="button"
							variant="link"
							size="sm"
							disabled={query.isFetching}
							onClick={() => void query.refetch()}
						>
							Retry
						</Button>
					)}
				</AlertDescription>
			</Alert>
		);
	}
	if (query.isPending) {
		return <Skeleton className="h-52 w-full" />;
	}
	return (
		<SkillViewer
			skill={query.data.skill}
			embedded={embedded}
			returnTo={returnTo}
			onDeleted={onDeleted}
		/>
	);
}
