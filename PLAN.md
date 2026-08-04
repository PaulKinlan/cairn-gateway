# Cairn product plan

`PLAN.md` is the source of truth for Cairn. Work that conflicts with it must update the plan and the
implementation in the same commit.

## Product

Cairn lets one owner connect a provider once, keep the credential in dedicated custody, and give an
enrolled agent narrow access to named operations from approved devices and workloads. Agents use
those grants over MCP and receive typed results and sanitized receipts. They never receive a
provider token, raw credential, generic request primitive, or caller-selected destination. The owner
can inspect use and revoke access.

The first operation is `github.user.read@v1`: read allowlisted fields from the connected GitHub
user. Every later operation needs its own fixed provider route, closed input and output schemas,
projection, policy cost, failure mapping, and review. The stable MCP front door remains
`search_capabilities`, `describe_operation`, `connection_status`, and `invoke_operation` as the
catalog grows to hundreds of typed operations; Cairn does not inject one permanent MCP tool per
operation into client context.

## v1 boundary

### In v1

- One owner and one private Cairn deployment.
- Owner sign-in and recovery with an enrolled admin device.
- Agent and device enrollment, workload binding, key replacement, and removal.
- One GitHub provider connection through an exact OAuth callback.
- Opaque credential custody; only the custodian/provider adapter can read credentials.
- Grants for `github.user.read@v1` with expiry, usage limits, inspection, and revocation.
- Streamable HTTP MCP for named, validated clients.
- A stable catalog front door: `search_capabilities`, `describe_operation`, `invoke_operation`, and
  `connection_status`, with the generic typed invoke path remaining available as operations grow.
- Sanitized receipts, usage inspection, retention, and deletion.
- Durable authority, replay, permit, receipt, backup, restore, and recovery state.
- A public authenticated MCP endpoint (fixture custody first, per ADR 0006) and an authenticated
  deployed admin surface with operating runbooks.

### Not in v1

- Multiple owners or collaborative organizations.
- A public marketplace, self-service provider/operation plug-ins, or arbitrary user-defined schemas.
- Providers or operations beyond GitHub `github.user.read@v1`.
- Public anonymous access, a general SaaS launch, billing, or enterprise federation.
- Mobile applications, browser extensions, or autonomous grant approval.
- Projecting selected catalog results as temporary first-class MCP tools or sending tool-list change
  notifications; those require post-v1 named-client evidence and never replace use-time authority.
- Agent-orchestrated provider developer-console setup, provider app/key creation, callback
  registration, or secret intake; post-v1 assistance remains human-confirmed and custody-bound.
- Availability, scale, or compliance claims beyond measured private-alpha evidence.

### Never allowed

- Returning, printing, logging, journaling, exporting, or placing provider tokens or signing
  material in MCP, HTML, receipts, analytics, support output, or the authority store.
- A generic proxy, arbitrary HTTP method, arbitrary URL, arbitrary header, base URL override,
  caller-selected destination, raw provider response, token export, or credential-reveal endpoint.
- A grant that bypasses owner approval, typed operation policy, use-time expiry/revocation, or
  atomic dispatch authority.
- Routine operator access to credentials, silent cross-tenant reads, automatic ambiguous retries, or
  recovery that rolls authority state backward.

## Target users

- **Owner/admin:** connects GitHub, enrolls agents and devices, creates grants, inspects receipts
  and usage, revokes access, and performs owner recovery.
- **Agent operator:** configures an approved MCP client and binds a workload to an enrolled agent.
- **Deploy/operator:** deploys, monitors, backs up, restores, rotates, and responds to incidents
  without routine credential access.

## Role and authority matrix

“None” is an authority boundary, not missing product work.

