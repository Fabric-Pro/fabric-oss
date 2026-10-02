"use client";

/**
 * ContextSourceDetailsDialog — Context Source Type Labeling (Fizzy #1888),
 * for a project's sources.
 *
 * Opened from each context card's menu via {@link EditSourceDetailsMenuItem}.
 * The dialog itself is the owner-agnostic `SourceDetailsDialog`; this file
 * binds it to a project: saves go through `projects.contexts.updateMetadata`,
 * which also backs the `fabric_update_project_context` MCP tool, the project's
 * contexts list is the one kept current, and the "last edited" name comes from
 * the project's member list.
 */

import {
	SourceDetailsDialog,
	type SourceDetailsDialogProps,
} from "@saas/context-sources/components/SourceDetailsDialog";
import type { ContextSourceDetailsAdapter } from "@saas/context-sources/lib/submit-adapter";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { DropdownMenuItem } from "@ui/components/dropdown-menu";
import { Settings2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo } from "react";

type ContextSourceDetailsDialogProps = Omit<
	SourceDetailsDialogProps,
	"adapter"
> & {
	projectId: string;
};

export function ContextSourceDetailsDialog({
	projectId,
	...dialogProps
}: ContextSourceDetailsDialogProps) {
	const { organizationId } = useOrganizationContext();

	const adapter = useMemo<ContextSourceDetailsAdapter>(
		() => ({
			saveMetadata: ({
				contextId,
				sourceType,
				aiInstructions,
				expected,
			}) =>
				orpcClient.projects.contexts.updateMetadata({
					contextId,
					projectId,
					organizationId,
					sourceType,
					aiInstructions,
					expected,
				}),
			listQueryKey: orpc.projects.contexts.list.queryKey({
				input: { projectId, organizationId },
			}),
			useEditorName: projectMemberNameResolver(projectId, organizationId),
		}),
		[projectId, organizationId],
	);

	return <SourceDetailsDialog adapter={adapter} {...dialogProps} />;
}

/**
 * The "last edited" name for a project's sources: a hook reading the project's
 * member list.
 *
 * Read from `projects.members.list` — the same lazy, session-cached lookup the
 * feature details popover uses (`StoryDetailsButton`) — rather than a join on
 * the context list, which would cost every Context tab load a user query for a
 * line only this dialog shows. The dialog calls it only while it is open AND
 * the source carries a stamp, so the members request fires at most once per
 * project per session and never on the list's hot path.
 *
 * The member list covers the project owner and its project members. An editor
 * whose access comes from an organization role alone is not in it; for them,
 * and while the lookup is loading or if it fails, the hook returns null and
 * the line shows the date only rather than guessing a name.
 */
function projectMemberNameResolver(
	projectId: string,
	organizationId: string | null,
): ContextSourceDetailsAdapter["useEditorName"] {
	return function useProjectMemberName(userId) {
		const { data: membersData } = useQuery({
			...orpc.projects.members.list.queryOptions({
				input: { projectId, organizationId },
			}),
			enabled: Boolean(userId),
			staleTime: Number.POSITIVE_INFINITY,
		});

		return useMemo(() => {
			if (!userId) {
				return null;
			}
			const member = membersData?.members?.find(
				(m: { userId?: string }) => m.userId === userId,
			) as { user?: { name?: string | null } } | undefined;
			return member?.user?.name || null;
		}, [membersData, userId]);
	};
}

/** Dropdown-menu item that OPENS the details dialog. Deliberately does NOT
 * own the dialog: Radix unmounts everything inside DropdownMenuContent when
 * the menu closes, so a dialog rendered here dies before it can show. The
 * caller owns a single `<ContextSourceDetailsDialog>` OUTSIDE the menu and
 * flips it from {@link onOpen}. */
export function EditSourceDetailsMenuItem({
	testId,
	onOpen,
}: {
	testId?: string;
	onOpen: () => void;
}) {
	const t = useTranslations("tooltips.contextSources.sourceDetails");

	return (
		<DropdownMenuItem
			onSelect={() => {
				// Let Radix close the menu and restore focus to the trigger;
				// the dialog lives outside the menu tree (see above), so
				// closing costs nothing and prevents a stranded open menu.
				onOpen();
			}}
			data-testid={testId ?? "context-edit-details"}
		>
			<Settings2Icon className="mr-2 size-4" aria-hidden="true" />
			{t("editMenuItem")}
		</DropdownMenuItem>
	);
}

/** Small chip shown on context cards when the source carries a type label. */
function SourceTypeChip({ label }: { label: string }) {
	return (
		<span
			className="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-muted-foreground text-[11px]"
			data-testid="context-source-type-chip"
		>
			{label}
		</span>
	);
}

/** Card-list display for a source's metadata (Fizzy #1888 FR3): the type
 * chip plus the instructions truncated to one line (full text on hover).
 * Renders nothing for unannotated sources, so existing cards are
 * pixel-identical. Span-rooted so it can sit inline beside a row title. */
export function ContextSourceMetaLine({
	sourceType,
	aiInstructions,
}: {
	sourceType?: string | null;
	aiInstructions?: string | null;
}) {
	if (!sourceType && !aiInstructions) {
		return null;
	}
	return (
		<span className="flex flex-wrap items-center gap-1.5">
			{sourceType ? <SourceTypeChip label={sourceType} /> : null}
			{aiInstructions ? (
				<span
					className="max-w-full truncate text-[11px] text-muted-foreground italic"
					title={aiInstructions}
				>
					{aiInstructions}
				</span>
			) : null}
		</span>
	);
}
