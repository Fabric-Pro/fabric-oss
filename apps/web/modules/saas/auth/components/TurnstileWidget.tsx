"use client";

import { Turnstile } from "@marsidev/react-turnstile";
import { config } from "@repo/config";
import { useTheme } from "next-themes";

interface TurnstileWidgetProps {
	onSuccess: (token: string) => void;
	onError?: () => void;
	onExpire?: () => void;
	resetKey?: number;
}

export function TurnstileWidget({
	onSuccess,
	onError,
	onExpire,
	resetKey,
}: TurnstileWidgetProps) {
	const { resolvedTheme } = useTheme();

	if (!config.auth.captcha.enabled || !config.auth.captcha.siteKey) {
		return null;
	}

	return (
		<Turnstile
			key={resetKey}
			siteKey={config.auth.captcha.siteKey}
			onSuccess={onSuccess}
			onError={onError}
			onExpire={onExpire}
			options={{
				theme: resolvedTheme === "dark" ? "dark" : "light",
				size: "flexible",
			}}
		/>
	);
}
