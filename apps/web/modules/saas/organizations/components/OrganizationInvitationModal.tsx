"use client";

import { authClient } from "@repo/auth/client";
import { OrganizationLogo } from "@saas/organizations/components/OrganizationLogo";
import { organizationListQueryKey } from "@saas/organizations/lib/api";
import {
	acceptOrganizationInvitation,
	rejectOrganizationInvitation,
} from "@saas/organizations/lib/invitation-actions";
import { useRouter } from "@shared/hooks/router";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	ArrowRightIcon,
	CheckIcon,
	ClockIcon,
	LogInIcon,
	XCircleIcon,
	XIcon,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { withQuery } from "ufo";

export type InvitationState =
	| { type: "pending" }
	| { type: "expired" }
	| { type: "accepted" }
	| { type: "rejected" }
	| { type: "canceled" }
	| { type: "not_authenticated"; invitationId: string; email: string }
	| {
			type: "email_mismatch";
			invitationEmail: string;
			currentEmail: string;
	  };

export function OrganizationInvitationModal({
	invitationId,
	organizationName,
	organizationSlug,
	logoUrl,
	state,
}: {
	invitationId: string;
	organizationName: string;
	organizationSlug: string;
	logoUrl?: string;
	state: InvitationState;
}) {
	const t = useTranslations();
	const router = useRouter();
	const queryClient = useQueryClient();
	const [submitting, setSubmitting] = useState<false | "accept" | "reject">(
		false,
	);
	const [switching, setSwitching] = useState(false);

	const onSelectAnswer = async (accept: boolean) => {
		setSubmitting(accept ? "accept" : "reject");
		try {
			if (accept) {
				const result = await acceptOrganizationInvitation(invitationId);

				if (!result.success) {
					throw { code: result.code };
				}

				await queryClient.invalidateQueries({
					queryKey: organizationListQueryKey,
				});

				router.replace(`/app/${organizationSlug}`);
			} else {
				const result = await rejectOrganizationInvitation(invitationId);

				if (!result.success) {
					throw { code: result.code };
				}

				router.replace("/app");
			}
		} catch (e) {
			const code =
				e && typeof e === "object" && "code" in e
					? (e.code as string)
					: undefined;

			if (code === "INVITATION_NOT_FOUND") {
				toast.error(t("organizations.invitationModal.errorNotFound"));
			} else {
				toast.error(t("organizations.invitationModal.error"));
			}
		} finally {
			setSubmitting(false);
		}
	};

	const onSwitchAccount = (invitationEmail: string) => {
		setSwitching(true);
		authClient.signOut({
			fetchOptions: {
				onSuccess: () => {
					const params = new URLSearchParams({
						invitationId,
						email: invitationEmail,
					});
					window.location.href = new URL(
						`/auth/login?${params.toString()}`,
						window.location.origin,
					).toString();
				},
				onError: () => {
					setSwitching(false);
					toast.error(t("organizations.invitationModal.error"));
				},
			},
		});
	};

	const orgCard = (
		<div className="mb-6 flex items-center gap-3 rounded-lg border p-2">
			<OrganizationLogo
				name={organizationName}
				logoUrl={logoUrl}
				className="size-12"
			/>
			<div>
				<strong className="font-medium text-lg">
					{organizationName}
				</strong>
			</div>
		</div>
	);

	if (state.type === "expired") {
		return (
			<div>
				<h1 className="font-bold text-xl md:text-2xl">
					{t("organizations.invitationModal.expiredTitle")}
				</h1>
				<p className="mt-1 mb-6 text-foreground/60">
					{t("organizations.invitationModal.expiredDescription", {
						organizationName,
					})}
				</p>

				{orgCard}

				<div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-destructive text-sm">
					<ClockIcon className="size-4 shrink-0" />
					<span>
						{t("organizations.invitationModal.expiredNotice")}
					</span>
				</div>
			</div>
		);
	}

	if (state.type === "accepted") {
		return (
			<div>
				<h1 className="font-bold text-xl md:text-2xl">
					{t("organizations.invitationModal.alreadyAcceptedTitle")}
				</h1>
				<p className="mt-1 mb-6 text-foreground/60">
					{t(
						"organizations.invitationModal.alreadyAcceptedDescription",
						{ organizationName },
					)}
				</p>

				{orgCard}

				<Button
					className="w-full"
					onClick={() =>
						router.replace(
							organizationSlug
								? `/app/${organizationSlug}`
								: "/app",
						)
					}
				>
					{t("organizations.invitationModal.goToOrganization")}
					<ArrowRightIcon className="ml-1.5 size-4" />
				</Button>
			</div>
		);
	}

	if (state.type === "rejected") {
		return (
			<div>
				<h1 className="font-bold text-xl md:text-2xl">
					{t("organizations.invitationModal.alreadyRejectedTitle")}
				</h1>
				<p className="mt-1 mb-6 text-foreground/60">
					{t(
						"organizations.invitationModal.alreadyRejectedDescription",
						{ organizationName },
					)}
				</p>

				{orgCard}

				<Button
					className="w-full"
					variant="light"
					onClick={() => router.replace("/app")}
				>
					{t("organizations.invitationModal.goToDashboard")}
					<ArrowRightIcon className="ml-1.5 size-4" />
				</Button>
			</div>
		);
	}

	if (state.type === "canceled") {
		return (
			<div>
				<h1 className="font-bold text-xl md:text-2xl">
					{t("organizations.invitationModal.canceledTitle")}
				</h1>
				<p className="mt-1 mb-6 text-foreground/60">
					{t("organizations.invitationModal.canceledDescription", {
						organizationName,
					})}
				</p>

				{orgCard}

				<div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-destructive text-sm">
					<XCircleIcon className="size-4 shrink-0" />
					<span>
						{t("organizations.invitationModal.canceledNotice")}
					</span>
				</div>
			</div>
		);
	}

	if (state.type === "not_authenticated") {
		return (
			<div>
				<h1 className="font-bold text-xl md:text-2xl">
					{t("organizations.invitationModal.signInRequiredTitle")}
				</h1>
				<p className="mt-1 mb-6 text-foreground/60">
					{t(
						"organizations.invitationModal.signInRequiredDescription",
						{ organizationName },
					)}
				</p>

				{orgCard}

				<div className="flex gap-2">
					<Button className="flex-1" variant="light" asChild>
						<Link
							href={withQuery("/auth/signup", {
								invitationId: state.invitationId,
								email: state.email,
							})}
						>
							{t("organizations.invitationModal.signUp")}
						</Link>
					</Button>
					<Button className="flex-1" asChild>
						<Link
							href={withQuery("/auth/login", {
								invitationId: state.invitationId,
								email: state.email,
							})}
						>
							<LogInIcon className="mr-1.5 size-4" />
							{t("organizations.invitationModal.signIn")}
						</Link>
					</Button>
				</div>
			</div>
		);
	}

	if (state.type === "email_mismatch") {
		return (
			<div>
				<h1 className="font-bold text-xl md:text-2xl">
					{t("organizations.invitationModal.emailMismatchTitle")}
				</h1>
				<p className="mt-1 mb-6 text-foreground/60">
					{t(
						"organizations.invitationModal.emailMismatchDescription",
						{
							currentEmail: state.currentEmail,
							invitationEmail: state.invitationEmail,
						},
					)}
				</p>

				{orgCard}

				<Button
					className="w-full"
					variant="light"
					onClick={() => onSwitchAccount(state.invitationEmail)}
					disabled={switching}
					loading={switching}
				>
					<LogInIcon className="mr-1.5 size-4" />
					{switching
						? t("organizations.invitationModal.signingOut")
						: t(
								"organizations.invitationModal.signInWithDifferentAccount",
							)}
				</Button>

				<p className="mt-4 text-foreground/60 text-sm">
					{t("organizations.invitationModal.providerHint", {
						currentEmail: state.currentEmail,
					})}
				</p>
			</div>
		);
	}

	// state.type === "pending"
	return (
		<div>
			<h1 className="font-bold text-xl md:text-2xl">
				{t("organizations.invitationModal.title")}
			</h1>
			<p className="mt-1 mb-6 text-foreground/60">
				{t("organizations.invitationModal.description", {
					organizationName,
				})}
			</p>

			{orgCard}

			<div className="flex gap-2">
				<Button
					className="flex-1"
					variant="light"
					onClick={() => onSelectAnswer(false)}
					disabled={!!submitting}
					loading={submitting === "reject"}
				>
					<XIcon className="mr-1.5 size-4" />
					{t("organizations.invitationModal.decline")}
				</Button>
				<Button
					className="flex-1"
					onClick={() => onSelectAnswer(true)}
					disabled={!!submitting}
					loading={submitting === "accept"}
				>
					<CheckIcon className="mr-1.5 size-4" />
					{t("organizations.invitationModal.accept")}
				</Button>
			</div>
		</div>
	);
}
