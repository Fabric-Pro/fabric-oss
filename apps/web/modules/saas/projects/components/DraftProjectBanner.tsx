"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { XIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function DraftProjectBanner() {
	const { organizationId, basePath } = useOrganizationContext();
	const router = useRouter();
	const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());

	const { data } = useQuery(
		orpc.projects.listDrafts.queryOptions({
			input: { organizationId: organizationId ?? null },
		}),
	);

	const drafts = (data?.drafts ?? []).filter((d) => !dismissedIds.has(d.id));

	if (drafts.length === 0) {
		return null;
	}

	const handleContinue = (draftId: string) => {
		// Resume directly in the unified wizard at `projects/new` (the old
		// `new/create` route now only redirects here). The wizard restores
		// currentStep from server-side wizardState on hydration — no need to
		// encode it in the URL.
		router.push(`${basePath}/projects/new?projectId=${draftId}`);
	};

	const handleDismiss = (draftId: string) => {
		setDismissedIds((prev) => new Set([...prev, draftId]));
	};

	return (
		<div className="space-y-2">
			{drafts.map((draft) => (
				<div
					key={draft.id}
					className="flex items-center justify-between rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3"
				>
					<p className="text-sm text-foreground">
						You have an unfinished draft:{" "}
						<span className="font-medium">{draft.name}</span>
					</p>
					<div className="flex items-center gap-2 ml-4 shrink-0">
						<Button
							variant="outline"
							size="sm"
							onClick={() => handleContinue(draft.id)}
						>
							Continue
						</Button>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => handleDismiss(draft.id)}
							aria-label="Dismiss"
						>
							<XIcon className="h-4 w-4" />
						</Button>
					</div>
				</div>
			))}
		</div>
	);
}
