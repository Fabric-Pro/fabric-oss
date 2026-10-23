"use client";

import {
	BRAND_ASSET_MAX_BYTES,
	type BrandAssetRejectionCode,
	brandAssetAcceptAttribute,
	checkBrandAssetFile,
	HERO_MAX_INPUT_PIXELS,
} from "@repo/utils/brand-assets";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { FileTextIcon, ImageIcon, Trash2Icon, UploadIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
	type AssetDraft,
	type AssetErrorCode,
	type AssetKind,
	errorDataCode,
	isRejectionCode,
} from "./brand-kit-draft";

// The longest family name the theme writes (see `safeFontFamily`).
const MAX_FONT_FAMILY_LENGTH = 64;
// How long a file's PUT to storage may take before the slot gives up on it
// and stops holding Save.
const UPLOAD_TIMEOUT_MS = 60_000;

/** `10 MB`, `512 KB`: the caps the copy quotes, read from the vocabulary. */
function formatBytes(bytes: number): string {
	const mib = 1024 * 1024;
	return bytes >= mib ? `${bytes / mib} MB` : `${bytes / 1024} KB`;
}

/** One font: its family name and, as `children`, its optional file. */
export function FontField({
	id,
	legend,
	description,
	familyLabel,
	familyHelp,
	placeholder,
	value,
	error,
	disabled,
	onChange,
	children,
}: {
	id: string;
	legend: string;
	description: string;
	familyLabel: string;
	familyHelp: string;
	placeholder: string;
	value: string;
	error: string | null;
	disabled: boolean;
	onChange: (value: string) => void;
	children: ReactNode;
}) {
	const ids = {
		description: `${id}-description`,
		input: `${id}-family`,
		help: `${id}-family-help`,
		error: `${id}-family-error`,
	};
	return (
		<fieldset className="space-y-2" aria-describedby={ids.description}>
			<legend className="font-medium text-sm leading-none">
				{legend}
			</legend>
			<p id={ids.description} className="text-muted-foreground text-xs">
				{description}
			</p>
			<div className="space-y-2">
				<Label htmlFor={ids.input}>{familyLabel}</Label>
				<Input
					id={ids.input}
					type="text"
					className="max-w-sm"
					maxLength={MAX_FONT_FAMILY_LENGTH}
					spellCheck={false}
					autoComplete="off"
					placeholder={placeholder}
					aria-describedby={
						error ? `${ids.help} ${ids.error}` : ids.help
					}
					aria-invalid={Boolean(error)}
					value={value}
					disabled={disabled}
					onChange={(e) => onChange(e.target.value)}
				/>
				<p id={ids.help} className="text-muted-foreground text-xs">
					{familyHelp}
				</p>
				{error && (
					<p id={ids.error} className="text-destructive text-xs">
						{error}
					</p>
				)}
			</div>
			{children}
		</fieldset>
	);
}

export type AssetSlotLabels = {
	upload: string;
	remove: string;
	help: string;
	/** Names a stored file: the hero preview's alt, or a font's "uploaded". */
	stored: string;
	empty: string;
	uploading: (name: string) => string;
	uploaded: (name: string) => string;
	error: (code: AssetErrorCode) => string;
};

