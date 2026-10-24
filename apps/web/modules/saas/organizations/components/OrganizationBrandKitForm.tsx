"use client";

import { ORPCError } from "@orpc/client";
import type { BrandAssetRejectionCode } from "@repo/utils/brand-assets";
import { useActiveOrganization } from "@saas/organizations/hooks/use-active-organization";
import {
	BrandColorListField,
	parseBrandColorList,
} from "@saas/shared/components/BrandColorListField";
import { useFeatureFlag } from "@saas/shared/components/FeatureFlagProvider";
import { SettingsItem } from "@saas/shared/components/SettingsItem";
import { brandFetchRefetchInterval } from "@saas/shared/lib/brand-fetch-polling";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, AlertDescription } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import { Label } from "@ui/components/label";
import { Textarea } from "@ui/components/textarea";
import { AlertCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
	AssetSlot,
	FontField,
	useAssetSlotLabels,
} from "./brand-kit/BrandKitAssetSlot";
import { BrandKitWebsiteField } from "./brand-kit/BrandKitWebsiteField";
import {
	ASSET_KINDS,
	type AssetDraft,
	type AssetKind,
	type BrandKit,
	type BrandKitUpdateInput,
	checkFamily,
	type Draft,
	draftDiffers,
	draftFrom,
	errorDataCode,
	hasFontFile,
	isSaveErrorCode,
	type SaveErrorCode,
} from "./brand-kit/brand-kit-draft";
import { useBrandKitSiteFetch } from "./brand-kit/use-brand-kit-site-fetch";

// The server's limits (`BRAND_KIT_MAX_ACCENTS`, `BRAND_KIT_MAX_GUIDANCE_LENGTH`
// in `@repo/database`), restated because that module pulls the Prisma client
// into a browser bundle. The server stays the validation authority.
const MAX_ACCENTS = 3;
const MAX_GUIDANCE_LENGTH = 2000;

/** The two fonts, each a family name and an optional file. */
const FONT_FIELDS = [
	{
		kind: "displayFont",
		id: "organization-brand-kit-display-font",
		family: "displayFontFamily",
		stored: "hasDisplayFontFile",
	},
	{
		kind: "bodyFont",
		id: "organization-brand-kit-body-font",
		family: "bodyFontFamily",
		stored: "hasBodyFontFile",
	},
] as const;

const queryKeyFor = (organizationId: string) =>
	["organizationBrandKit", organizationId] as const;

/**
 * The organization Brand kit (Fizzy #2589, extended in Fizzy #2946): the
 * proposer brand its Glossy editions and client-document Proposals use — the
 * primary and accent colors, display and body fonts with optional files, a
 * cover image and the website whose declared colors are fetched as a source
 * below the kit — and the brand guidance. The logo is the organization logo
 * the page already uploads. Behind either rollout gate (`GLOSSY_EDITION` or
 * `PROPOSAL_ARTIFACT`), as the procedures are — with both off nothing renders
 * and nothing is fetched.
 *
 * Every member can read the kit; only admins and owners can change it. The
 * role check mirrors the server's (`requireOrgMembership` with admin or owner)
 * rather than `isOrganizationAdmin`, which also admits platform admins the
 * update procedure would refuse.
 */
