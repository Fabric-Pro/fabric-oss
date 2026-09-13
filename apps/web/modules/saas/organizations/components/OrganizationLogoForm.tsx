"use client";

import { authClient } from "@repo/auth/client";
import { useActiveOrganization } from "@saas/organizations/hooks/use-active-organization";
import { organizationListQueryKey } from "@saas/organizations/lib/api";
import { SettingsItem } from "@saas/shared/components/SettingsItem";
import { Spinner } from "@shared/components/Spinner";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { CameraIcon, Trash2Icon, UploadIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useDropzone } from "react-dropzone";
import { toast } from "sonner";
import { CropImageDialog } from "../../settings/components/CropImageDialog";
import { OrganizationLogo } from "./OrganizationLogo";

export function OrganizationLogoForm() {
	const t = useTranslations();
	const [uploading, setUploading] = useState(false);
	const [removing, setRemoving] = useState(false);
	const [cropDialogOpen, setCropDialogOpen] = useState(false);
	const [image, setImage] = useState<File | null>(null);
	const { activeOrganization, refetchActiveOrganization } =
		useActiveOrganization();
	const queryClient = useQueryClient();
	const getSignedUploadUrlMutation = useMutation(
		orpc.organizations.createLogoUploadUrl.mutationOptions(),
	);

	const { getRootProps, getInputProps, open } = useDropzone({
		onDrop: (acceptedFiles) => {
			setImage(acceptedFiles[0]);
			setCropDialogOpen(true);
		},
		accept: {
			"image/png": [".png"],
			"image/jpeg": [".jpg", ".jpeg"],
		},
		multiple: false,
	});

	if (!activeOrganization) {
		return null;
	}

	const onCrop = async (croppedImageData: Blob | null) => {
		if (!croppedImageData) {
			return;
		}

		setUploading(true);
		try {
			const { signedUploadUrl, path } =
				await getSignedUploadUrlMutation.mutateAsync({
					organizationId: activeOrganization.id,
				});

			if (!signedUploadUrl) {
				throw new Error(
					"Storage provider does not support direct uploads",
				);
			}

			const response = await fetch(signedUploadUrl, {
				method: "PUT",
				body: croppedImageData,
				headers: {
					"Content-Type": "image/png",
				},
			});

			if (!response.ok) {
				throw new Error("Failed to upload image");
			}

			const { error } = await authClient.organization.update({
				organizationId: activeOrganization.id,
				data: {
					logo: path,
				},
			});

			if (error) {
				throw error;
			}

			toast.success(t("settings.account.avatar.notifications.success"));

			refetchActiveOrganization();
			queryClient.invalidateQueries({
				queryKey: organizationListQueryKey,
			});
		} catch {
			toast.error(t("settings.account.avatar.notifications.error"));
		} finally {
			setUploading(false);
		}
	};

	const onRemove = async () => {
		setRemoving(true);
		try {
			const { error } = await authClient.organization.update({
				organizationId: activeOrganization.id,
				data: { logo: null },
			});
			if (error) {
				throw error;
			}
			toast.success(
				t("settings.account.avatar.notifications.deleteSuccess"),
			);
			refetchActiveOrganization();
			queryClient.invalidateQueries({
				queryKey: organizationListQueryKey,
			});
		} catch {
			toast.error(t("settings.account.avatar.notifications.deleteError"));
		} finally {
			setRemoving(false);
		}
	};

	return (
		<SettingsItem
			title={t("organizations.settings.logo.title")}
			description={t("organizations.settings.logo.description")}
		>
			{/* The mark alone gave no hint that it could be changed. A visible
			    button does the asking; the mark itself still accepts a click or
			    a dropped file, and shows a camera on hover to say so. */}
			<div className="flex flex-wrap items-center gap-5">
				<div
					className="group relative size-24 shrink-0 rounded-md"
					{...getRootProps()}
				>
					<input {...getInputProps()} />
					<OrganizationLogo
						className="size-24 cursor-pointer text-xl"
						logoUrl={activeOrganization.logo}
						name={activeOrganization.name ?? ""}
					/>
					<div
						aria-hidden="true"
						className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-md bg-background/70 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
					>
						<CameraIcon className="size-5 text-foreground" />
					</div>

					{(uploading || removing) && (
						<div className="absolute inset-0 z-20 flex items-center justify-center rounded-md bg-card/90">
							<Spinner />
						</div>
					)}
				</div>
				<div className="space-y-1.5">
					<div className="flex flex-wrap items-center gap-2">
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={open}
							disabled={uploading || removing}
						>
							<UploadIcon className="size-4" />
							{activeOrganization.logo
								? t("organizations.settings.logo.replace")
								: t("organizations.settings.logo.change")}
						</Button>
						{/* Only once there is a logo to remove: the monogram is the
						    default, not something that can be taken away. */}
						{activeOrganization.logo ? (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={onRemove}
								disabled={uploading || removing}
								className="text-muted-foreground hover:text-destructive"
							>
								<Trash2Icon className="size-4" />
								{t("organizations.settings.logo.remove")}
							</Button>
						) : null}
					</div>
					<p className="max-w-xs text-muted-foreground text-xs">
						{t("organizations.settings.logo.hint")}
					</p>
				</div>
			</div>

			<CropImageDialog
				title="Crop your logo"
				image={image}
				open={cropDialogOpen}
				onOpenChange={setCropDialogOpen}
				onCrop={onCrop}
			/>
		</SettingsItem>
	);
}
