"use client";

import { parseBrandColorList } from "@saas/shared/components/BrandColorListField";
import { useFeatureFlag } from "@saas/shared/components/FeatureFlagProvider";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, AlertDescription } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import { AlertCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import {
	type RecipientBrandDraft,
	RecipientBrandFields,
	type RecipientLogoErrorCode,
	recipientBrandDraftFrom,
} from "./RecipientBrandFields";

const recipientBrandQueryKey = (projectId: string) =>
	["projectRecipientBrand", projectId] as const;

type Props = {
	projectId: string;
	/** `canUpdateProject`: editors change it, everyone else reads it. */
	canEdit: boolean;
};

/** What the brand is used by, which is what the card's description says. */
type RecipientBrandAudience = "glossy" | "proposalArtifact";

/**
 * The project's recipient brand in project settings (Fizzy #2589, R32): the
 * party this project's Glossy editions are prepared for. Coordinated
 * Proposals color their visuals from it too (Fizzy #2801), so the card shows
 * behind either rollout gate, `GLOSSY_EDITION` or `PROPOSAL_ARTIFACT` — the
 * same either-gate the `recipientBrand.*` procedures apply. With both off
 * nothing renders or loads.
 */
export function ProjectRecipientBrandCard({ projectId, canEdit }: Props) {
	const glossyEnabled = useFeatureFlag("GLOSSY_EDITION");
	const proposalArtifactEnabled = useFeatureFlag("PROPOSAL_ARTIFACT");
	if (!glossyEnabled && !proposalArtifactEnabled) {
		return null;
	}
	return (
		<RecipientBrandCard
			projectId={projectId}
			canEdit={canEdit}
			audience={glossyEnabled ? "glossy" : "proposalArtifact"}
		/>
	);
}

function RecipientBrandCard({
	projectId,
	canEdit,
	audience,
}: Props & { audience: RecipientBrandAudience }) {
	const t = useTranslations("projects.glossy.recipientBrand");
	const queryClient = useQueryClient();
	const queryKey = recipientBrandQueryKey(projectId);

	const query = useQuery({
		queryKey,
		queryFn: () => orpcClient.projects.recipientBrand.get({ projectId }),
		retry: 1,
	});

	// The draft is confirmed against the version it was read at; a newer
	// version replaces it (and remounts the fields, dropping any message that
	// described the old one). A background refetch at the same version keeps
	// what the editor is typing.
	const loadedVersion = query.data?.version;
	const [draft, setDraft] = useState<RecipientBrandDraft>(() =>
		recipientBrandDraftFrom(null),
	);
	const [initial, setInitial] = useState<RecipientBrandDraft>(draft);
	const [fieldsPending, setFieldsPending] = useState(false);
	const [logoError, setLogoError] = useState<RecipientLogoErrorCode | null>(
		null,
	);
	const [conflict, setConflict] = useState(false);
	const [colorsInvalid, setColorsInvalid] = useState(false);

	useEffect(() => {
		if (!query.data) {
			return;
		}
		const next = recipientBrandDraftFrom(query.data.recipientBrand);
		setDraft(next);
		setInitial(next);
		setLogoError(null);
		setColorsInvalid(false);
	}, [loadedVersion]);

	const saveMutation = useMutation({
		mutationFn: (input: {
			expectedVersion: number;
			colors: string[];
			draft: RecipientBrandDraft;
		}) =>
			orpcClient.projects.recipientBrand.update({
				projectId,
				expectedVersion: input.expectedVersion,
				name: input.draft.name.trim() || null,
				website: input.draft.website.trim() || null,
				colors: input.colors,
				logo:
					input.draft.logo.action === "replace"
						? { action: "replace", token: input.draft.logo.token }
						: { action: input.draft.logo.action },
			}),
		onSuccess: async (result) => {
			if (result.outcome === "applied") {
				setConflict(false);
				toast.success(t("saved"));
				await queryClient.invalidateQueries({ queryKey });
				return;
			}
			if (result.outcome === "conflict") {
				// Someone confirmed since this draft was read. Load theirs —
				// the new version replaces the draft — and say so, rather
				// than let a retry overwrite a change this editor never saw.
				setConflict(true);
				await queryClient.invalidateQueries({ queryKey });
				return;
			}
			// The server discarded the pending object it refused, so the
			// token is spent: fall back to the saved logo.
			setLogoError(result.code);
			setDraft((prev) => ({ ...prev, logo: { action: "keep" } }));
		},
		onError: (error) => {
			toast.error(
				error instanceof Error ? error.message : t("saveFailed"),
			);
		},
	});

	if (query.isLoading) {
		return (
			<RecipientBrandCardShell audience={audience}>
				<p className="text-muted-foreground text-sm">{t("loading")}</p>
			</RecipientBrandCardShell>
		);
	}

	if (query.error || !query.data) {
		return (
			<RecipientBrandCardShell audience={audience}>
				<div className="flex items-center gap-2 text-destructive text-sm">
					<AlertCircle className="size-4" aria-hidden="true" />
					<span>{t("loadFailed")}</span>
				</div>
			</RecipientBrandCardShell>
		);
	}

	const { version, recipientBrand } = query.data;
	const hasChanges = JSON.stringify(draft) !== JSON.stringify(initial);
	const saving = saveMutation.isPending;

	const save = () => {
		const colors = parseBrandColorList(draft.colors);
		setColorsInvalid(colors === null);
		// The field already flags a malformed entry; refusing here is what
		// keeps it off the wire.
		if (!colors) {
			return;
		}
		setLogoError(null);
		setConflict(false);
		saveMutation.mutate({ expectedVersion: version, colors, draft });
	};

	return (
		<RecipientBrandCardShell audience={audience}>
			{!canEdit && (
				<p className="text-muted-foreground text-sm">{t("readOnly")}</p>
			)}
			{conflict && (
				<Alert variant="warning">
					<AlertDescription className="mt-0">
						{t("conflict")}
					</AlertDescription>
				</Alert>
			)}
			<RecipientBrandFields
				key={version}
				projectId={projectId}
				value={draft}
				onChange={setDraft}
				currentLogoUrl={recipientBrand?.logoUrl ?? null}
				disabled={!canEdit}
				busy={saving}
				logoError={logoError}
				idPrefix="project-recipient-brand"
				onPendingChange={setFieldsPending}
			/>
			{canEdit && (
				<div className="flex flex-wrap items-center gap-3">
					<Button
						type="button"
						size="sm"
						loading={saving}
						disabled={!hasChanges || fieldsPending}
						onClick={save}
					>
						{t("save")}
					</Button>
					{hasChanges && !saving && (
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => {
								setDraft(initial);
								setColorsInvalid(false);
								setLogoError(null);
							}}
						>
							{t("discard")}
						</Button>
					)}
					{colorsInvalid && (
						<p role="alert" className="text-destructive text-sm">
							{t("fixColors")}
						</p>
					)}
				</div>
			)}
		</RecipientBrandCardShell>
	);
}

function RecipientBrandCardShell({
	audience,
	children,
}: {
	audience: RecipientBrandAudience;
	children: ReactNode;
}) {
	const t = useTranslations("projects.glossy.recipientBrand");
	const tProposalArtifact = useTranslations("projects.proposalArtifactEntry");
	return (
		<Card className="p-6">
			<h3 className="font-medium text-base">{t("title")}</h3>
			<p className="mt-1 text-muted-foreground text-sm">
				{/* Without Glossy there is no cover to carry the logo: the
				    brand only colors a coordinated Proposal's visuals. */}
				{audience === "glossy"
					? t("description")
					: tProposalArtifact("recipientBrandDescription")}
			</p>
			<div className="mt-5 space-y-5">{children}</div>
		</Card>
	);
}
