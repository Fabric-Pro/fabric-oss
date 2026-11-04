/** Only Databricks-controlled workspace origins may receive stored credentials. */
export function validateDatabricksWorkspaceOrigin(value: string): string {
	const suffixes = [
		"azuredatabricks.net",
		"cloud.databricks.com",
		"gcp.databricks.com",
		"databricks.azure.cn",
		"databricks.azure.us",
		"cloud.databricks.us",
		"cloud.databricks.mil",
	];
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		throw new Error(
			"Use an HTTPS Databricks workspace origin on a supported Databricks domain",
		);
	}
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash ||
		url.port ||
		!suffixes.some((suffix) =>
			url.hostname.toLowerCase().endsWith(`.${suffix}`),
		)
	) {
		throw new Error(
			"Use an HTTPS Databricks workspace origin on a supported Databricks domain, without credentials, a path, query, fragment, IP address, or non-default port",
		);
	}
	return url.origin;
}