export function OrganizationBrandKitForm() {
	// Both hooks, always: a short-circuit between them would change the hook
	// order when the first flag flips.
	const glossyEnabled = useFeatureFlag("GLOSSY_EDITION");
	const proposalEnabled = useFeatureFlag("PROPOSAL_ARTIFACT");
	const { activeOrganization, activeOrganizationUserRole } =
		useActiveOrganization();

	if (!(glossyEnabled || proposalEnabled) || !activeOrganization) {
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
	const slotLabels = useAssetSlotLabels();
	const queryClient = useQueryClient();
	const queryKey = queryKeyFor(organizationId);

	const { data, isLoading, error, refetch } = useQuery({
		queryKey,
		queryFn: async () =>
			(await orpcClient.organizations.brandKit.get({ organizationId }))
				.brandKit,
		retry: 1,
		// Re-read while the stored website's fetch runs, then stop. A fetch
		// writes only its own row, so polling never moves `version`.
		refetchInterval: (query) => {
			const kit = query.state.data;
			const attempt = kit?.siteFetch;
			return attempt && attempt.website === kit.website
				? brandFetchRefetchInterval(attempt)
				: false;
		},
	});
	const siteFetch = useBrandKitSiteFetch({
		organizationId,
		queryKey,
		kit: data,
	});

	// The kit the draft was read from: what a save compares against and names
	// as `expectedVersion`, and the hero and font files a `keep` keeps.
	const [base, setBase] = useState<BrandKit | null>(null);
	const [draft, setDraft] = useState<Draft | null>(null);
	const [submitted, setSubmitted] = useState(false);
	const [conflict, setConflict] = useState(false);
	const [saveError, setSaveError] = useState<SaveErrorCode | null>(null);
	const [rejected, setRejected] = useState<
		Partial<Record<AssetKind, BrandAssetRejectionCode>>
	>({});
	const [uploading, setUploading] = useState<Record<AssetKind, boolean>>({
		hero: false,
		displayFont: false,
		bodyFont: false,
	});
	const [reloading, setReloading] = useState(false);

	const anyUploading = ASSET_KINDS.some((kind) => uploading[kind]);

	const resetFrom = (kit: BrandKit) => {
		setBase(kit);
		setDraft(draftFrom(kit));
		setSubmitted(false);
		setConflict(false);
		setSaveError(null);
		setRejected({});
	};

	// A newer version replaces the draft only while it holds no edits, so a
	// background read never wipes what an admin is typing: their save then
	// meets the CONFLICT and offers Reload instead.
	useEffect(() => {
		if (!data) {
			return;
		}
		if (
			!base ||
			!draft ||
			(data.version !== base.version &&
				!anyUploading &&
				!draftDiffers(draft, base))
		) {
			resetFrom(data);
		}
	}, [data?.version]);

	const onUploadPendingChange = useCallback(
		(kind: AssetKind, pending: boolean) =>
			setUploading((prev) =>
				prev[kind] === pending ? prev : { ...prev, [kind]: pending },
			),
		[],
	);

	const updateMutation = useMutation({
		mutationFn: (input: BrandKitUpdateInput) =>
			orpcClient.organizations.brandKit.update(input),
		// Here rather than in the save's own callbacks, which are dropped when
		// the form unmounts mid-save; cancelling first keeps a read already in
		// flight from landing the older kit over the saved one.
		onSuccess: async (result) => {
			if (result.outcome !== "applied") {
				return;
			}
			await queryClient.cancelQueries({ queryKey });
			queryClient.setQueryData(queryKey, result.brandKit);
		},
	});

	// A failed background read (a poll, a refocus) keeps the kit on screen;
	// only a kit that never loaded shows the failure.
	if (!data && !isLoading && error) {
		return (
			<SettingsItem title={t("title")} description={t("description")}>
				<div className="flex items-center gap-2 text-destructive text-sm">
					<AlertCircle className="size-4" aria-hidden="true" />
					<span>{t("loadFailed")}</span>
				</div>
			</SettingsItem>
		);
	}

	if (!data || !base || !draft) {
		return (
			<SettingsItem title={t("title")} description={t("description")}>
				<div className="text-muted-foreground text-sm">
					{t("loading")}
				</div>
			</SettingsItem>
		);
	}

	const primaryColors = parseBrandColorList(draft.primaryColor);
	const accentColors = parseBrandColorList(draft.accentColors);
	const fonts = {
		displayFont: checkFamily(
			draft.displayFontFamily,
			hasFontFile(draft.assets.displayFont, base.hasDisplayFontFile),
		),
		bodyFont: checkFamily(
			draft.bodyFontFamily,
			hasFontFile(draft.assets.bodyFont, base.hasBodyFontFile),
		),
	};
	const colorsInvalid = !primaryColors || !accentColors;
	const fontsInvalid = Boolean(
		fonts.displayFont.error || fonts.bodyFont.error,
	);
	const hasChanges = draftDiffers(draft, base);
	const locked = !canEdit || updateMutation.isPending;

	const setField = <K extends keyof Draft>(key: K, value: Draft[K]) =>
		setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
	const setAsset = (kind: AssetKind, next: AssetDraft) =>
		setDraft((prev) =>
			prev ? { ...prev, assets: { ...prev.assets, [kind]: next } } : prev,
		);

	const save = () => {
		setSubmitted(true);
		setSaveError(null);
		// The fields already flag a malformed entry; refusing here is what
		// keeps it off the wire.
		if (!primaryColors || !accentColors || fontsInvalid || anyUploading) {
			return;
		}
		setRejected({});
		const previousWebsite = base.website;
		const wire = (asset: AssetDraft) =>
			asset.action === "replace"
				? { action: "replace" as const, token: asset.token }
				: { action: asset.action };
		updateMutation.mutate(
			{
				organizationId,
				expectedVersion: base.version,
				accentColors,
				guidance: draft.guidance.trim() || null,
				primaryColor: primaryColors[0] ?? null,
				displayFontFamily: fonts.displayFont.family,
				bodyFontFamily: fonts.bodyFont.family,
				website: draft.website.trim() || null,
				assets: {
					hero: wire(draft.assets.hero),
					displayFont: wire(draft.assets.displayFont),
					bodyFont: wire(draft.assets.bodyFont),
				},
			},
			{
				onSuccess: (result) => {
					if (result.outcome === "assetRejected") {
						// The refused upload's token is spent: the slot falls
						// back to the stored file and says why.
						setRejected({ [result.kind]: result.code });
						setAsset(result.kind, { action: "keep" });
						return;
					}
					const saved = result.brandKit;
					resetFrom(saved);
					toast.success(t("saved"));
					if (saved.website && saved.website !== previousWebsite) {
						siteFetch.run(true);
					}
				},
				onError: (err) => {
					if (err instanceof ORPCError && err.code === "CONFLICT") {
						// Someone saved since this draft was read. Keep the
						// draft on screen; Reload is the admin's choice.
						setConflict(true);
						return;
					}
					const code = errorDataCode(err);
					if (isSaveErrorCode(code)) {
						setSaveError(code);
						return;
					}
					toast.error(
						err instanceof Error && err.message
							? err.message
							: t("saveFailed"),
					);
				},
			},
		);
	};

	const reload = async () => {
		setReloading(true);
		try {
			const fresh = await refetch();
			// A failed read hands back the kit this draft already conflicts
			// with: keep the draft and the notice rather than reset to it.
			if (fresh.error || !fresh.data) {
				toast.error(t("loadFailed"));
				return;
			}
			resetFrom(fresh.data);
			// The fresh read carries the website fetch's own state.
			siteFetch.clearError();
		} finally {
			setReloading(false);
		}
	};

	const ids = {
		primary: "organization-brand-kit-primary",
		accent: "organization-brand-kit-accent",
		guidance: "organization-brand-kit-guidance",
		guidanceHelp: "organization-brand-kit-guidance-help",
	};
	const websiteInvalid = saveError === "invalidWebsite";
	const slotProps = (kind: AssetKind) => ({
		organizationId,
		kind,
		value: draft.assets[kind],
		canEdit,
		busy: updateMutation.isPending,
		rejectedCode: rejected[kind] ?? null,
		labels: slotLabels[kind],
		onChange: (next: AssetDraft) => setAsset(kind, next),
		onPendingChange: onUploadPendingChange,
	});

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
				{conflict && (
					<Alert variant="warning">
						<AlertDescription className="mt-0 flex flex-wrap items-center gap-3">
							<span>{t("conflict")}</span>
							<Button
								type="button"
								variant="outline"
								size="sm"
								loading={reloading}
								onClick={reload}
							>
								{t("reload")}
							</Button>
						</AlertDescription>
					</Alert>
				)}

				<fieldset className="space-y-5">
					<legend className="font-medium text-sm leading-none">
						{t("proposerBrand")}
					</legend>
					<p className="text-muted-foreground text-xs">
						{t("proposerBrandHelp")}
					</p>

					<BrandColorListField
						id={ids.primary}
						legend={t("primaryColor")}
						description={t("primaryColorHelp")}
						colors={draft.primaryColor}
						max={1}
						disabled={locked}
						labels={{
							hex: () => t("primaryHex"),
							picker: () => t("primaryPicker"),
							remove: () => t("removePrimary"),
							add: t("addPrimary"),
							invalid: t("invalidColor"),
							empty: t("noPrimary"),
						}}
						onChange={(next) => setField("primaryColor", next)}
					/>

					<BrandColorListField
						id={ids.accent}
						legend={t("accentColors")}
						description={t("accentColorsHelp")}
						colors={draft.accentColors}
						max={MAX_ACCENTS}
						disabled={locked}
						labels={{
							hex: (position) => t("accentHex", { position }),
							picker: (position) =>
								t("accentPicker", { position }),
							remove: (position) =>
								t("removeAccent", { position }),
							add: t("addAccent"),
							invalid: t("invalidColor"),
							empty: t("noAccents"),
						}}
						onChange={(next) => setField("accentColors", next)}
					/>

					{FONT_FIELDS.map(({ kind, id, family, stored }) => {
						const familyError = submitted
							? fonts[kind].error
							: null;
						return (
							<FontField
								key={kind}
								id={id}
								legend={t(kind)}
								description={t(`${kind}Help`)}
								familyLabel={t(family)}
								familyHelp={t("fontFamilyHelp")}
								placeholder={t(`${kind}Placeholder`)}
								value={draft[family]}
								error={familyError ? t(familyError) : null}
								disabled={locked}
								onChange={(next) => setField(family, next)}
							>
								<AssetSlot
									key={base.version}
									{...slotProps(kind)}
									idPrefix={`${id}-file`}
									stored={{
										previewUrl: null,
										present: base[stored],
									}}
								/>
							</FontField>
						);
					})}

					<fieldset className="space-y-2">
						<legend className="font-medium text-sm leading-none">
							{t("hero")}
						</legend>
						<AssetSlot
							key={base.version}
							{...slotProps("hero")}
							idPrefix="organization-brand-kit-hero"
							stored={{
								previewUrl: base.heroUrl,
								present: base.heroUrl !== null,
							}}
						/>
					</fieldset>

					<BrandKitWebsiteField
						value={draft.website}
						invalid={websiteInvalid}
						disabled={locked}
						onChange={(next) => {
							setField("website", next);
							if (websiteInvalid) {
								setSaveError(null);
							}
						}}
						storedWebsite={data.website}
						siteFetch={siteFetch}
						canEdit={canEdit}
						saving={updateMutation.isPending}
					/>
				</fieldset>

				<div className="space-y-2">
					<Label htmlFor={ids.guidance}>{t("guidance")}</Label>
					<Textarea
						id={ids.guidance}
						rows={5}
						maxLength={MAX_GUIDANCE_LENGTH}
						placeholder={t("guidancePlaceholder")}
						aria-describedby={ids.guidanceHelp}
						value={draft.guidance}
						disabled={locked}
						onChange={(e) => setField("guidance", e.target.value)}
					/>
					<p
						id={ids.guidanceHelp}
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
					<div className="flex flex-wrap items-center gap-3">
						<Button
							type="submit"
							size="sm"
							loading={updateMutation.isPending}
							disabled={!hasChanges || anyUploading}
						>
							{t("save")}
						</Button>
						{submitted && colorsInvalid && (
							<p
								role="alert"
								className="text-destructive text-sm"
							>
								{t("fixColors")}
							</p>
						)}
						{submitted && !colorsInvalid && fontsInvalid && (
							<p
								role="alert"
								className="text-destructive text-sm"
							>
								{t("fixFields")}
							</p>
						)}
						{saveError && !websiteInvalid && (
							<p
								role="alert"
								className="text-destructive text-sm"
							>
								{t(`saveError.${saveError}`)}
							</p>
						)}
					</div>
				)}
			</form>
		</SettingsItem>
	);
}
