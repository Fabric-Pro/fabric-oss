"use client";

import { authClient } from "@repo/auth/client";
import { config } from "@repo/config";
import { Button } from "@ui/components/button";
import { parseAsString, useQueryState } from "nuqs";
import { oAuthProviders } from "../constants/oauth-providers";

export function SocialSigninButton({
	provider,
	className,
	disabled = false,
	callbackURL,
}: {
	provider: keyof typeof oAuthProviders;
	className?: string;
	disabled?: boolean;
	callbackURL?: string;
}) {
	const [invitationId] = useQueryState("invitationId", parseAsString);
	const providerData = oAuthProviders[provider];

	const redirectPath =
		callbackURL ??
		(invitationId
			? `/organization-invitation/${invitationId}`
			: config.auth.redirectAfterSignIn);

	const onSignin = () => {
		if (disabled) {
			return;
		}

		const resolvedCallbackURL = new URL(
			redirectPath,
			window.location.origin,
		);
		authClient.signIn.social({
			provider,
			callbackURL: resolvedCallbackURL.toString(),
		});
	};

	return (
		<Button
			onClick={() => onSignin()}
			variant="light"
			type="button"
			className={className}
			disabled={disabled}
		>
			{providerData.icon && (
				<i className="mr-2 text-primary">
					<providerData.icon className="size-4" />
				</i>
			)}
			{providerData.name}
		</Button>
	);
}
