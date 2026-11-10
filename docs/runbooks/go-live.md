# Go-live, step by step (demo mode on one EC2 instance)

Nothing here is applied for you: **Claude never runs `terraform apply` or `destroy`** without you typing "apply" in the chat.
Each step says who does it. Tick the boxes as you go.

## 0. Before AWS

- ☐ **You:** AWS account has MFA on the root user; you work with an IAM user/role, not root. Budget e-mail works.
- ☐ **You:** enable Cost Explorer once (Billing > Cost Explorer > Enable). `make start` needs it to check the monthly cap.
- ☐ **You:** GitHub repository exists and the code is pushed (CI never ran on GitHub yet: expect a first round of fixes).
- ☐ **You:** `terraform`, `aws` CLI and (for `make shell`) the Session Manager plugin installed.

## 1. Terraform state (once)

```bash
cd infra/terraform/bootstrap && terraform init && terraform plan     # read it
terraform apply                                                      # only after you decided
```
Copy the output bucket name into `infra/terraform/backend.hcl` (from `backend.hcl.example`).

## 2. The stack

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars    # acme_email, alarm_email, github_repo
make tf-init && make tf-plan                    # Claude shows you the summary; read the IAM policies too
terraform apply                                 # only after your explicit "apply"
```
- ☐ **You:** click the confirmation links AWS e-mails you (SNS alarm topic and the budget).
- ☐ Note the outputs: `instance_id`, `name_servers`, `webhook_url`, `github_deploy_role_arn`, `backup_bucket`.

## 3. DNS (GoDaddy, `rasuonline.in`)

- ☐ **You:** add four **NS** records, host `dawai`, one per name server from the output. Do not touch other records.
- ☐ Check: `dig NS dawai.rasuonline.in +short` shows the AWS name servers (can take minutes to hours).

## 4. Secrets

```bash
make secrets-template                       # writes prod.secrets.env with generated values
# fill the empty ones (docs/production-checklist.md), copy ENCRYPTION_KEY + PHONE_HASH_PEPPER to a password manager
scripts/put-secrets.sh prod.secrets.env
scripts/put-secrets.sh prod.config.env --config     # LLM_PRIMARY, models, LLM_DAILY_BUDGET_USD, WA_PHONE_NUMBER_ID ...
shred -u prod.secrets.env 2>/dev/null || rm -f prod.secrets.env
```

## 5. GitHub

- ☐ **You:** repository variables from `docs/production-checklist.md` section 4, and a `production` environment.
- ☐ Tag and push: `git tag v0.1.0 && git push origin v0.1.0`. The workflow builds and pushes the images. The instance is already
  running after `terraform apply`; if it is not, `make start`.

## 6. First deploy and smoke test

- ☐ The workflow's deploy step runs `deploy.sh` on the instance (watch the Actions log). If the instance was stopped: `make start`.
- ☐ Load the catalog once: `CONFIRM=yes bash scripts/aws-ssm.sh seed` (the Jan Aushadhi list is NOT in the image; see `data/SOURCES.md`).
- ☐ `WA_VERIFY_TOKEN=... WA_APP_SECRET=... make smoke-prod API=api.dawai.rasuonline.in SITE=dawai.rasuonline.in` all PASS.

## 7. Meta (WhatsApp)

- ☐ **You:** Meta Business verification complete, display name approved. Privacy policy and terms are live at `https://<site>/privacy` and `/terms`
  (legal review pending: draft banner is shown until then).
- ☐ **You:** WhatsApp > Configuration > Webhook: callback `https://api.dawai.rasuonline.in/webhook/whatsapp`, verify token = `WA_VERIFY_TOKEN`.
  Subscribe to `messages`, and to `message_template_status_update`, `phone_number_quality_update`, `account_update`.
- ☐ **You:** use the **production number** and a **System User permanent token** (`WA_ACCESS_TOKEN`).
- ☐ **You:** submit the templates from `docs/whatsapp-templates.md` and track approval:
  ☐ dose_reminder ☐ caregiver_invite ☐ caregiver_missed_dose_alert ☐ consent_reminder ☐ daily_summary ☐ reminder_renewal ☐ generic_reengage

## 8. Manual end-to-end from your own WhatsApp

☐ send "Hi" → language buttons ☐ choose language → consent message ☐ agree ☐ send a synthetic prescription photo → reply with buttons
☐ **Generic details** ☐ **Set reminders** for 3 minutes ahead ☐ the reminder arrives ☐ answer "le li" ☐ send `DELETE` → confirm → erased.

## 9. Alarms and rollback, once each (M17 acceptance)

- ☐ Test an alarm: `aws cloudwatch set-alarm-state --alarm-name dawai-http-5xx --state-value ALARM --state-reason test` → the e-mail arrives.
- ☐ Deploy a deliberately broken SHA (for example an image whose `/health/ready` fails) → `deploy.sh` rolls back, the job fails, the site stays up.
- ☐ Restore drill, time recorded in `docs/runbooks/restore.md`.

## 10. Day to day (demo mode)

`make start` → wait 2–4 minutes → show it → `make stop` (or let the 3-hour limit stop it). `make extend MIN=120` for longer.
At the end of the project: `terraform destroy` (set `force_destroy = true` first if the buckets should go too).
