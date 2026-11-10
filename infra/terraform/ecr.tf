locals {
  ecr_repos = toset(["gateway", "migrate", "ai-service", "web", "seed"])
}

resource "aws_ecr_repository" "app" {
  for_each             = local.ecr_repos
  name                 = "dawai/${each.key}"
  image_tag_mutability = "IMMUTABLE" # a git-SHA tag can never be re-pointed
  force_delete         = var.force_destroy

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }
}

resource "aws_ecr_lifecycle_policy" "app" {
  for_each   = aws_ecr_repository.app
  repository = each.value.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "keep the last ${var.ecr_keep_images} images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = var.ecr_keep_images
      }
      action = { type = "expire" }
    }]
  })
}
