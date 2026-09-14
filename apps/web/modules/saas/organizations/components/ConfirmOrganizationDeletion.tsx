"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation } from "@tanstack/react-query";
import { Alert, AlertDescription } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

/**
 * The page the emailed confirmation link lands on (Fizzy #2462).
 *
 * IT REQUIRES A CLICK, AND THAT IS THE WHOLE POINT OF THE PAGE EXISTING.
 * Redeeming the token on GET — the obvious shape, and the one the auth library
 * uses for account deletion — would hand the trigger to anything that follows
 * links without being asked: mail scanners, security gateways, link previewers,
 * browser prefetch. An organization must not be deleted by an antivirus crawler
 * that opened someone's inbox.
 *
 * So the link only *shows* this page. Nothing has happened when it loads, and
 * the copy says so.
 *
 * `organizationName` is resolved server-side from the token — see the page —
 * and is `null` when the link is expired, already spent, or was issued to
 * someone else. Named copy is used whenever it resolves, because this is the
 * last screen before a tenant goes dark and "this organization" does not answer
 * the one question worth asking at it. The unnamed strings stay as the fallback
 * rather than printing an error: an invalid link still gets the page, and
 * `confirm` owns the single refusal message for every way it can be invalid.
 */
export function ConfirmOrganizationDeletion({
	token,
	retentionDays,
	organizationName,
}: {
	token: string;
	retentionDays: number;
	/** Null when the token could not be resolved — see the note above. */
	organizationName: string | null;
}) {
	const t = useTranslations();
	const router = useRouter();

	const confirmMutation = useMutation({
		mutationFn: () => orpcClient.organizations.deletion.confirm({ token }),
		onSuccess: (result) => {
			toast.success(
				t("organizations.confirmDeletion.deleted", {
					organizationName: result.organizationName,
					days: result.retentionDays,
				}),
			);
			// Routing from here is membership-based: another organization if
			// they have one, the creation page if this was their last — and
			// that page carries the restore banner.
			router.replace("/app");
		},
		onError: () => {
			toast.error(t("organizations.confirmDeletion.failed"));
		},
	});

	return (
		<div className="flex flex-col gap-6">
			<div className="flex flex-col gap-2">
				<h1 className="font-medium text-2xl">
					{organizationName
						? t("organizations.confirmDeletion.titleNamed", {
								organizationName,
							})
						: t("organizations.confirmDeletion.title")}
				</h1>
				<p className="text-muted-foreground text-sm">
					{organizationName
						? t("organizations.confirmDeletion.descriptionNamed", {
								organizationName,
							})
						: t("organizations.confirmDeletion.description")}
				</p>
			</div>

			<Alert variant="error">
				<AlertDescription>
					{t("organizations.confirmDeletion.warning", {
						days: retentionDays,
					})}
				</AlertDescription>
			</Alert>

			<div className="flex flex-wrap justify-end gap-2">
				<Button
					variant="outline"
					onClick={() => router.replace("/app")}
					disabled={confirmMutation.isPending}
				>
					{t("common.confirmation.cancel")}
				</Button>
				<Button
					variant="error"
					onClick={() => confirmMutation.mutate()}
					loading={confirmMutation.isPending}
				>
					{t("organizations.confirmDeletion.submit")}
				</Button>
			</div>
		</div>
	);
}
