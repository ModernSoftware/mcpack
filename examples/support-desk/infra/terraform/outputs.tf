output "mcp_url" {
  value = "https://${var.hostname}/mcp"
}
output "load_balancer_dns" {
  value = aws_lb.main.dns_name
}
output "cluster" {
  value = aws_ecs_cluster.main.name
}
output "seed_task_definition" {
  value = aws_ecs_task_definition.app["seed"].arn
}
output "seed_network_configuration" {
  value = jsonencode({
    awsvpcConfiguration = {
      subnets        = aws_subnet.public[*].id,
      securityGroups = [aws_security_group.tasks["seed"].id],
      assignPublicIp = "ENABLED"
    }
  })
}
output "mcp_token_secret_arn" {
  value = aws_secretsmanager_secret.secret["mcp_token"].arn
}