| Role/object         | Created by                                              | Approved by                                                                                  | Uses                                                                         | Inspected by                                                               | Revoked by                                                                                     | Recovered by                                                                                             |
| ------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Owner/admin         | Bootstrap or recovery ceremony                          | Existing owner proof, or documented recovery quorum                                          | Admin session, connection, enrollment, grant, receipt, and recovery surfaces | Owner; operator sees only service health/audit metadata                    | Owner through epoch rotation; recovery can replace a lost owner device                         | Owner recovery ceremony using tested backup and recovery factors                                         |
| Device              | Owner/admin enrollment flow                             | Owner/admin device proof; no self-approval where separation is required                      | Signs owner or agent-bound requests according to its role                    | Owner/admin                                                                | Owner/admin                                                                                    | Replace with a newly approved device; never restore an old private key from authority state              |
| Agent               | Owner/admin                                             | Owner/admin                                                                                  | Holds grants and identifies MCP authority                                    | Owner/admin; workload sees only its own exposed operations                 | Owner/admin                                                                                    | Re-enroll as a new agent/key and reissue grants                                                          |
| Workload            | Agent operator starts it; owner records the binding     | Owner/admin grant plus enrolled agent/device relation                                        | MCP session and typed tools                                                  | Owner/admin through receipts; operator through sanitized service telemetry | Owner/admin revokes grant/agent/device; operator may stop a process but cannot grant authority | Restart and reconnect with still-valid enrolled keys and grant                                           |
| Custodian           | Deploy/operator provisions the selected custody service | Milestone custody gate and owner connection ceremony                                         | Stores/uses provider credentials only for fixed adapters                     | Operator sees health and opaque references; owner sees connection state    | Owner disconnect plus operator break-glass procedure                                           | Tested custody backup/rotation/recovery runbook; credential values remain hidden                         |
| Provider connection | Owner starts OAuth callback flow                        | Owner completes provider authorization and Cairn verifies state, PKCE, callback, and binding | Fixed provider adapter through opaque custody reference                      | Owner/admin sees status and operation availability                         | Owner/admin; confirmed provider-side revoke where supported                                    | Reconnect through a new OAuth flow; never revive an invalid token silently                               |
| Grant               | Owner/admin                                             | Owner/admin device proof and policy checks                                                   | Bound agent/workload invokes one typed operation on one connection           | Owner/admin sees status, expiry, limits, receipts, and usage               | Owner/admin; use-time checks enforce it                                                        | Recreate as a new version after review; recovery does not reactivate stale grants                        |
| Deploy/operator     | Deployment owner                                        | Operational access policy outside routine admin authority                                    | Deployment, monitoring, migration, backup, restore, rotation, incident tools | Operator audit; owner sees product-visible service state                   | Deployment owner removes operational access                                                    | Separate infrastructure access recovery; cannot recover owner authority or provider tokens by inspection |

## End-to-end journeys

Each journey names its surface, successful path, failures/recovery, and acceptance evidence. A test
or status page without the user action is not journey evidence.

### Deploy/operator journey

- **Surface:** deployment CLI/configuration, migration command, health/metrics, sanitized logs,
  backup/restore command, and operator runbook.
- **Success:** select approved region/storage/custody/hosting, deploy a private instance, migrate
  it, verify health without secrets, back it up, restore to an isolated target, and rotate service
  keys.
- **Failures and recovery:** configuration or migration failure leaves the prior revision usable;
  unknown commit is inspected rather than retried; bad deploy rolls back; restore rejects stale or
  corrupt state; alerts and incident steps name the next safe action.
- **Acceptance evidence:** commit, exact deploy/migrate/backup/restore actions, private demo URL,
  health output, restore comparison, cost reading, runbook revision, and independent review.

### Owner/admin journey

- **Surface:** private admin web application and owner recovery ceremony.
- **Success:** create/recover owner identity, sign in, enroll an admin device, create an agent,
  enroll its device/workload, create a scoped grant, inspect status and receipts, and sign out.
- **Failures and recovery:** duplicate or mismatched key, expired session, failed approval, lost
  device, stale form, and cross-owner request fail closed with a useful next step; owner recovery
  rotates authority and does not reveal or silently preserve compromised keys.
- **Acceptance evidence:** clean-browser recording, accessibility/keyboard pass, cross-owner denial,
  lost-device exercise, audit entries, and no-secret sentinel tests.

### Provider connection journey

- **Surface:** admin Connections UI, exact OAuth start/callback routes, custodian, and GitHub
  adapter.
- **Success:** owner starts GitHub OAuth, returns through the registered callback with bound state
  and PKCE, sees an active connection, runs `connection_status`, and disconnects/reconnects
  deliberately.
- **Failures and recovery:** wrong/expired state, callback replay, PKCE mismatch, denied consent,
  invalid/expired credential, provider outage, and partial custody write map to bounded states;
  reconnect creates fresh authority and confirmed disconnect revokes upstream where possible.
- **Acceptance evidence:** test-account connection recording, callback/replay suite, custody
  sentinel scan, provider failure fixtures, reconnect demonstration, and provider-side revoke
  evidence.

### Agent/MCP journey

- **Surface:** validated named MCP client, Streamable HTTP endpoint, enrollment/grant UI, and
  receipt view.
- **Success:** reconnect or initialize, send `notifications/initialized`, call
  `search_capabilities`, `describe_operation`, `connection_status`, and `invoke_operation`, receive
  projected GitHub data and a visible receipt, then reconnect without recreating valid authority.
