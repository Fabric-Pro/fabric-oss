import { Button } from "@react-email/components";
import React, { type PropsWithChildren } from "react";

export default function PrimaryButton({
	href,
	children,
}: PropsWithChildren<{
	href: string;
}>) {
	return (
		<Button
			href={href}
			className="rounded-md bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground"
		>
			{children}
		</Button>
	);
}
