terraform {
  required_version = ">= 1.7, < 2.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws",
      version = "~> 6.0"
    }
  }
}
variable "region" {
  type = string
}
variable "name" {
  type    = string
  default = "mcpack-support-desk"
}
provider "aws" {
  region = var.region
}
resource "aws_ecr_repository" "app" {
  name                 = var.name
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
  force_delete = false
}
output "repository_url" {
  value = aws_ecr_repository.app.repository_url
}