- **Failures and recovery:** missing/unknown/expired session, unsupported revision, malformed input,
  revoked or expired grant, provider failure, and network interruption return bounded responses; the
  client reconnects and reinitializes while authority is rechecked at use time.
- **Acceptance evidence:** disposable project-local runs for every named client/revision, captured
  wire lifecycle, exact client configuration, invoke output, visible receipt, reconnect run, and
  independent compatibility review. Raw wire tests alone do not prove named-client support.

### Revocation journey

- **Surface:** admin grant/agent/device/connection controls, MCP endpoint, receipt/audit view, and
  provider disconnect where applicable.
- **Success:** owner revokes one subject, sees its state and audit entry, and every later affected
  search/describe/status/invoke path denies within the measured target; unrelated grants continue.
- **Failures and recovery:** double-submit is idempotent or safely versioned; concurrent call uses
  atomic permit rules; provider-side revoke uncertainty is displayed separately; reactivation
  creates a new valid version and expiry rather than relabeling dead authority active.
- **Acceptance evidence:** concurrent revoke/invoke test, measured denial latency, unrelated-session
  isolation, expired-grant display, provider confirmation, and reactivation as a usable new version.

### Restart/recovery journey

- **Surface:** client reconnect, durable store, backup/restore tooling, custody recovery, and
  recovery runbooks.
- **Success:** restart service, reconnect MCP, preserve owner/agent/device/connection/grant and
  receipt state, reject replay, restore an approved backup to an isolated target, and resume only
  after integrity checks.
- **Failures and recovery:** abandoned MCP sessions expire/evict; clients reinitialize; stale or
  corrupt backup is rejected; unknown commit/dispatch remains quarantined; custody or signing
  recovery rotates references/keys without exposing values.
- **Acceptance evidence:** kill/restart/reconnect demonstration, session-expiry/eviction tests,
  replay test, backup/restore drill, stale/corrupt rejection, recovery-time measurement, and
  reviewed runbook.

## Architecture and trust boundaries

- **Owner identity and session:** verifies owner authentication, passkey/device proof, session
  expiry, CSRF, recovery, and authority epoch. It cannot read provider credentials.
- **Admin application:** onboarding, connection, enrollment, grant/revocation, receipt/usage, and
  recovery views. All mutations are authenticated, same-origin, CSRF-protected, and audited.
- **OAuth start/callback:** fixed GitHub authorization endpoint and registered callback. It binds
  owner, tenant, connection, state, PKCE, redirect URI, and one-time flow before custody completion.
- **MCP transport:** revision negotiation, named-client compatibility adapter, bounded session
  lifecycle, request limits, and closed MCP methods.
- **Authority service:** owner, agent, device, workload, grant, connection, replay, permit, expiry,
  and revocation decisions. Only an atomically consumed dispatch permit authorizes provider use.
- **Operation registry:** versioned operation definitions with fixed provider routes, schemas,
  projection, cost, and failure mapping. It cannot express arbitrary HTTP.
- **Credential custodian and provider adapter:** the only credential-reading component. It accepts
  an opaque connection reference plus a reviewed typed operation, uses the credential against the
  fixed provider route, and returns a bounded provider outcome.
- **Durable authority store:** tenant-scoped compare-and-swap state, replay records, permits,
  migrations, and authority generations. It stores opaque custody references, never credentials.
- **Receipt and usage store:** sanitized decision/result category, subject IDs, operation, units,
  correlation, and timestamps with approved retention/deletion. It stores no provider body or token.
- **Backup and recovery:** separately authorized export, integrity verification, restore,
  migrations, generation checks, and custody/signing recovery procedures.
- **Operations:** secret-safe health, metrics, alerts, cost, key rotation, deploy/rollback, and
  incident tooling.

```text
Owner browser / admin device
       | owner auth + CSRF + signed approvals
       v
[Owner identity/session] ---> [Admin application] ---> [Authority service] ---> [Authority store]
                                      |                       |                       |
                                      | OAuth start/callback  | sanitized decision    | backup/export
                                      v                       v                       v
                               [OAuth callback]        [Receipt/usage store]   [Backup/recovery]
                                      |
                                      | opaque connection reference
                                      v
Agent workload ---> [MCP transport] ---> [Authority + atomic permit] ---> [Operation registry]
 client session          |                         |                              |
                         | typed result/receipt    | one-use dispatch permit      | fixed operation
                         v                         v                              v
                    Agent/client            [Credential custodian] ------> [GitHub fixed endpoint]
                                                  ^ credential read only here

Deploy/operator ---> deployment, health, migration, backup, rotation
                    (no owner grant authority and no routine credential read)
```

