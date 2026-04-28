# DNS module: consumes the existing ironforge.rickycaballero.com hosted zone
# (manually managed, NS-delegated from the parent rickycaballero.com zone) and
# issues a SAN ACM certificate for the apex + wildcard.
#
# Crucially: this module NEVER creates or modifies a Route53 hosted zone, and
# never touches the parent zone. It only adds records inside the existing
# subdomain zone. See docs/dns-setup.md.
#
# All resources here use aws.us_east_1 — CloudFront requires its certs in
# us-east-1 regardless of the rest of the platform's region.

data "aws_route53_zone" "ironforge" {
  provider = aws.us_east_1

  name         = var.domain_name
  private_zone = false
}

resource "aws_acm_certificate" "ironforge" {
  provider = aws.us_east_1

  domain_name       = var.domain_name
  validation_method = "DNS"

  # Wildcards don't cover the wildcard's apex — both names are needed for
  # the portal at the apex and provisioned user services under the wildcard.
  subject_alternative_names = [
    "*.${var.domain_name}",
  ]

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    "ironforge-component" = "dns"
    Name                  = var.domain_name
  }
}

resource "aws_route53_record" "cert_validation" {
  provider = aws.us_east_1

  for_each = {
    for dvo in aws_acm_certificate.ironforge.domain_validation_options :
    dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  # allow_overwrite handles the edge case where validation records need to
  # be replaced cleanly during cert recreation — without it, terraform errors
  # if a record with the same name already exists from a prior cert.
  allow_overwrite = true

  name    = each.value.name
  records = [each.value.record]
  ttl     = 60
  type    = each.value.type
  zone_id = data.aws_route53_zone.ironforge.zone_id
}

resource "aws_acm_certificate_validation" "ironforge" {
  provider = aws.us_east_1

  certificate_arn         = aws_acm_certificate.ironforge.arn
  validation_record_fqdns = [for record in aws_route53_record.cert_validation : record.fqdn]
}
