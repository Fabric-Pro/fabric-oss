import { AppWrapper } from "@saas/shared/components/AppWrapper";
import { MfaSetupBanner } from "@saas/shared/components/MfaSetupBanner";
import type { PropsWithChildren } from "react";

export default function UserLayout({ children }: PropsWithChildren) {
	return (
		<AppWrapper>
			<MfaSetupBanner />
			{children}
		</AppWrapper>
	);
}