### Ambiguity and failure handling

- A reservation with an unknown commit is inspected through privileged maintenance authority; it is
  never repeated automatically.
- A dispatch with an unknown outcome becomes `dispatch_unknown`; neither client reconnect nor worker
  restart turns it into another provider call.
- OAuth callback ambiguity queries bounded custody/flow status and asks the owner to reconnect when
  safe; it does not replay a code.
- Receipt-write failure after dispatch records/quarantines the correlation through the durable
  transaction design before production activation; success is not invented from a missing receipt.
- Session loss only loses transport state. The client reinitializes and the authority service
  rechecks grant, connection, device, agent, workload, expiry, and replay state.
- Provider timeout maps to a bounded unavailable/unknown outcome according to operation policy; it
  never causes a blind retry.
- Restore and migration use integrity/schema/generation checks and reject stale, partial, or corrupt
  input without overwriting the last known-good state.

## Security gates

- No API, tool, log, export, receipt, analytics event, or UI returns provider tokens, signing
  material, raw custody records, or unprojected provider bodies.
- No generic proxy/request/header/URL/base override/caller-selected destination exists.
- Every operation has closed schemas, fixed provider route, bounded projection, explicit cost, and
  reviewed failure behavior.
- Tenant, owner, agent, device, workload, grant, connection, operation, body, route, audience,
  nonce, time, and capability are bound before dispatch.
- Revocation and expiry are checked at use time. One successful atomic permit consumption is the
  only dispatch authority; ambiguity is never automatically retried.
- Admin mutations are authenticated, POST-only, same-origin, CSRF-protected, audited, and separate
  from maintenance authority.
- Hosted listeners validate host/origin, authenticate clients, bound sessions and streaming request
  bodies, rate-limit safely, and expose no debug state.
- Migrations, backup, restore, recovery, key rotation, retention/deletion, and incidents pass
  destructive/failure-injection tests before production data.

## Decisions register

Open decisions block the milestone in “Due” unless the required evidence selects an option.

| Decision                           | Owner                      | Due milestone/date       | Options                                                                 | Required evidence                                                                                                                                        | Selected/status                                                                                                                       | Fallback                                                    |
| ---------------------------------- | -------------------------- | ------------------------ | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Durable storage and region         | Product + deploy/operator  | M2 / before private data | Deno KV                                                                 | Unchanged 24 scenarios on exact candidate, atomic limits, strong-read/CAS behavior, latency, US storage/transit acknowledgement, restore drill, and cost | **Selected 2026-08-02: Deno KV**; implementation and hosted proof pending                                                             | Keep M2 local and do not accept production data             |
| Credential custody                 | Security + deploy/operator | M4                       | Cloud secret manager, dedicated vault, encrypted service with HSM/KMS   | OAuth lifecycle, least privilege, audit, rotation, deletion, recovery, pricing                                                                           | Open; memory fixture only                                                                                                             | Do not connect GitHub                                       |
| Admin identity/passkeys            | Product + security         | M3                       | WebAuthn/passkeys, external OIDC plus device proof, other reviewed flow | Browser support, recovery, phishing resistance, session/CSRF design, accessibility                                                                       | Open                                                                                                                                  | Keep admin local fixture-only                               |
| Device/agent key custody           | Security + client owner    | M2 (ADR 0006)            | OS keychain, hardware-backed key, client-managed encrypted key          | Signing API compatibility, export behavior, rotation/loss recovery, threat model                                                                         | Open; fixture keys only                                                                                                               | No real enrollment/grants                                   |
| MCP SDK and protocol revisions     | MCP owner                  | M5                       | Official SDK, bounded in-repo adapter, pinned revision set              | Upstream transport tests, revision behavior, dependency audit, failure matrix                                                                            | Open; wire adapter uses 2025-06-18                                                                                                    | Keep wire-level local fixture claim only                    |
| Named MCP clients                  | MCP owner + product        | M5                       | VS Code, Claude Desktop, other named clients                            | Disposable project-local initialization/list/call/reconnect runs with versions and configs                                                               | Open; VS Code config is candidate only                                                                                                | Publish curl/wire fixture instructions without client claim |
| GitHub OAuth and callback topology | Provider owner + security  | M4                       | GitHub OAuth App callback through hosted admin, reviewed proxy topology | Current GitHub docs, exact redirect, state/PKCE/replay tests, disconnect/revoke evidence                                                                 | Open                                                                                                                                  | Keep provider fixture                                       |
| Receipt retention and deletion     | Product + privacy          | M2 policy; M6 validation | Fixed short retention, owner-configured bounded retention               | Data inventory, deletion test, recovery impact, privacy review, cost                                                                                     | Open                                                                                                                                  | Minimum operational retention with no provider bodies       |
| Backup and recovery                | Deploy/operator + security | M2                       | Store-native backup, encrypted export, both                             | Restore drill, integrity, RPO/RTO, stale/corrupt rejection, key/custody separation                                                                       | Open; contract fixture only                                                                                                           | No production data                                          |
| Hosting and cost ceiling           | Product + deploy/operator  | M2 (ADR 0006)            | Deno, managed container, other private hosting                          | Private networking/auth, storage/custody fit, observability, rollback, monthly measured cost                                                             | **Selected 2026-08-02: Deno Deploy for the public fixture-custody MCP endpoint**; hosted qualification and independent review pending | Local-only milestone; do not deploy authority               |

