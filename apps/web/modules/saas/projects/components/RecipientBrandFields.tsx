"use client";

import { BrandColorListField } from "@saas/shared/components/BrandColorListField";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation } from "@tanstack/react-query";
import { Alert, AlertDescription } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { ImageIcon, Trash2Icon, UploadIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import {
	type Dispatch,
	type SetStateAction,
	useEffect,
	useRef,
	useState,
} from "react";

// The server's limits, restated for the browser: `RECIPIENT_BRAND_MAX_*` live
// in `@repo/database` (which pulls the Prisma client into a bundle) and
// `LOGO_MAX_INPUT_BYTES` in `@repo/integrations/website-brand` (which pulls
// `sharp`). Checking here only spares a round trip; the server re-checks.
const MAX_COLORS = 3;
const MAX_NAME_LENGTH = 200;
const LOGO_MAX_INPUT_BYTES = 5 * 1024 * 1024;
const LOGO_CONTENT_TYPES = [
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
] as const;
type LogoContentType = (typeof LOGO_CONTENT_TYPES)[number];

function isLogoContentType(type: string): type is LogoContentType {
	return (LOGO_CONTENT_TYPES as readonly string[]).includes(type);
}

/**
 * What confirmation does with the logo. `keep` shows the saved logo;
 * `replace` names the pending object a fetch or an upload returned (KTD23).
 */
type RecipientLogoDraft =
	| { action: "keep" }
	| { action: "remove" }
	| { action: "replace"; token: string; previewUrl: string | null };

/** The recipient brand as the editor is shaping it, before confirmation. */
export type RecipientBrandDraft = {
	name: string;
	website: string;
	/** As typed; `parseBrandColorList` turns them into `#rrggbb`. */
	colors: string[];
	logo: RecipientLogoDraft;
};

export function recipientBrandDraftFrom(
	brand: {
		name: string | null;
		website: string | null;
		colors: string[];
	} | null,
): RecipientBrandDraft {
	return {
		name: brand?.name ?? "",
		website: brand?.website ?? "",
		colors: brand?.colors ?? [],
		logo: { action: "keep" },
	};
}

/** A logo the confirmation refused, or the browser refused before upload. */
export type RecipientLogoErrorCode =
	| "too_large"
	| "unsupported"
	| "uploadFailed";

type FetchStatus =
	| { status: "idle" }
	| { status: "fetched"; website: string }
	| {
			status: "failed";
			reason:
				| "unreachable"
				| "blocked"
				| "too_large"
				| "unsupported"
				| "no_logo"
				| "rateLimited"
				| "unavailable";
	  };

type RecipientBrandFieldsProps = {
	projectId: string;
	value: RecipientBrandDraft;
	/** A state setter: a fetch that settles late must not clobber later edits. */
	onChange: Dispatch<SetStateAction<RecipientBrandDraft>>;
	/** Signed read of the saved logo, shown while the draft keeps it. */
	currentLogoUrl: string | null;
	/** Read-only, for someone who cannot edit the project. */
	disabled?: boolean;
	/** A confirmation is in flight: hold every control still. */
	busy?: boolean;
	/** Set by the owner when confirmation refused the logo. */
	logoError?: RecipientLogoErrorCode | null;
	/** Prefix for element ids; unique on the page. */
	idPrefix?: string;
	/** Told whenever a fetch or an upload starts or settles, to hold a save. */
	onPendingChange?: (pending: boolean) => void;
};

/**
 * The recipient brand's fields (Fizzy #2589, R32–R34): name, website with a
 * Fetch that proposes a logo and colors, a manual logo upload, and colors.
 *
 * Owns the two side effects that yield a logo token — the website fetch and
 * the signed upload — and nothing else: the owner holds the draft and the
 * version it was read at, and confirms it through `recipientBrand.update`.
 * So the project settings card and the Glossy Align-first panel share every
 * field and every failure message, and differ only in how they save.
 *
 * Nothing about a fetch blocks anything (R34, AE9): a failure, including the
 * per-user rate limit, is a message beside the website and the manual fields
 * stay right here. A fetch's proposal lands in the fields themselves, where
 * the editor reviews and edits it before confirming.
 *
 * Remount it (a `key`) when the owner reloads the draft, so a stale fetch
 * message does not outlive the draft it described.
 */
export function RecipientBrandFields({
	projectId,
	value,
	onChange,
	currentLogoUrl,
	disabled = false,
	busy = false,
	logoError = null,
	idPrefix = "recipient-brand",
	onPendingChange,
}: RecipientBrandFieldsProps) {
	const t = useTranslations("projects.glossy.recipientBrand");
	const [fetchStatus, setFetchStatus] = useState<FetchStatus>({
		status: "idle",
	});
	const [uploadError, setUploadError] =
		useState<RecipientLogoErrorCode | null>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);

	// An uploaded logo previews from the local file. The object URL is ours to
	// release: when the draft stops showing it, and when the fields unmount.
	// The draft can drop it without these fields acting — the owner's Discard,
	// or a save that refused the logo — so that is watched from `value`.
	const objectUrlRef = useRef<string | null>(null);
	const releaseObjectUrl = () => {
		if (objectUrlRef.current) {
			URL.revokeObjectURL(objectUrlRef.current);
			objectUrlRef.current = null;
		}
	};
	const draftPreviewUrl =
		value.logo.action === "replace" ? value.logo.previewUrl : null;
	useEffect(() => {
		if (objectUrlRef.current !== draftPreviewUrl) {
			releaseObjectUrl();
		}
	}, [draftPreviewUrl]);
	useEffect(() => releaseObjectUrl, []);

	const fetchMutation = useMutation({
		mutationFn: (website: string) =>
			orpcClient.projects.recipientBrand.fetch({ projectId, website }),
	});

	const uploadMutation = useMutation({
		mutationFn: async (file: File & { type: LogoContentType }) => {
			const { token, signedUploadUrl, contentType } =
				await orpcClient.projects.recipientBrand.createLogoUploadUrl({
					projectId,
					contentType: file.type,
					size: file.size,
				});
			const response = await fetch(signedUploadUrl, {
				method: "PUT",
				body: file,
				headers: { "Content-Type": contentType },
			});
			if (!response.ok) {
				throw new Error("Logo upload failed");
			}
			return token;
		},
	});

	const pending = fetchMutation.isPending || uploadMutation.isPending;
	useEffect(() => {
		onPendingChange?.(pending);
	}, [pending]);

	const locked = disabled || busy;
	const website = value.website.trim();

	const runFetch = () => {
		if (!website || pending) {
			return;
		}
		setFetchStatus({ status: "idle" });
		// Per-call callbacks, not the mutation's: they do not run once these
		// fields unmount, so a late answer cannot land in a reloaded draft.
		fetchMutation.mutate(website, {
			onSuccess: (result) => {
				if (result.outcome === "fetched") {
					releaseObjectUrl();
					setUploadError(null);
					onChange((prev) => ({
						...prev,
						website: result.website,
						colors:
							result.colors.length > 0
								? result.colors
								: prev.colors,
						logo: {
							action: "replace",
							token: result.token,
							previewUrl: result.logoUrl,
						},
					}));
					setFetchStatus({
						status: "fetched",
						website: result.website,
					});
					return;
				}
				// Colors found without a usable logo are still worth offering.
				if (result.colors.length > 0) {
					onChange((prev) => ({ ...prev, colors: result.colors }));
				}
				setFetchStatus({ status: "failed", reason: result.code });
			},
			onError: (error) => {
				// The rate limit is the one failure the server throws rather
				// than answers; like every other it falls back to manual entry.
				const code = (error as { code?: unknown } | null)?.code;
				setFetchStatus({
					status: "failed",
					reason:
						code === "TOO_MANY_REQUESTS"
							? "rateLimited"
							: "unavailable",
				});
			},
		});
	};

	const upload = (file: File) => {
		setUploadError(null);
		if (!isLogoContentType(file.type)) {
			setUploadError("unsupported");
			return;
		}
		if (file.size > LOGO_MAX_INPUT_BYTES) {
			setUploadError("too_large");
			return;
		}
		uploadMutation.mutate(file as File & { type: LogoContentType }, {
			onSuccess: (token) => {
				releaseObjectUrl();
				const previewUrl =
					typeof URL.createObjectURL === "function"
						? URL.createObjectURL(file)
						: null;
				objectUrlRef.current = previewUrl;
				onChange((prev) => ({
					...prev,
					logo: { action: "replace", token, previewUrl },
				}));
			},
			onError: () => setUploadError("uploadFailed"),
		});
	};

	const logoPreviewUrl =
		value.logo.action === "replace"
			? value.logo.previewUrl
			: value.logo.action === "keep"
				? currentLogoUrl
				: null;
	const hasLogo =
		value.logo.action === "replace" ||
		(value.logo.action === "keep" && currentLogoUrl !== null);
	// A refused confirmation stops mattering once another logo is picked.
	const shownLogoError =
		uploadError ?? (value.logo.action === "replace" ? null : logoError);

	const ids = {
		name: `${idPrefix}-name`,
		website: `${idPrefix}-website`,
		websiteHelp: `${idPrefix}-website-help`,
		logoHelp: `${idPrefix}-logo-help`,
		logoInput: `${idPrefix}-logo-file`,
		colors: `${idPrefix}-color`,
	};

	return (
		<div className="space-y-5">
			<div className="space-y-2">
				<Label htmlFor={ids.name}>{t("name")}</Label>
				<Input
					id={ids.name}
					value={value.name}
					maxLength={MAX_NAME_LENGTH}
					placeholder={t("namePlaceholder")}
					disabled={locked}
					onChange={(e) => {
						const name = e.target.value;
						onChange((prev) => ({ ...prev, name }));
					}}
				/>
			</div>

			<div className="space-y-2">
				<Label htmlFor={ids.website}>{t("website")}</Label>
				<div className="flex gap-2">
					<Input
						id={ids.website}
						// Text, not `url`: a bare host such as example.com is the
						// expected entry, and the server normalizes it.
						type="text"
						inputMode="url"
						autoComplete="url"
						aria-describedby={ids.websiteHelp}
						placeholder={t("websitePlaceholder")}
						value={value.website}
						disabled={locked || fetchMutation.isPending}
						onChange={(e) => {
							const next = e.target.value;
							onChange((prev) => ({ ...prev, website: next }));
						}}
						onKeyDown={(e) => {
							// Enter fetches rather than submitting an owning form.
							if (e.key === "Enter") {
								e.preventDefault();
								runFetch();
							}
						}}
					/>
					{!disabled && (
						<Button
							type="button"
							variant="outline"
							loading={fetchMutation.isPending}
							disabled={
								!website || busy || uploadMutation.isPending
							}
							onClick={runFetch}
						>
							{t("fetch")}
						</Button>
					)}
				</div>
				<p
					id={ids.websiteHelp}
					className="text-muted-foreground text-xs"
				>
					{t("websiteHelp")}
				</p>
				{/* Always mounted (an implicit polite status), so screen readers
				    announce what it becomes. */}
				<output className="block text-muted-foreground text-sm">
					{fetchMutation.isPending
						? t("fetching")
						: fetchStatus.status === "fetched"
							? t("fetched", { website: fetchStatus.website })
							: null}
				</output>
				{!fetchMutation.isPending &&
					fetchStatus.status === "failed" && (
						<Alert variant="warning">
							<AlertDescription className="mt-0">
								{t(`failure.${fetchStatus.reason}`)}
							</AlertDescription>
						</Alert>
					)}
			</div>

			<fieldset className="space-y-2">
				<legend className="font-medium text-sm leading-none">
					{t("logo")}
				</legend>
				<div className="flex flex-wrap items-center gap-4">
					<div className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted">
						{logoPreviewUrl ? (
							// biome-ignore lint/performance/noImgElement: a short-lived signed read or a local object URL, neither of which next/image can optimize
							<img
								src={logoPreviewUrl}
								alt={t("logoAlt")}
								className="max-h-full max-w-full object-contain"
							/>
						) : (
							<ImageIcon
								className="size-6 text-muted-foreground"
								aria-label={
									hasLogo ? t("logoAlt") : t("noLogo")
								}
								role="img"
							/>
						)}
					</div>
					{!disabled && (
						<div className="flex flex-wrap gap-2">
							{/* Out of the tab order and the accessibility tree: the
							    button below is the one control that opens it. */}
							<input
								ref={fileInputRef}
								id={ids.logoInput}
								type="file"
								hidden
								accept={LOGO_CONTENT_TYPES.join(",")}
								aria-label={t("uploadLogo")}
								onChange={(e) => {
									const file = e.target.files?.[0];
									// Cleared so picking the same file again still fires.
									e.target.value = "";
									if (file) {
										upload(file);
									}
								}}
							/>
							<Button
								type="button"
								variant="outline"
								size="sm"
								loading={uploadMutation.isPending}
								disabled={busy || fetchMutation.isPending}
								aria-describedby={ids.logoHelp}
								onClick={() => fileInputRef.current?.click()}
							>
								<UploadIcon
									className="size-4"
									aria-hidden="true"
								/>
								{t("uploadLogo")}
							</Button>
							{hasLogo && (
								<Button
									type="button"
									variant="ghost"
									size="sm"
									disabled={locked || pending}
									onClick={() => {
										releaseObjectUrl();
										onChange((prev) => ({
											...prev,
											logo: { action: "remove" },
										}));
									}}
								>
									<Trash2Icon
										className="size-4"
										aria-hidden="true"
									/>
									{t("removeLogo")}
								</Button>
							)}
						</div>
					)}
				</div>
				{!disabled && (
					<p
						id={ids.logoHelp}
						className="text-muted-foreground text-xs"
					>
						{t("logoHelp")}
					</p>
				)}
				{shownLogoError && (
					<p role="alert" className="text-destructive text-sm">
						{t(`logoError.${shownLogoError}`)}
					</p>
				)}
			</fieldset>

			<BrandColorListField
				id={ids.colors}
				legend={t("colors")}
				description={t("colorsHelp")}
				colors={value.colors}
				max={MAX_COLORS}
				disabled={locked}
				labels={{
					hex: (position) => t("colorHex", { position }),
					picker: (position) => t("colorPicker", { position }),
					remove: (position) => t("removeColor", { position }),
					add: t("addColor"),
					invalid: t("invalidColor"),
					empty: t("noColors"),
				}}
				onChange={(colors) => onChange((prev) => ({ ...prev, colors }))}
			/>
		</div>
	);
}
