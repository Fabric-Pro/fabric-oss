"use client";

import { authClient } from "@repo/auth/client";
import { useSession } from "@saas/auth/hooks/use-session";
import { Spinner } from "@shared/components/Spinner";
import { UserAvatar } from "@shared/components/UserAvatar";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation } from "@tanstack/react-query";
import { X } from "lucide-react";
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
	const { user, reloadSession } = useSession();
	const [uploading, setUploading] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [cropDialogOpen, setCropDialogOpen] = useState(false);
	const [image, setImage] = useState<File | null>(null);

	const getSignedUploadUrlMutation = useMutation(
		orpc.users.avatarUploadUrl.mutationOptions(),
	);

	const busy = uploading || deleting;

	const { getRootProps, getInputProps } = useDropzone({
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
			<div className="relative size-24">
				<div
					className="relative size-24 rounded-full"
					{...getRootProps()}
				>
					<input {...getInputProps()} />
					<UserAvatar
						className="size-24 cursor-pointer text-xl"
						avatarUrl={user.image}
						name={user.name ?? ""}
					/>

					{busy && (
						<div className="absolute inset-0 z-20 flex items-center justify-center bg-card/90 rounded-full">
							<Spinner className="size-6" />
						</div>
					)}
				</div>

				{user.image && !busy && (
					<button
						type="button"
						onClick={onDeleteAvatar}
						className="absolute -top-1 -right-1 z-10 flex size-6 items-center justify-center rounded-full bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90 transition-colors"
						aria-label="Remove avatar"
					>
						<X className="size-3.5" />
					</button>
				)}
			</div>

			<CropImageDialog
				image={image}
				open={cropDialogOpen}
				onOpenChange={setCropDialogOpen}
				onCrop={onCrop}
			/>
		</>
	);
}
