"use client";

import { useActiveOrganization } from "@saas/organizations/hooks/use-active-organization";
import {
	BrandColorListField,
	parseBrandColorList,
} from "@saas/shared/components/BrandColorListField";
import { useFeatureFlag } from "@saas/shared/components/FeatureFlagProvider";
import { SettingsItem } from "@saas/shared/components/SettingsItem";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Label } from "@ui/components/label";
import { Textarea } from "@ui/components/textarea";
import { AlertCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";

// The server's limits (`BRAND_KIT_MAX_ACCENTS`, `BRAND_KIT_MAX_GUIDANCE_LENGTH`
// in `@repo/database`), restated because that module pulls the Prisma client
// into a browser bundle. The server stays the validation authority.
const MAX_ACCENTS = 3;
const MAX_GUIDANCE_LENGTH = 2000;

const queryKeyFor = (organizationId: string) =>
	["organizationBrandKit", organizationId] as const;

type Draft = { accentColors: string[]; guidance: string };

/**
 * The organization Brand kit (Fizzy #2589, R31): the accent colors and brand
 * guidance its Glossy editions use, beside the logo and theme color the page
 * already edits. Behind the `GLOSSY_EDITION` rollout gate, like every Glossy
 * surface — with it off nothing renders and nothing is fetched.
 *
 * Every member can read the kit; only admins and owners can change it. The
 * role check mirrors the server's (`requireOrgMembership` with admin or owner)
 * rather than `isOrganizationAdmin`, which also admits platform admins the
 * update procedure would refuse.
 */
export function OrganizationBrandKitForm() {
	const enabled = useFeatureFlag("GLOSSY_EDITION");
	const { activeOrganization, activeOrganizationUserRole } =
		useActiveOrganization();

	if (!enabled || !activeOrganization) {
		return null;
	}
	return (
		<BrandKitSettings
			organizationId={activeOrganization.id}
			canEdit={
				activeOrganizationUserRole === "admin" ||
				activeOrganizationUserRole === "owner"
			}
		/>
	);
}

function BrandKitSettings({
	organizationId,
	canEdit,
}: {
	organizationId: string;
	canEdit: boolean;
}) {
	const t = useTranslations("settings.brandKit");
	const queryClient = useQueryClient();

	const { data, isLoading, error } = useQuery({
		queryKey: queryKeyFor(organizationId),
		queryFn: async () =>
			(await orpcClient.organizations.brandKit.get({ organizationId }))
				.brandKit,
		retry: 1,
	});

	const [draft, setDraft] = useState<Draft>({
		accentColors: [],
		guidance: "",
	});
	const [submitted, setSubmitted] = useState(false);

	// Keyed on the save time, not the object: a background refetch of an
	// unchanged kit must not wipe what the admin is typing.
	const savedAt = data ? String(data.updatedAt) : undefined;
	useEffect(() => {
		if (!data) {
			return;
		}
		setDraft({
			accentColors: data.accentColors,
			guidance: data.guidance ?? "",
		});
		setSubmitted(false);
	}, [savedAt]);

	const updateMutation = useMutation({
		mutationFn: async (input: {
			accentColors: string[];
			guidance: string | null;
		}) =>
			(
				await orpcClient.organizations.brandKit.update({
					organizationId,
					...input,
				})
			).brandKit,
		onSuccess: (brandKit) => {
			toast.success(t("saved"));
			queryClient.setQueryData(queryKeyFor(organizationId), brandKit);
			setDraft({
				accentColors: brandKit.accentColors,
				guidance: brandKit.guidance ?? "",
			});
		},
		onError: (err) => {
			toast.error(err instanceof Error ? err.message : t("saveFailed"));
		},
	});

	if (isLoading) {
		return (
			<SettingsItem title={t("title")} description={t("description")}>
				<div className="text-muted-foreground text-sm">
					{t("loading")}
				</div>
			</SettingsItem>
		);
	}

	if (error || !data) {
		return (
			<SettingsItem title={t("title")} description={t("description")}>
				<div className="flex items-center gap-2 text-destructive text-sm">
					<AlertCircle className="size-4" aria-hidden="true" />
					<span>{t("loadFailed")}</span>
				</div>
			</SettingsItem>
		);
	}

	const accentColors = parseBrandColorList(draft.accentColors);
	const hasChanges =
		draft.guidance.trim() !== (data.guidance ?? "") ||
		JSON.stringify(accentColors ?? draft.accentColors) !==
			JSON.stringify(data.accentColors);
	const disabled = !canEdit || updateMutation.isPending;

	const save = () => {
		setSubmitted(true);
		// The field already flags a malformed entry; refusing here is what
		// keeps it off the wire.
		if (!accentColors) {
			return;
		}
		updateMutation.mutate({
			accentColors,
			guidance: draft.guidance.trim() || null,
		});
	};

	return (
		<SettingsItem title={t("title")} description={t("description")}>
			<form
				className="space-y-5"
				noValidate
				onSubmit={(e) => {
					e.preventDefault();
					save();
				}}
			>
				{!canEdit && (
					<p className="text-muted-foreground text-sm">
						{t("readOnly")}
					</p>
				)}
				<BrandColorListField
					id="organization-brand-kit-accent"
					legend={t("accentColors")}
					description={t("accentColorsHelp")}
					colors={draft.accentColors}
					max={MAX_ACCENTS}
					disabled={disabled}
					labels={{
						hex: (position) => t("accentHex", { position }),
						picker: (position) => t("accentPicker", { position }),
						remove: (position) => t("removeAccent", { position }),
						add: t("addAccent"),
						invalid: t("invalidColor"),
						empty: t("noAccents"),
					}}
					onChange={(next) =>
						setDraft((prev) => ({ ...prev, accentColors: next }))
					}
				/>
				<div className="space-y-2">
					<Label htmlFor="organization-brand-kit-guidance">
						{t("guidance")}
					</Label>
					<Textarea
						id="organization-brand-kit-guidance"
						rows={5}
						maxLength={MAX_GUIDANCE_LENGTH}
						placeholder={t("guidancePlaceholder")}
						aria-describedby="organization-brand-kit-guidance-help"
						value={draft.guidance}
						disabled={disabled}
						onChange={(e) =>
							setDraft((prev) => ({
								...prev,
								guidance: e.target.value,
							}))
						}
					/>
					<p
						id="organization-brand-kit-guidance-help"
						className="text-muted-foreground text-xs"
					>
						{t("guidanceHelp")}{" "}
						{t("guidanceCount", {
							count: draft.guidance.length,
							max: MAX_GUIDANCE_LENGTH,
						})}
					</p>
				</div>
				{canEdit && (
					<div className="flex items-center gap-3">
						<Button
							type="submit"
							size="sm"
							loading={updateMutation.isPending}
							disabled={!hasChanges}
						>
							{t("save")}
						</Button>
						{submitted && !accentColors && (
							<p
								role="alert"
								className="text-destructive text-sm"
							>
								{t("fixColors")}
							</p>
						)}
					</div>
				)}
			</form>
		</SettingsItem>
	);
}