/** Each slot's copy, quoting the caps the shared vocabulary sets. */
export function useAssetSlotLabels(): Record<AssetKind, AssetSlotLabels> {
	const t = useTranslations("settings.brandKit");
	const fontSize = formatBytes(BRAND_ASSET_MAX_BYTES.font);
	const heroSize = formatBytes(BRAND_ASSET_MAX_BYTES.hero);
	const progress = {
		uploading: (name: string) => t("uploading", { name }),
		uploaded: (name: string) => t("uploaded", { name }),
	};
	const font = {
		...progress,
		help: t("fontFileHelp", { size: fontSize }),
		stored: t("fontFileStored"),
		empty: t("noFontFile"),
		error: (code: AssetErrorCode) =>
			t(`fontError.${code}`, { size: fontSize }),
	};
	return {
		hero: {
			...progress,
			upload: t("uploadHero"),
			remove: t("removeHero"),
			help: t("heroHelp", { size: heroSize }),
			stored: t("heroAlt"),
			empty: t("noHero"),
			error: (code) =>
				t(`heroError.${code}`, {
					size: heroSize,
					megapixels: HERO_MAX_INPUT_PIXELS / 1_000_000,
				}),
		},
		displayFont: {
			...font,
			upload: t("uploadDisplayFont"),
			remove: t("removeDisplayFont"),
		},
		bodyFont: {
			...font,
			upload: t("uploadBodyFont"),
			remove: t("removeBodyFont"),
		},
	};
}

/**
 * One Brand kit file — the hero or a font — through its states: idle,
 * uploading (the owner holds Save), ready (a preview or the file name, with
 * Remove) and rejected (by the browser's pre-check, the upload or the save,
 * each with the code the server uses).
 *
 * Owns the signed upload and nothing else: the owner holds the draft and
 * sends the token. The owner remounts it (a `key`) when the draft is read
 * again, so a stale message does not outlive the draft it described.
 */
