"use client";

import { authClient } from "@repo/auth/client";
import { useSession } from "@saas/auth/hooks/use-session";
import { Spinner } from "@shared/components/Spinner";
import { UserAvatar } from "@shared/components/UserAvatar";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { CameraIcon, Trash2Icon, UploadIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useDropzone } from "react-dropzone";
import { CropImageDialog } from "./CropImageDialog";

export function UserAvatarUpload({
	onSuccess,
	onError,
	onDeleteSuccess = () => {},
	onDeleteError = () => {},
}: {
	onSuccess: () => void;
	onError: () => void;
	onDeleteSuccess?: () => void;
	onDeleteError?: () => void;
}) {
	const t = useTranslations();
	const { user, reloadSession } = useSession();
	const [uploading, setUploading] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [cropDialogOpen, setCropDialogOpen] = useState(false);
	const [image, setImage] = useState<File | null>(null);

	const getSignedUploadUrlMutation = useMutation(
		orpc.users.avatarUploadUrl.mutationOptions(),
	);

	const busy = uploading || deleting;

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
		disabled: busy,
	});

	if (!user) {
		return null;
	}

	const onDeleteAvatar = async (e: React.MouseEvent) => {
		e.stopPropagation();
		setDeleting(true);
		try {
			const { error } = await authClient.updateUser({ image: null });
			if (error) {
				throw error;
			}
			await reloadSession();
			onDeleteSuccess();
		} catch {
			onDeleteError();
		} finally {
			setDeleting(false);
		}
	};

	const onCrop = async (croppedImageData: Blob | null) => {
		if (!croppedImageData) {
			return;
		}

		setUploading(true);
		try {
			const { signedUploadUrl, path } =
				await getSignedUploadUrlMutation.mutateAsync({});

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

			const { error } = await authClient.updateUser({
				image: path,
			});

			if (error) {
				throw error;
			}

			await reloadSession();

			onSuccess();
		} catch {
			onError();
		} finally {
			setUploading(false);
		}
	};

	return (
		<>
			<div className="flex flex-wrap items-center gap-5">
				<div
					className="group relative size-24 shrink-0 rounded-md"
					{...getRootProps()}
				>
					<input {...getInputProps()} />
					<UserAvatar
						className="size-24 cursor-pointer rounded-md text-xl"
						avatarUrl={user.image}
						name={user.name ?? ""}
					/>
					<div
						aria-hidden="true"
						className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-md bg-background/70 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
					>
						<CameraIcon className="size-5 text-foreground" />
					</div>

					{busy && (
						<div className="absolute inset-0 z-20 flex items-center justify-center rounded-md bg-card/90">
							<Spinner className="size-6" />
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
							disabled={busy}
						>
							<UploadIcon className="size-4" />
							{user.image
								? t("organizations.settings.logo.replace")
								: t("organizations.settings.logo.change")}
						</Button>
						{user.image ? (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={onDeleteAvatar}
								disabled={busy}
								aria-label="Remove avatar"
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
				title="Crop your photo"
				image={image}
				open={cropDialogOpen}
				onOpenChange={setCropDialogOpen}
				onCrop={onCrop}
			/>
		</>
	);
}
