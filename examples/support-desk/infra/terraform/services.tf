locals {
  roles = toset(["mcp", "refunds", "seed"])
  common_env = {
    PGHOST          = aws_db_instance.database.address,
    PGDATABASE      = "supportdesk",
    DB_SSL          = "true",
    PGSSLROOTCERT   = "/opt/rds-ca.pem",
    AWS_REGION      = var.region,
    DOCUMENT_BUCKET = aws_s3_bucket.documents.id
  }
  task_env = {
    mcp = merge(local.common_env, {
      PGUSER = "desk_app", MCP_HOSTNAME = var.hostname, REFUND_API_URL = "http://refunds.${var.name}.local:3001"
    })
    refunds = merge(local.common_env, {
      PGUSER = "refund_app", SIMULATOR_FAULTS_ENABLED = "false"
    })
    seed = merge(local.common_env, {
      PGUSER = "postgres"
    })
  }
  task_secrets = {
    mcp = {
      PGPASSWORD        = aws_secretsmanager_secret.secret["app_db"].arn,
      MCPACK_HTTP_TOKEN = aws_secretsmanager_secret.secret["mcp_token"].arn,
      REFUND_API_TOKEN  = aws_secretsmanager_secret.secret["refund_token"].arn
    }
    refunds = {
      PGPASSWORD = aws_secretsmanager_secret.secret["refund_db"].arn, REFUND_API_TOKEN = aws_secretsmanager_secret.secret["refund_token"].arn
    }
    seed = {
      PGPASSWORD = "${aws_db_instance.database.master_user_secret[0].secret_arn}:password::", APP_DB_PASSWORD = aws_secretsmanager_secret.secret["app_db"].arn, REFUND_DB_PASSWORD = aws_secretsmanager_secret.secret["refund_db"].arn
    }
  }
}

resource "aws_ecs_cluster" "main" {
  name = var.name
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${var.name}"
  retention_in_days = 7
}

resource "aws_iam_role" "execution" {
  for_each    = local.roles
  name_prefix = "${var.name}-${each.key}-exec-"
  assume_role_policy = jsonencode({
    Version = "2012-10-17", Statement = [{
      Effect = "Allow", Principal = {
        Service = "ecs-tasks.amazonaws.com"
      }, Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "execution" {
  for_each   = local.roles
  role       = aws_iam_role.execution[each.key].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "secrets" {
  for_each = local.roles
  role     = aws_iam_role.execution[each.key].id
  policy = jsonencode({
    Version = "2012-10-17", Statement = [{
      Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = [for arn in values(local.task_secrets[each.key]) : trimsuffix(arn, ":password::")]
    }]
  })
}

resource "aws_iam_role" "task" {
  for_each           = local.roles
  name_prefix        = "${var.name}-${each.key}-task-"
  assume_role_policy = aws_iam_role.execution[each.key].assume_role_policy
}

resource "aws_iam_role_policy" "s3_read" {
  role = aws_iam_role.task["mcp"].id
  policy = jsonencode({
    Version = "2012-10-17", Statement = [{
      Effect = "Allow", Action = ["s3:GetObject"], Resource = ["${aws_s3_bucket.documents.arn}/invoices/*", "${aws_s3_bucket.documents.arn}/policies/*"]
    }]
  })
}

resource "aws_iam_role_policy" "s3_seed" {
  role = aws_iam_role.task["seed"].id
  policy = jsonencode({
    Version = "2012-10-17", Statement = [{
      Effect = "Allow", Action = ["s3:ListBucket"], Resource = [aws_s3_bucket.documents.arn]
      }, {
      Effect = "Allow", Action = ["s3:PutObject"], Resource = ["${aws_s3_bucket.documents.arn}/invoices/*", "${aws_s3_bucket.documents.arn}/policies/*"]
    }]
  })
}

resource "aws_ecs_task_definition" "app" {
  for_each                 = local.roles
  family                   = "${var.name}-${each.key}"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.execution[each.key].arn
  task_role_arn            = aws_iam_role.task[each.key].arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  container_definitions = jsonencode([{
    name                   = each.key,
    image                  = var.container_image,
    essential              = true,
    user                   = "1000",
    readonlyRootFilesystem = true,
    entryPoint             = ["node", "/project/${each.key == "mcp" ? "serve" : each.key == "refunds" ? "refund-api" : "seed"}.mjs"],
    command                = [],
    environment = [for k, v in local.task_env[each.key] : {
      name = k, value = v
    }],
    secrets = [for k, v in local.task_secrets[each.key] : {
      name = k, valueFrom = v
    }],
    portMappings = each.key == "seed" ? [] : [{
      containerPort = each.key == "mcp" ? 3000 : 3001, protocol = "tcp"
    }],
    linuxParameters = {
      initProcessEnabled = true, capabilities = {
        drop = ["ALL"]
      }
    },
    stopTimeout = 20,
    logConfiguration = {
      logDriver = "awslogs", options = {
        awslogs-group = aws_cloudwatch_log_group.app.name, awslogs-region = var.region, awslogs-stream-prefix = each.key
      }
    }
  }])
  depends_on = [aws_iam_role_policy.secrets, aws_iam_role_policy_attachment.execution, aws_secretsmanager_secret_version.secret]
}

resource "aws_service_discovery_private_dns_namespace" "main" {
  name = "${var.name}.local"
  vpc  = aws_vpc.main.id
}

resource "aws_service_discovery_service" "refunds" {
  name = "refunds"
  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.main.id
    dns_records {
      ttl  = 10
      type = "A"
    }
    routing_policy = "MULTIVALUE"
  }
  health_check_custom_config {
    failure_threshold = 1
  }
}

resource "aws_lb" "main" {
  name                       = var.name
  load_balancer_type         = "application"
  subnets                    = aws_subnet.public[*].id
  security_groups            = [aws_security_group.alb.id]
  drop_invalid_header_fields = true
}

resource "aws_lb_target_group" "mcp" {
  name                 = var.name
  port                 = 3000
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = aws_vpc.main.id
  deregistration_delay = 20
  health_check {
    path     = "/readyz"
    matcher  = "200"
    interval = 15
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.mcp.arn
  }
}

resource "aws_route53_record" "mcp" {
  count   = var.zone_id == "" ? 0 : 1
  zone_id = var.zone_id
  name    = var.hostname
  type    = "A"
  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = true
  }
}

resource "aws_ecs_service" "refunds" {
  name            = "refunds"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.app["refunds"].arn
  desired_count   = var.start_services ? 1 : 0
  launch_type     = "FARGATE"
  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.tasks["refunds"].id]
    assign_public_ip = true
  }
  service_registries {
    registry_arn = aws_service_discovery_service.refunds.arn
  }
}

resource "aws_ecs_service" "mcp" {
  name                              = "mcp"
  cluster                           = aws_ecs_cluster.main.id
  task_definition                   = aws_ecs_task_definition.app["mcp"].arn
  desired_count                     = var.start_services ? var.replicas : 0
  launch_type                       = "FARGATE"
  health_check_grace_period_seconds = 60
  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.tasks["mcp"].id]
    assign_public_ip = true
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.mcp.arn
    container_name   = "mcp"
    container_port   = 3000
  }
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  depends_on = [aws_lb_listener.https]
}
