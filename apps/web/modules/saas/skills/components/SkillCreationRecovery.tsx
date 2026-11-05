"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import Link from "next/link";

export type SkillCreateAttempt = { name: string; slug: string };
export function SkillCreationRecovery({
	organizationId,
	attempt,
	onReviewed,
}: {
	organizationId: string;
	attempt: SkillCreateAttempt;
	onReviewed: () => void;
}) {
	const context = useOrganizationContext();
	const sameOrganization = context.organizationId === organizationId;
	const check = useMutation({
		mutationFn: () => {
			if (!sameOrganization) {
				throw new Error(
					"Return to the organization where this save started.",
				);
			}
			return orpcClient.skills.list({
				organizationId,
				tab: "drafts",
				search: attempt.slug,
				limit: 100,
				offset: 0,
			});
		},
		retry: false,
	});
	const existing = check.data?.skills.find(
		(skill) => skill.slug === attempt.slug,
	);
	return (
		<Alert variant="error">
			<AlertTitle>Check whether your draft was saved</AlertTitle>
			<AlertDescription className="space-y-3">
				<p>
					We could not confirm the save of “{attempt.name}”. It may
					already exist. Another create is paused even if you edit the
					name or identifier.
				</p>
				{!sameOrganization ? (
					<p>
						Return to the organization where this save started to
						check your drafts.
					</p>
				) : (
					<>
						<div className="flex flex-wrap gap-2">
							<Button
								type="button"
								variant="outline"
								size="sm"
								loading={check.isPending}
								disabled={check.isPending}
								onClick={() => check.mutate()}
							>
								Check saved drafts
							</Button>
							<Button variant="link" size="sm" asChild>
								<Link
									href={`${context.basePath}/skills?tab=drafts&search=${encodeURIComponent(attempt.slug)}`}
									target="_blank"
									rel="noopener noreferrer"
								>
									Review your drafts
								</Link>
							</Button>
						</div>
						{check.isError && (
							<p>
								Drafts could not be checked. Another create
								remains paused. Check your access or try the
								read again.
							</p>
						)}
						{existing && (
							<p>
								A saved draft with this identifier is available.{" "}
								<Link
									className="underline"
									href={`${context.basePath}/skills/${encodeURIComponent(existing.id)}/edit`}
								>
									Open the existing draft
								</Link>{" "}
								before creating anything else.
							</p>
						)}
						{check.isSuccess && !existing && (
							<div className="space-y-2">
								<p>
									No matching identifier was found in the
									returned drafts.{" "}
									{check.data.hasMore
										? "More matching drafts are available; review them before continuing. "
										: ""}
									An earlier request can still finish later.
									Review your drafts before choosing another
									attempt.
								</p>
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={onReviewed}
								>
									I reviewed drafts; allow another attempt
								</Button>
							</div>
						)}
					</>
				)}
			</AlertDescription>
		</Alert>
	);
}
