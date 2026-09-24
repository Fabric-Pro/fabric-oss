---
"fabric-app": patch
---

Repository connections now store a canonical repository URL: user credentials in the URL are stripped (so Azure DevOps Clone-button URLs connect), and URLs carrying a query string, a fragment, or a non-default port are rejected with a clear error, as is a GitHub/GitLab OAuth connection whose repository URL names a different repository than the one selected.

Previously the raw caller-supplied `repositoryUrl` was stored verbatim on connect, so a query string or fragment (for example an access token or ref pointer) could reach the database, every clone-URL builder, and an LLM prompt, while a URL carrying userinfo (the shape Azure DevOps's own "Clone" button produces) was refused outright. The shared parser now strips userinfo instead of refusing it, refuses a query string, fragment, or non-default port with a clear error, and normalizes the stored form to `origin + pathname` with no trailing slash and no trailing `.git`. The GitHub and GitLab OAuth connection flows also now verify that a caller-supplied repository URL actually names the repository the user selected, both when the connection starts and when it completes, refusing a mismatch instead of storing it. This applies to the manual connect flow, the existing-project setup flow, and the GitHub and GitLab OAuth flows.