## Milestones M0–M7

### M0 — product reset

- **Status:** Accepted at `ec1bc215d67dfa248e59f66fffe87a89b3e017b7`; stale instructions were
  replaced and the canonical plan correction received two independent no-blocker reviews.
- **User-visible deliverable:** one direct product plan and repository instructions that lead work
  toward user journeys rather than status/evidence pages.
- **Security gate:** permanent boundaries and milestone gates are explicit; security findings become
  gates, not substitute roadmap items.
- **Exact acceptance journey:** a contributor opens the repository, reads `AGENTS.md` then
  `PLAN.md`, maps a task to a milestone and journey, and can identify deliverable, excluded claims,
  decision blockers, demo, and acceptance evidence.
- **Demo/runbook:** plan walkthrough plus instruction-consistency review.
- **URL/N/A:** N/A; repository documents.
- **Excluded claims:** no usable product, named-client compatibility, provider connection, durable
  deployment, or production readiness follows from M0.

### M1 — usable local product

- **Status:** Accepted at `4b0954aab3afcf1c7d44b291846a812618c30228`. The local UI creates/resets
  fixture context, maps owner-entered agent/device/workload display labels to the fixed non-exported
  cryptographic test authority, creates/replaces a versioned expiring/limited grant, and drives the
  wire journey. The labels are not real cryptographic enrollment or workload identity. That work
  belongs to M3; duplicating it in M1 would turn the fixture milestone into a second identity
  implementation.
- **User-visible deliverable:** one-command local product where an owner labels the fixed fixture
  agent/device/workload mapping, creates grant authority, exercises search/describe/status/invoke
  over the wire, sees receipts/audit/usage, revokes, tests denial, replaces the grant, and
  reconnects.
- **Security gate:** loopback-only; fixture-only; bounded streaming bodies/sessions; POST-only,
  same-origin, CSRF-protected mutations; no stores/signers/tokens/proxy surface.
- **Exact acceptance journey:** clean checkout → run → create fixture context and identity labels →
  create grant → initialize → initialized notification → search → describe → status → invoke →
  inspect visible receipt → revoke → test visible denial/audit → replace with new expiry/version →
  invoke → reconnect.
- **Demo/runbook:** `docs/local-setup.md`, actual-listener smoke, fixture reset, and
  [browser validation](docs/evidence/m1/browser-validation.md).
- **URL/N/A:** `http://127.0.0.1:8787/` while running; no hosted URL.
- **Excluded claims:** named-client compatibility, durable restart, real identity, real GitHub,
  production custody, hosted authority, or multi-user support.
- **Implementation checklist:**
  - [x] Owner can create/reset the in-memory fixture context.
  - [x] Owner can add distinct agent/device/workload display labels mapped to fixed test authority.
  - [x] M1 intentionally maps display labels to the fixed cryptographic test authority. Genuine
        agent/device enrollment and workload binding are M3 acceptance requirements, not duplicated
        fixture work.
  - [x] Owner can create and inspect the fixed operation grant with version, expiry, five-call
        limit, and current use.
  - [x] Authority graph, sanitized invocation receipts, and the eight-entry usage window are
        visible.
  - [x] Admin and actual-listener MCP invocation both create visible receipts.
  - [x] Search → describe → connection status → invoke works over Streamable HTTP.
  - [x] Revoke provides a denial test, sanitized audit, measured local denial, replacement
        version/expiry, and reconnect.
  - [x] Controller and listener races cover create/reset, invoke/reset, duplicate grant, and
        revoke/invoke; reset leaves no invocable authority or residual receipt/usage.
  - [x] Unauthorized/stale CSRF, idle session, lifecycle, duplicate labels, receipt/usage bounds,
        expired display, unrelated sessions, and full HTTP journey are tested.
  - [x] Loopback, POST/same-origin/CSRF, exact Chrome null-origin navigation, streaming body,
        session, and closed facade gates remain.
  - [x] Independent implementation/security review accepted the partial submilestone with no
        blocker.
  - [x] Clean-browser journey, keyboard forms, accessibility, responsive, light/dark, and visual
        validation passed at source commit `0e5a584`.

