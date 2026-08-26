import { AiCreditsBanner } from "@saas/payments/components/AiCreditsStatus";
import { AppWrapper } from "@saas/shared/components/AppWrapper";
import { MfaSetupBanner } from "@saas/shared/components/MfaSetupBanner";
import type { PropsWithChildren } from "react";

export default function UserLayout({ children }: PropsWithChildren) {
	return (
		<AppWrapper>
			<AiCreditsBanner />
			<MfaSetupBanner />
			{children}
		</AppWrapper>
	);
}
