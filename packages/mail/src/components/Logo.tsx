import { Img } from "@react-email/components";
import React from "react";

// Email images MUST be publicly accessible — localhost URLs cannot be
// reached by email clients.  Use NEXT_PUBLIC_SITE_URL when it points to
// a real host (staging / production), otherwise fall back to production.
const PRODUCTION_URL = "https://fabric.pro";

function getEmailBaseUrl() {
	const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;
	if (siteUrl && !siteUrl.includes("localhost")) {
		return siteUrl.replace(/\/+$/, "");
	}
	return PRODUCTION_URL;
}

// Use the black logo so it is visible on the light card background (#fbfaf8).
const EMAIL_LOGO_URL = `${getEmailBaseUrl()}/images/fabric-black-logo.png`;

export function Logo() {
	return (
		<Img
			src={EMAIL_LOGO_URL}
			alt="Fabric AI"
			width={180}
			height={42}
			style={{ marginBottom: "16px" }}
		/>
	);
}