### M2 — durable public fixture-custody deployment

- **Status:** In progress. Paul selected Deno KV on 2026-08-02 (ADR 0003) and the public
  fixture-custody direction on 2026-08-02 (ADR 0006). Acceptance remains blocked by the unchanged
  24-scenario run against the exact KV adapter/topology, atomic-size and strong-read/CAS evidence,
  explicit handling of hosted US storage/transit, usable export/restore proof, receipt, backup, and
  retention policy decisions, hosted-listener evidence, and independent review. Real Stage 0
  enrollment (owner bootstrap, agent/device P-256 keys with proof of possession, and revocation
  ceremonies) is wired into the loopback product path on `feature/m2-real-enrollment` pending
  independent review and merge.
- **User-visible deliverable:** the single owner's authority graph, receipts, usage, replay, and
  permits survive restart with backup/restore controls, and an enrolled agent reaches the same
  fixture-custody authority over a public authenticated HTTP MCP endpoint from any machine. No real
  provider credential exists anywhere in the system.
- **Security gate:** selected store passes all 24 scenarios plus migration, stale/corrupt restore,
  tenant boundary, receipt deletion, and ambiguous-dispatch tests; owner bootstrap and agent/device
  enrollment use the accepted Stage 0 P-256 proof/revocation core with no self-asserted identity on
  any hosted surface; the hosted listener validates host/origin, authenticates every request, bounds
  sessions and streaming bodies, and rate-limits safely; independent review accepts the exact
  deployment before exposure.
- **Exact acceptance journey:** create owner graph → enroll agent/device with real keys → invoke and
  see receipt → kill process → restart/reconnect → inspect unchanged state → reject replay → backup
  → restore isolated instance → verify graph/receipts → delete retained receipt according to policy
  → agent on a second machine initializes against the public endpoint,
  searches/describes/status/invokes with its own key, and a revoked grant denies there too.
- **Demo/runbook:** migration, restart, backup, restore, retention/deletion, recovery, deployment,
  rollback, and public-endpoint runbooks.
- **URL/N/A:** public MCP URL recorded in the acceptance log after gate acceptance; fixture custody
  only.
- **Excluded claims:** real provider credential or custody, owner passkey administration UX (M3),
  named-client support (M5), production readiness, or SLA.

### M3 — real identity and administration

- **Status:** Planned; real device/agent enrollment moved into M2 per ADR 0006. Blocked by admin
  identity/passkey and recovery decisions.
- **User-visible deliverable:** owner sign-in/recovery, admin sessions, key replacement, grants,
  revocation, and accessible audit/receipt views on the deployed service.
- **Security gate:** phishing/recovery review, session/CSRF tests, no self-approval violation,
  cross-owner denial harness, key loss/rotation, and accessibility pass.
- **Exact acceptance journey:** new owner signs in → enrolls admin device → creates agent → enrolls
  workload/device → approves grant → signs out/in → inspects receipt → loses/replaces device → old
  device and session deny.
- **Demo/runbook:** owner onboarding, lost-device, compromised-agent, session, and recovery
  runbooks.
- **URL/N/A:** private development URL or N/A; record whichever is used in acceptance log.
- **Excluded claims:** GitHub connected, named-client compatible, or production deployed.

### M4 — GitHub OAuth custody

- **Status:** Planned; blocked by custody and GitHub OAuth/callback decisions.
- **User-visible deliverable:** owner connects/disconnects/reconnects GitHub and invokes the real
  allowlisted `github.user.read@v1` result without credential exposure.
- **Security gate:** exact callback/state/PKCE/replay binding, exclusive credential reader, least
  privilege, token rotation/deletion, provider projection, and sentinel scans.
- **Exact acceptance journey:** owner starts OAuth → completes GitHub consent → sees active status →
  invokes operation → sees projected user and receipt → disconnects and observes denial/upstream
  revoke → reconnects with fresh authority.
- **Demo/runbook:** test-account OAuth, callback failure, credential rotation, disconnect/reconnect,
  provider outage, and custody recovery runbooks.
- **URL/N/A:** registered private callback URL recorded at acceptance; no public authority URL
  claim.
