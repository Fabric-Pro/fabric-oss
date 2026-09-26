mock_provider "aws" {
  override_data {
    target = data.aws_iam_policy_document.ebs_csi_assume
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
}

override_module {
  target = module.eks
  outputs = {
    cluster_name            = "fixture"
    oidc_provider_arn       = "arn:aws:iam::123456789012:oidc-provider/oidc.eks.us-east-1.amazonaws.com/id/FIXTURE"
    cluster_oidc_issuer_url = "https://oidc.eks.us-east-1.amazonaws.com/id/FIXTURE"
  }
}

variables {
  cluster_name       = "fixture"
  vpc_id             = "vpc-fixture"
  private_subnet_ids = ["subnet-a", "subnet-b"]
  kms_key_arn        = "arn:aws:kms:us-east-1:123456789012:key/fixture"
}

# t3 cannot encrypt traffic between instances -> the plan must fail on the guard.
run "rejects_node_type_without_transit_encryption" {
  command = plan

  variables {
    node_instance_types = ["t3.large"]
  }

  override_data {
    target = data.aws_ec2_instance_type.node
    values = { encryption_in_transit_supported = false }
  }

  expect_failures = [data.aws_ec2_instance_type.node]
}

# The explicit opt-out for a throwaway cluster lets the same type through.
run "opt_out_allows_it" {
  command = plan

  variables {
    node_instance_types           = ["t3.large"]
    require_encryption_in_transit = false
  }

  override_data {
    target = data.aws_ec2_instance_type.node
    values = { encryption_in_transit_supported = false }
  }
}

# A Nitro type that encrypts in transit (the new defaults) plans cleanly.
run "accepts_nitro_encrypting_type" {
  command = plan

  variables {
    node_instance_types = ["m6i.large"]
  }

  override_data {
    target = data.aws_ec2_instance_type.node
    values = { encryption_in_transit_supported = true }
  }
}
