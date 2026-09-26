---
"fabric-app": patch
---

Self-hosted AWS deployments now start in production and verify the database's TLS certificate: the Terraform-built database URLs require verified TLS against the Amazon RDS certificate authorities, which the Helm chart now mounts in every pod.

Before, the URLs carried no `sslmode`. The application's production guard therefore refused to start unless `FABRIC_ALLOW_INSECURE_DB=true` was set, and even then the chart's `PGSSLMODE=no-verify` encrypted the connection without checking the server.

`DATABASE_URL` and `WORKER_DATABASE_URL` now use `sslmode=verify-full&sslrootcert=/etc/fabric/rds/global-bundle.pem`. `DIRECT_URL`, read only by `prisma migrate`, uses Prisma's own verifying form (`sslcert` + `sslaccept=strict`), because Prisma ignores libpq's `sslrootcert`. The chart ships the public RDS CA bundle as the `fabric-rds-ca` ConfigMap, mounted read-only at `/etc/fabric/rds` in every Fabric Deployment and in the migrate and seed jobs.

Existing installs keep their old secret (Terraform ignores changes to it): add the new query strings to the three URLs in Secrets Manager, then `helm upgrade` (`docs/deployment/ENVIRONMENT-VARIABLES.md` §3.1).
