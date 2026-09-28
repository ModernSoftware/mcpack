resource "aws_db_subnet_group" "database" {
  subnet_ids = aws_subnet.database[*].id
}

resource "aws_db_parameter_group" "database" {
  family = "postgres16"
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
}

resource "aws_db_instance" "database" {
  identifier                  = var.name
  engine                      = "postgres"
  engine_version              = "16"
  instance_class              = "db.t4g.micro"
  allocated_storage           = 20
  storage_type                = "gp3"
  storage_encrypted           = true
  db_name                     = "supportdesk"
  username                    = "postgres"
  manage_master_user_password = true
  db_subnet_group_name        = aws_db_subnet_group.database.name
  parameter_group_name        = aws_db_parameter_group.database.name
  vpc_security_group_ids      = [aws_security_group.database.id]
  publicly_accessible         = false
  multi_az                    = false
  backup_retention_period     = 1
  deletion_protection         = !var.allow_destroy_data
  skip_final_snapshot         = var.allow_destroy_data
  final_snapshot_identifier   = "${var.name}-final"
}

resource "aws_s3_bucket" "documents" {
  bucket_prefix = "${var.name}-"
  force_destroy = var.allow_destroy_data
}

resource "aws_s3_bucket_public_access_block" "documents" {
  bucket                  = aws_s3_bucket.documents.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_policy" "tls" {
  bucket = aws_s3_bucket.documents.id
  policy = jsonencode({
    Version = "2012-10-17", Statement = [{
      Effect = "Deny", Principal = "*", Action = "s3:*", Resource = [aws_s3_bucket.documents.arn, "${aws_s3_bucket.documents.arn}/*"], Condition = {
        Bool = {
          "aws:SecureTransport" = "false"
        }
      }
    }]
  })
}

resource "random_password" "secret" {
  for_each = toset(["app_db", "refund_db", "mcp_token", "refund_token"])
  length   = 32
  special  = false
}

resource "aws_secretsmanager_secret" "secret" {
  for_each                = random_password.secret
  name_prefix             = "${var.name}-${each.key}-"
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "secret" {
  for_each      = random_password.secret
  secret_id     = aws_secretsmanager_secret.secret[each.key].id
  secret_string = each.value.result
}
