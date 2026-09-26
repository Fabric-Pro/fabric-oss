---
"fabric-app": patch
---

Self-hosted AWS deployments now encrypt service-to-service traffic inside the cluster: the Terraform profiles default to node types that encrypt traffic between instances, and `terraform plan` refuses node types that do not.

The chart's in-cluster calls (web, agents, the MCP wrapper, Qdrant) are plain HTTP/gRPC on cluster DNS. On the previous `t3` defaults that traffic crossed the VPC unencrypted; `m6i` nodes encrypt it in hardware with nothing to rotate. The dev profile moves from `t3.large` to `m6i.large` and the prod profile from `t3.xlarge` to `m6i.xlarge` (same vCPU and memory). Changing the type replaces the managed node group on the next apply. The Azure template gains an `enablePeerTrafficEncryption` parameter (default off) that turns on Container Apps peer-to-peer encryption, which covers the edge-to-replica hop that is otherwise plaintext.
