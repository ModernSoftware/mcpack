# AWS deployment runbook

Use a disposable AWS account/project and synthetic data only. No command here
runs automatically. Prerequisites: AWS CLI v2 authenticated to the intended
account, Terraform 1.13.5, Docker buildx, Python, and an issued ACM certificate
in the selected region for a DNS name you control. Check the account with
`aws sts get-caller-identity` before applying.

## Layout and security boundaries

HTTPS ALB -> MCP Fargate service -> private RDS / S3 / internal refund service.
MCP and refund services have separate task roles and DB roles. Only the seed task
receives RDS admin credentials. Task roles provide S3 access; no long-lived AWS
keys are injected. Secrets Manager provides service tokens and DB passwords.
RDS uses certificate-verified TLS. The bucket blocks public access and denies
non-TLS requests. Refund traffic stays inside the VPC using HTTP plus a separate
service token; add service-to-service TLS for environments requiring it.

To avoid NAT gateway costs this PoC gives tasks public IPs, but security groups
accept MCP traffic only from the ALB and refund traffic only from MCP tasks.
RDS is in private subnets. Outbound task traffic is unrestricted. This is a
cost/complexity tradeoff, not a recommendation for every production network.
Restrict `allowed_client_cidrs` to your test machine/network; do not default to
the entire internet. Public health endpoints return service status, not secrets.

**Costs:** ALB, Fargate, RDS, public IPv4, Secrets Manager, CloudWatch, ECR, S3
and transfer incur charges while provisioned. Bedrock is extra and optional.
No free-tier promise. Review an AWS estimate and budget before applying.

**State contains secrets.** Use an encrypted, access-controlled remote backend
for team usage (configure your own backend before init), or protect local state
and backups. Never commit state, plans, or real tfvars. Secret rotation requires
coordinating DB roles and task restarts; automatic rotation is not configured.

## 1. Bootstrap the image registry

From the repository root, export your intended `AWS_REGION` (and `AWS_PROFILE`
if applicable). Keep that region consistent in both Terraform roots.

```bash
export AWS_REGION=us-east-1
terraform -chdir=examples/support-desk/infra/bootstrap init
terraform -chdir=examples/support-desk/infra/bootstrap apply -var="region=$AWS_REGION"
repository=$(terraform -chdir=examples/support-desk/infra/bootstrap output -raw repository_url)
registry=${repository%%/*}
aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$registry"
image_tag=$(git rev-parse --short=12 HEAD)
docker buildx build --platform linux/amd64 --target support-desk \
  -t "$repository:$image_tag" --push .
digest=$(aws ecr describe-images --repository-name "${repository#*/}" \
  --image-ids imageTag="$image_tag" --query 'imageDetails[0].imageDigest' --output text)
printf 'Use this immutable container_image: %s@%s\n' "$repository" "$digest"
```

ECR tags are immutable. Use a new commit/tag for a new build.

## 2. Provision with services stopped

Copy `infra/terraform/terraform.tfvars.example` to `terraform.tfvars` in that
same directory. Supply region, hostname, certificate ARN, your client IPv4 CIDR
(e.g. your public IP `/32`), and the image digest from above. Leave
`start_services = false`. Set `zone_id` to manage a Route53 alias, or create a
DNS CNAME yourself from hostname to the `load_balancer_dns` output.

```bash
terraform -chdir=examples/support-desk/infra/terraform init
terraform -chdir=examples/support-desk/infra/terraform plan -out=review.tfplan
terraform -chdir=examples/support-desk/infra/terraform apply review.tfplan
```

RDS creation takes time. Check the plan before approving. Terraform validation
alone cannot verify account quotas, certificate ownership, region capabilities,
IAM permissions, DNS or successful task startup.

## 3. Seed, then start

```bash
bash examples/support-desk/scripts/seed-aws.sh
# Update start_services=true in your tfvars, then:
terraform -chdir=examples/support-desk/infra/terraform apply
```

The helper waits for the seed task and fails on a nonzero exit code. Inspect the
seed stream in the `/ecs/<name>` CloudWatch log group if it fails. Seeding is
rerunnable and does not delete refunds. Do not run it with untrusted data.
Wait for ECS deployments and ALB targets to become healthy before testing.

## 4. Test over the public network

```bash
export MCP_URL=$(terraform -chdir=examples/support-desk/infra/terraform output -raw mcp_url)
secret_arn=$(terraform -chdir=examples/support-desk/infra/terraform output -raw mcp_token_secret_arn)
export MCPACK_HTTP_TOKEN=$(aws secretsmanager get-secret-value --secret-id "$secret_arn" --query SecretString --output text)
node examples/support-desk/test/integration.mjs
node examples/support-desk/test/load.mjs
unset MCPACK_HTTP_TOKEN
```

Do not print the token, put it in shell tracing, or commit it. The cloud simulator
has fault injection disabled. Do not set `REFUND_API_URL` for the public tests:
the API is intentionally not exposed to your workstation.

MCP HTTP is stateless at the transport layer in this sample; durable business
state lives in PostgreSQL. Increase `replicas` to two, repeat tests and compare
measurements. Do not infer production capacity from 10K rows or a short load
smoke test. Interrupt a task using ECS, repeat reads and reconcile any uncertain
write by its idempotency key. Never automatically retry writes with new keys.

## 5. Tear down deliberately

Default data deletion protection is on. For disposable data only, set
`allow_destroy_data=true`, apply that change to remove RDS deletion protection,
then destroy the application Terraform root. This permits database deletion
without a final snapshot and emptying the document bucket. Keep the default and
plan snapshots/backups if you need the data.

The ECR bootstrap is separate and does not force-delete images. Delete the
specific experiment images deliberately, then destroy that root. Secrets have
a seven-day recovery window; using the same name immediately after deletion can
conflict. Verify no ALB, tasks, database, images or logs remain billable. Retain
only sanitized test evidence; protect/delete state backups containing secrets.

## Release evidence and package consumption

The maintainer reported successful AWS deployment with DNS, a bearer-token secret,
Inspector access, and a Nova Pro/Bedrock agent calling the remote endpoint on
2026-09-28. This establishes deployment and functional interoperability; it is
not a sustained-load or failover certification. Record the tested image digest,
HTTPS URL, task sizing, sustained-load results and restart/rolling-update outcomes
in issue #14. Use the certificate-backed `https://` endpoint for bearer tokens.

The release scope is Node and Python; .NET and Go runners are deferred. This
checkout builds the candidate library from source to exercise pending changes.
After approving and publishing the tested release, switch the sample to the exact
`@modern-software/mcpack` registry version with a lockfile and rerun its integration
tests. Keep a source-built CI path so changes to the library still exercise the
sample before publication. Do not use a floating `latest` dependency.
