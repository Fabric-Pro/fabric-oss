-- A repository integration may run with a credential from the credential
-- manager instead of its own stored tokens.
ALTER TABLE "project_repository_integration" ADD COLUMN "credentialId" TEXT;