- **Excluded claims:** named-client support, general provider proxy, later providers, or production
  readiness.

### M5 — named-client compatibility

- **Status:** Planned. Current `2025-06-18` Streamable HTTP lifecycle is wire-tested only; VS Code
  is a candidate configuration, not accepted compatibility.
- **User-visible deliverable:** exact setup for selected named client versions with
  search/describe/status/invoke, visible receipt, session expiry, and reconnect behavior.
- **Security gate:** SDK/revision decision, bounded adapter review, dependency audit,
  host/origin/body limits, client authentication design for hosted use, and no authority bypass
  through compatibility.
- **Exact acceptance journey:** disposable project-local client config → named client initializes →
  lists/searches → describes → checks status → invokes → shows projected result/receipt → loses or
  expires session → reconnects and invokes again → revoked grant denies.
- **Demo/runbook:** per-client version/config/evidence record and compatibility/failure matrix.
- **URL/N/A:** local/private MCP URL used in evidence; hosted URL not required.
- **Excluded claims:** untested clients/revisions, protocol-wide conformance, public access, or
  production availability.

### M6 — private deployed alpha

- **Status:** Planned; first deployment moved to M2 per ADR 0006. Blocked by real-custody (M4) and
  named-client (M5) gates.
- **User-visible deliverable:** invited owner upgrades the deployed fixture-custody service to real
  GitHub custody with real durable state.
- **Security gate:** deployment review, private access, secret configuration, monitoring, limits,
  backup/restore, rollback, key rotation, retention/deletion, incident drill, and measured cost.
- **Exact acceptance journey:** deploy → owner onboard/connect/enroll/grant → named client invoke
  and receipt → revoke → restart/reconnect → backup/restore → operator rollback/incident exercise.
- **Demo/runbook:** deploy/operate/rollback/backup/restore/rotation/incident/support runbooks and
  private-alpha walkthrough.
- **URL/N/A:** private admin and MCP URLs required in restricted acceptance log; never commit
  secrets.
- **Excluded claims:** public launch, SLA, compliance, broad scale, billing, or later providers.

### M7 — later providers and operations

- **Status:** Later; begins only after M6 acceptance and a same-commit plan update.
- **User-visible deliverable:** one additional reviewed provider or typed operation that follows the
  v1 operation model.
- **Security gate:** fixed route/schema/projection/cost, dedicated custody scope, threat model,
  revocation, receipts, retention, and provider failure tests.
- **Exact acceptance journey:** owner connects or extends provider scope → explicitly grants new
  typed operation → agent searches/describes/status/invokes → receipt visible → revoke denies only
  affected authority.
- **Demo/runbook:** provider/operation onboarding, failure, revoke, recovery, and support runbooks.
- **URL/N/A:** inherited private-alpha URLs or N/A for local development.
- **Excluded claims:** plug-in marketplace, arbitrary schemas/routes, generic proxying, or automatic
  expansion to other providers.

### M8 — post-v1 adaptive catalog and provider setup assistance

- **Status:** Future; explicitly not v1. Begins only after private-alpha evidence and a same-commit
  plan update select concrete clients and provider setup targets.
- **User-visible deliverable:** optionally project owner/agent-selected search or describe results
  as temporary first-class MCP tools when a validated named client benefits, and let an agent assist
  a human through reviewed provider developer-console setup in a fresh isolated browser.
- **Catalog direction:** the four stable catalog tools remain the scalable front door and generic
  typed invoke remains the fallback. Temporary projections are bounded, disappear from client caches
  when no longer selected/authorized, and use tool-list change notifications only where an exact
  named client/version demonstrably supports them. A notification or cached-tool disappearance is
  never revocation: every invocation still rechecks current authority, version, expiry, limits,
  operation, connection, agent, device, and workload.
- **Setup-automation direction:** an agent may navigate a fresh isolated browser, explain steps,
  fill reviewed non-secret fields, and prepare callback registration. Login, CAPTCHA or 2FA, legal
  agreements, scope expansion, provider app creation/final writes, and every irreversible step
  require explicit human confirmation. Generated secrets enter approved custody through a
  secret-safe intake path and never cross model/browser logs, screenshots, clipboard, journal,
  receipts, analytics, or support output.
- **Security gate:** selected client cache/notification behavior, projection lifetime and authority
  binding, isolated-browser teardown, human confirmation boundaries, custody intake, and
  no-secret-log/screenshot/clipboard sentinels receive independent review.