export function AssetSlot({
	idPrefix,
	organizationId,
	kind,
	value,
	stored,
	canEdit,
	busy,
	rejectedCode,
	labels,
	onChange,
	onPendingChange,
}: {
	idPrefix: string;
	organizationId: string;
	kind: AssetKind;
	value: AssetDraft;
	/** The stored file: the hero's signed read, and whether one is stored. */
	stored: { previewUrl: string | null; present: boolean };
	canEdit: boolean;
	/** A save is in flight: hold every control still. */
	busy: boolean;
	/** Set by the owner when the save refused this slot's upload. */
	rejectedCode: BrandAssetRejectionCode | null;
	labels: AssetSlotLabels;
	onChange: (next: AssetDraft) => void;
	onPendingChange: (kind: AssetKind, pending: boolean) => void;
}) {
	const isHero = kind === "hero";
	const vocabulary = isHero ? "hero" : "font";
	const [uploadError, setUploadError] = useState<AssetErrorCode | null>(null);
	const [pendingName, setPendingName] = useState<string | null>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);

	// A new hero previews from the local file. The object URL is ours to
	// release: when the draft stops showing it, and when the slot unmounts.
	const objectUrlRef = useRef<string | null>(null);
	const releaseObjectUrl = () => {
		if (objectUrlRef.current) {
			URL.revokeObjectURL(objectUrlRef.current);
			objectUrlRef.current = null;
		}
	};
	const draftPreviewUrl =
		value.action === "replace" ? value.previewUrl : null;
	useEffect(() => {
		if (objectUrlRef.current !== draftPreviewUrl) {
			releaseObjectUrl();
		}
	}, [draftPreviewUrl]);
	useEffect(() => releaseObjectUrl, []);

	const uploadMutation = useMutation({
		mutationFn: async ({
			file,
			contentType,
		}: {
			file: File;
			contentType: string;
		}) => {
			const { token, signedUploadUrl } =
				await orpcClient.organizations.brandKit.createAssetUploadUrl({
					organizationId,
					kind,
					contentType,
					contentLength: file.size,
				});
			const response = await fetch(signedUploadUrl, {
				method: "PUT",
				body: file,
				headers: { "Content-Type": contentType },
				signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
			});
			if (!response.ok) {
				throw new Error("Brand kit upload failed");
			}
			return token;
		},
	});

	const pending = uploadMutation.isPending;
	useEffect(() => {
		onPendingChange(kind, pending);
	}, [pending]);
	// A remount mid-upload drops it, so it must not hold the owner's Save.
	useEffect(() => () => onPendingChange(kind, false), []);

	const upload = (file: File) => {
		setUploadError(null);
		const check = checkBrandAssetFile(vocabulary, file);
		if (!check.ok) {
			setUploadError(check.code);
			return;
		}
		setPendingName(file.name);
		// Per-call callbacks, not the mutation's: they do not run once the
		// slot unmounts, so a late answer cannot land in a reloaded draft.
		uploadMutation.mutate(
			{ file, contentType: check.contentType },
			{
				onSuccess: (token) => {
					releaseObjectUrl();
					const previewUrl =
						isHero && typeof URL.createObjectURL === "function"
							? URL.createObjectURL(file)
							: null;
					objectUrlRef.current = previewUrl;
					onChange({
						action: "replace",
						token,
						fileName: file.name,
						previewUrl,
					});
				},
				onError: (err) => {
					// The signer answers a type or size outside the
					// vocabulary with the pre-check's own code.
					const code = errorDataCode(err);
					setUploadError(
						isRejectionCode(code) ? code : "uploadFailed",
					);
				},
			},
		);
	};

	const hasFile =
		value.action === "replace" ||
		(value.action === "keep" && stored.present);
	const previewUrl =
		value.action === "replace"
			? value.previewUrl
			: value.action === "keep"
				? stored.previewUrl
				: null;
	// A refused save stops mattering once another file is picked.
	const shownError =
		uploadError ?? (value.action === "replace" ? null : rejectedCode);
	const helpId = `${idPrefix}-help`;

	return (
		<div className="space-y-2">
			<div className="flex flex-wrap items-center gap-4">
				{isHero ? (
					<div className="flex h-20 w-36 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted">
						{previewUrl ? (
							// biome-ignore lint/performance/noImgElement: a short-lived signed read or a local object URL, neither of which next/image can optimize
							<img
								src={previewUrl}
								alt={labels.stored}
								className="max-h-full max-w-full object-contain"
							/>
						) : (
							<ImageIcon
								className="size-6 text-muted-foreground"
								aria-label={
									hasFile ? labels.stored : labels.empty
								}
								role="img"
							/>
						)}
					</div>
				) : (
					<p className="flex min-w-0 items-center gap-2 text-sm">
						<FileTextIcon
							className="size-4 shrink-0 text-muted-foreground"
							aria-hidden="true"
						/>
						<span className="truncate">
							{value.action === "replace"
								? value.fileName
								: hasFile
									? labels.stored
									: labels.empty}
						</span>
					</p>
				)}
				{canEdit && (
					<div className="flex flex-wrap gap-2">
						{/* Out of the tab order and the accessibility tree: the
						    button below is the one control that opens it. */}
						<input
							ref={fileInputRef}
							id={`${idPrefix}-input`}
							type="file"
							hidden
							accept={brandAssetAcceptAttribute(vocabulary)}
							aria-label={labels.upload}
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
							loading={pending}
							disabled={busy}
							aria-describedby={helpId}
							onClick={() => fileInputRef.current?.click()}
						>
							<UploadIcon className="size-4" aria-hidden="true" />
							{labels.upload}
						</Button>
						{hasFile && (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								disabled={busy || pending}
								onClick={() => {
									releaseObjectUrl();
									setUploadError(null);
									onChange({ action: "remove" });
								}}
							>
								<Trash2Icon
									className="size-4"
									aria-hidden="true"
								/>
								{labels.remove}
							</Button>
						)}
					</div>
				)}
			</div>
			{canEdit && (
				<p id={helpId} className="text-muted-foreground text-xs">
					{labels.help}
				</p>
			)}
			{/* Always mounted (an implicit polite status), so screen readers
			    announce the upload's progress. */}
			<output className="block text-muted-foreground text-sm">
				{pending && pendingName
					? labels.uploading(pendingName)
					: value.action === "replace"
						? labels.uploaded(value.fileName)
						: null}
			</output>
			{shownError && (
				<p role="alert" className="text-destructive text-sm">
					{labels.error(shownError)}
				</p>
			)}
		</div>
	);
}
