terraform {
  required_version = ">= 1.7.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.50" }
  }
}

module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.20"

  cluster_name    = var.cluster_name
  cluster_version = var.kubernetes_version

  vpc_id     = var.vpc_id
  subnet_ids = var.private_subnet_ids

  cluster_endpoint_public_access       = true
  cluster_endpoint_public_access_cidrs = var.public_access_cidrs
  cluster_endpoint_private_access      = true

  cluster_encryption_config = {
    provider_key_arn = var.kms_key_arn
    resources        = ["secrets"]
  }

  # aws-ebs-csi-driver is NOT in this map — adding it here while also referencing
  # `aws_iam_role.ebs_csi.arn` (whose trust policy depends on this module's OIDC
  # outputs) creates a graph cycle: module.eks input → ebs_csi role → module.eks
  # outputs. The add-on is created as a separate `aws_eks_addon` resource below,
  # which depends on `module.eks.cluster_name` (just an output) and breaks the cycle.
  cluster_addons = {
    coredns    = { most_recent = true }
    kube-proxy = { most_recent = true }
    vpc-cni = {
      # Enable VPC CNI NetworkPolicy enforcement so the Helm chart's NetworkPolicy
      # objects (prod default-deny + allow; networkPolicy.enabled=true) are actually
      # enforced — without it they are silent no-ops and pods stay unrestricted.
      # Requires VPC CNI >= 1.14 + EKS >= 1.25 (cluster is 1.34 + most_recent CNI).
      most_recent = true
      configuration_values = jsonencode({
        enableNetworkPolicy = "true"
      })
    }
  }

  # The IAM principal running terraform apply gets cluster-admin via EKS Access Entry
  # so they can kubectl from the laptop. Production should narrow this.
  enable_cluster_creator_admin_permissions = true

  eks_managed_node_groups = {
    default = {
      instance_types = var.node_instance_types
      desired_size   = var.node_desired_size
      min_size       = var.node_min_size
      max_size       = var.node_max_size

      # Root volume for the app workload. The module uses a custom launch template by
      # default, so block_device_mappings (not disk_size) is the reliable way to size
      # the root EBS volume. gp3 at the default 125 MB/s / 3000 IOPS is plenty now that
      # CI builds run on GitLab SaaS (the old Kaniko throughput/IOPS bump is gone).
      # gp3 + encrypted (AWS-managed aws/ebs key — no extra KMS grant needed).
      block_device_mappings = {
        xvda = {
          device_name = "/dev/xvda"
          ebs = {
            volume_size           = var.node_disk_size
            volume_type           = "gp3"
            delete_on_termination = true
            encrypted             = true
          }
        }
      }

      iam_role_additional_policies = {
        ECR = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
      }
    }
  }

  tags = var.tags
}

# --- EBS CSI driver IRSA role ---
# The aws-ebs-csi-driver add-on's controller (Deployment ebs-csi-controller in
# kube-system, ServiceAccount ebs-csi-controller-sa) needs AmazonEBSCSIDriverPolicy
# to create / attach / detach / delete EBS volumes for PVCs. The OIDC subject is
# fixed by the add-on.
data "aws_iam_policy_document" "ebs_csi_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [module.eks.oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${replace(module.eks.cluster_oidc_issuer_url, "https://", "")}:sub"
      values   = ["system:serviceaccount:kube-system:ebs-csi-controller-sa"]
    }
    condition {
      test     = "StringEquals"
      variable = "${replace(module.eks.cluster_oidc_issuer_url, "https://", "")}:aud"
      values   = ["sts.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ebs_csi" {
  name               = "${var.cluster_name}-ebs-csi"
  assume_role_policy = data.aws_iam_policy_document.ebs_csi_assume.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "ebs_csi" {
  role       = aws_iam_role.ebs_csi.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy"
}

# Out-of-module add-on installation. The upstream EKS module's cluster_addons
# input is evaluated at module-instantiation time, so passing the role ARN
# there creates a cycle (see comment on cluster_addons above). Installing the
# add-on separately keeps the IAM role <- OIDC dependency contained outside the
# module input graph.
resource "aws_eks_addon" "ebs_csi" {
  cluster_name                = module.eks.cluster_name
  addon_name                  = "aws-ebs-csi-driver"
  service_account_role_arn    = aws_iam_role.ebs_csi.arn
  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "OVERWRITE"

  tags = var.tags

  depends_on = [aws_iam_role_policy_attachment.ebs_csi]
}