- **Exact acceptance journey:** search and select a typed operation → optionally project it in a
  validated client → invoke with use-time authority → remove/revoke and observe bounded client
  update plus invoke denial → fall back to generic typed invoke; separately, start an isolated
  provider setup → agent prepares non-secret fields → human completes protected/irreversible steps →
  secret enters custody without appearing in retained evidence.
- **Excluded claims:** notification-as-revocation, permanent hundreds-tool injection, autonomous
  provider account/app creation, autonomous scope expansion, secret handling by the model/browser,
  or generic provider-console automation.

## Cairn v1 definition of done

All 12 items are required.

1. A new owner can authenticate, recover, sign out, and replace a lost admin device from tested
   instructions.
2. The owner can create an agent, enroll/remove its device and workload, rotate keys, and inspect
   the resulting authority graph.
3. The owner can connect, inspect, disconnect, and deliberately reconnect GitHub through an exact
   OAuth callback while credentials remain exclusively in custody.
4. The owner can create an expiring/limited `github.user.read@v1` grant and see its agent, workload,
   device, connection, version, limits, and status.
5. Accepted named client versions can initialize/reconnect and perform search, describe,
   connection-status, and invoke journeys from exact published configuration.
6. Invocation returns only projected typed GitHub data and a visible sanitized receipt; no
   credential or raw provider body crosses custody.
7. Grant, agent, device, connection, owner-epoch, expiry, and usage-limit revocation deny at use
   time within a measured target while unrelated authority continues.
8. Authority, replay, permits, receipts, usage, migrations, restart, ambiguity, retention/deletion,
   and tenant boundaries pass against selected durable storage.
9. Backup, integrity check, restore, stale/corrupt rejection, custody/signing recovery, and key
   rotation pass timed operator drills.
10. The private deployment has authenticated admin/MCP access, bounded sessions/bodies/rates,
    monitoring, alerts, rollback, incident handling, and a measured cost below the selected ceiling.
11. Accessibility, privacy/retention, external security, threat-model, dependency, and named-client
    compatibility reviews have no unresolved release blocker.
12. Acceptance logs record exact commit, owner action, agent action, demo/runbook, private URL or
    N/A, reviewer decision, and remaining blocker for every milestone; M6 has an accepted
    private-alpha journey with no forbidden surface.

## Current status and prioritized work

The repository has a 90-case fixture regression core, a 24-scenario durable-authority contract, a
separate public preview gate, and accepted M0 and M1 milestones. M1 proves the loopback admin and
MCP fixture journey; it does not prove a named client, durable authority, real identity, provider
custody, or production use.

Priority order:

1. Implement and qualify the selected Deno KV adapter without changing the 24 accepted durability
   scenarios; measure every atomic/value limit and use strong reads for authority decisions.
2. Wire real Stage 0 enrollment (owner bootstrap, agent/device P-256 keys, revocation) into the
   product path; no self-asserted identity may reach any hosted surface.
3. Resolve M2 receipt retention/deletion and backup/recovery policy, then implement durable restart,
   receipts/usage persistence, deletion, export, and isolated restore for the single-owner graph.
4. Deploy the public authenticated fixture-custody MCP endpoint on Deno Deploy behind the
   hosted-listener gates and independent review (ADR 0006).
5. Deliver M3 owner administration (passkeys, recovery, sessions) on the deployed service, then M4
   GitHub OAuth/custody, then M5 named-client evidence.
6. Run M6 real-custody private alpha. Do not begin M7 or M8 by adding generic infrastructure.

## Governance and acceptance records

- `PLAN.md` is canonical. `AGENTS.md`, `CLAUDE.md`, ADRs, issues, prompts, and status pages must
  defer to it.
- Every task names one milestone and one end-to-end journey before implementation. If scope changes,
  update `PLAN.md` in the same commit.
- The 90 Stage 0 cases and 24 Stage 1 scenarios are regression gates only. They do not define the
  product or count as user progress.
- Tests, health/status pages, evidence prose, architecture prose, and security hardening alone are
  not progress unless they unblock or complete an active user-visible milestone journey.
- Security findings become explicit gates on the relevant milestone. They do not replace roadmap
  deliverables or create endless evidence-only milestones.
- Build and publish testable active-milestone work by default when the milestone gate permits it.
  Never publish secrets/private data; obey explicit task restrictions on push/deploy and approval
  requirements for production, cost, destructive actions, and credential use.
- Each milestone acceptance log records: exact commit; owner/admin action; agent/workload action;
  demo and runbook; testable URL or N/A; independent reviewer and decision; residual blocker.
- A status change, scope claim, supported-client claim, or excluded-claim change requires a
  same-commit `PLAN.md` update and evidence. No branch is accepted from prose alone.
