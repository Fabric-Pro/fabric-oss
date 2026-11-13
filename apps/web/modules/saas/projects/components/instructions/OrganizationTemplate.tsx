"use client";

import { useInstructionActionError } from "@saas/projects/hooks/use-instruction-action-error";
import type { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";

type TemplateApplyResult = Awaited<
	ReturnType<typeof orpcClient.projects.instructions.applyTemplate>
>;

type SkipReason = TemplateApplyResult["skipped"][number]["reason"];

const SKIP_REASON_LABEL: Record<
	SkipReason,
	| "reasonExists"
	| "reasonTreeConflict"
	| "reasonExcluded"
	| "reasonIgnoreFile"
	| "reasonSecretName"
	| "reasonInvalidPath"
	| "reasonNonPortable"
	| "reasonTooLarge"
> = {
	exists: "reasonExists",
	tree_conflict: "reasonTreeConflict",
	excluded: "reasonExcluded",
	ignore_file: "reasonIgnoreFile",
	secret_name: "reasonSecretName",
	invalid_path: "reasonInvalidPath",
	non_portable: "reasonNonPortable",
	too_large: "reasonTooLarge",
};

/**
 * The organization template for this project's coding instructions: whether
 * one can be added, the action that adds it, and the dialog that reports what
 * was added and what was left out.
 *
 * `enabled` is the tab's own gate — a viewer who may upload, on a project
 * whose instructions are uploaded to Fabric — so a reader never asks. The
 * template project itself is never offered its own files. Once a version is
 * created, `onApplied` re-reads the tab, whose checking status then follows
 * it like any upload.
 */
export function useOrganizationTemplate({
	projectId,
	enabled,
	onApplied,
}: {
	projectId: string;
	enabled: boolean;
	onApplied: () => void;
}): {
	action: { pending: boolean; onApply: () => void } | undefined;
	dialog: ReactNode;
} {
	const actionError = useInstructionActionError();
	const [result, setResult] = useState<TemplateApplyResult | null>(null);
	const status = useQuery({
		...orpc.projects.instructions.templateStatus.queryOptions({
			input: { projectId },
		}),
		enabled,
	});
	const apply = useMutation(
		orpc.projects.instructions.applyTemplate.mutationOptions({
			onSuccess: (data) => {
				setResult(data);
				if (data.snapshotId !== null) {
					onApplied();
				}
			},
			onError: (error) => toast.error(actionError(error)),
		}),
	);
	const available = enabled && status.data?.available === true;
	return {
		action: available
			? {
					pending: apply.isPending,
					onApply: () => apply.mutate({ projectId }),
				}
			: undefined,
		dialog: (
			<TemplateResultDialog
				result={result}
				onOpenChange={(open) => {
					if (!open) {
						setResult(null);
					}
				}}
			/>
		),
	};
}

export function TemplateResultDialog({
	result,
	onOpenChange,
}: {
	result: TemplateApplyResult | null;
	onOpenChange: (open: boolean) => void;
}) {
	const t = useTranslations(
		"projects.codingInstructions.organizationTemplate",
	);
	return (
		<Dialog open={result !== null} onOpenChange={onOpenChange}>
			<DialogContent className="grid-cols-[minmax(0,1fr)]">
				<DialogHeader>
					<DialogTitle>{t("resultTitle")}</DialogTitle>
					<DialogDescription>
						{result && result.version !== null
							? t("resultAdded", {
									count: result.added,
									version: result.version,
								})
							: t("resultNothingAdded")}
					</DialogDescription>
				</DialogHeader>
				{result && result.skipped.length > 0 ? (
					<div className="flex flex-col gap-2">
						<h3 className="font-medium text-sm">
							{t("skippedHeading", {
								count: result.skipped.length,
							})}
						</h3>
						<ul className="max-h-64 divide-y overflow-y-auto rounded-md border bg-muted/40 text-sm">
							{result.skipped.map((skip) => (
								<li
									key={skip.path}
									className="flex flex-col gap-0.5 px-3 py-2 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4"
								>
									<code className="break-all font-mono text-xs">
										{skip.path}
									</code>
									<span className="shrink-0 text-muted-foreground text-xs">
										{t(SKIP_REASON_LABEL[skip.reason])}
									</span>
								</li>
							))}
						</ul>
					</div>
				) : null}
				<DialogFooter>
					<Button onClick={() => onOpenChange(false)}>
						{t("doneButton")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
