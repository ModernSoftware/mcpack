#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../infra/terraform"
cluster=$(terraform output -raw cluster)
task_definition=$(terraform output -raw seed_task_definition)
network=$(terraform output -raw seed_network_configuration)
response=$(aws ecs run-task --cluster "$cluster" --task-definition "$task_definition" \
  --launch-type FARGATE --network-configuration "$network" --output json)
task=$(python -c 'import json,sys; r=json.load(sys.stdin); assert not r.get("failures"),r; print(r["tasks"][0]["taskArn"])' <<< "$response")
printf 'Waiting for seed task: %s\n' "$task"
aws ecs wait tasks-stopped --cluster "$cluster" --tasks "$task"
aws ecs describe-tasks --cluster "$cluster" --tasks "$task" --output json |
  python -c 'import json,sys; r=json.load(sys.stdin); t=r["tasks"][0]; cs=t.get("containers",[]); assert cs and all(c.get("exitCode")==0 for c in cs),t; print("Seed completed")'
