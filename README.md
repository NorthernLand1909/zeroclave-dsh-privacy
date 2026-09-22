# ZeroClave Privacy Firewall for DeepSeek Harness

An experimental, local-first privacy plugin for the DeepSeek Harness Web UI.

## Current scope

- Scans the live text draft with deterministic browser-side regex rules.
- Lets users add, edit, duplicate, enable, disable, delete, test, and locally persist regex rules.
- Optionally loads [`gravitee-io/bert-small-pii-detection`](https://huggingface.co/gravitee-io/bert-small-pii-detection) and runs token classification in browser WebAssembly.
- Merges regex and model findings into one normalized result.
- Redacts a copy at the composer send boundary with session-scoped, collision-resistant placeholders.
- Keeps the composer and local submission echo in their original form.
- Restores known placeholders in user messages, assistant replies, and their copy actions before rendering.
- Saves restoration mappings in browser IndexedDB before sending, so the same browser can restore messages after reload.
- Shows the detector source on every finding and keeps the latest ten summary-only send records per DSH session.
- Shows the current findings, redacted preview, and session send activity in one DSH detection view.
- Supports the anonymous ZeroClave Gateway detector through a same-origin DSH Host proxy, with no API key.
- Offers privacy-preserving product telemetry as an explicit opt-in, disabled by default.

With privacy enabled, the normal composer send action automatically scans and redacts text. The original draft is not replaced. A failed scan, a partial ZeroClave result, or a mapping write failure prevents the send, allowing the composer to retain the original for retry. The inspection drawer remains an explicit view of the original and redacted preview.

The default send policy pauses a message containing critical findings before Host admission. The review lists the matching rule or model source, starts every finding in the redacted state, and lets the user keep an individual value for that send. Cancelling the review leaves the draft available and writes no restoration mapping. Users who prefer an uninterrupted flow can select automatic redaction under **Detection settings**.

Session activity contains only time, counts, highest risk, detector modes, and fallback status. It stores no draft, finding, evidence, replacement, or redacted text, and disappears when the page reloads.

## Detection backends

| Backend | Execution | Network behavior | Status |
| --- | --- | --- | --- |
| Regex | Browser | None | Ready |
| Embedded BERT | Browser WASM | Downloads pinned model files on first load; draft text is not sent to Hugging Face | Ready |
| ZeroClave | Remote Gateway | Sends draft plaintext through the same-origin DSH Host proxy to the configured ZeroClave Gateway over HTTPS; no API key | Ready when the public Gateway route is deployed |

The embedded model is pinned to revision `f8c27a85c51c0168f07b9dcf00265bf0a4097939` and loads the repository's 28.7 MB `model.quant.onnx` artifact. Browser cache avoids downloading the weights again in normal use.

### ZeroClave Gateway

The browser calls the plugin's same-origin `/api/zeroclave-privacy/detect` route. The DSH Host forwards that request to the configured Gateway base URL, which defaults to `https://zeroclave.com/v1`, and never adds an API key or authorization header. Keeping the browser request same-origin avoids depending on the Gateway's site CORS allowlist.

This route is not a client-to-TEE end-to-end encrypted channel. The DSH Host and ZeroClave Gateway can see the draft plaintext during detection. The public API returns only entity positions and types; replacement and restoration remain client-side. Its contract also states that anonymous cache entries contain a text hash plus positions and types, not plaintext or entity values.

The target Gateway must publish the anonymous `POST /v1/pii/detect` route and enable `PII_PUBLIC_DETECT_ENABLED`. Until that release is present, the UI connection test reports the route as unavailable and ZeroClave sends remain blocked. The connection test sends the fixed synthetic sample `ZeroClave synthetic connection test: demo@example.com`; it never sends the current draft. A `partial` response is always shown as incomplete, including when its entity list is empty, and is never treated as a clean scan.

## Optional product telemetry

Browser telemetry consent is off by default and must be enabled explicitly in
**Detection settings**. Global Privacy Control forces it off. The marketplace
bundle makes the Host relay capability available, but that relay sends nothing
until the browser user opts in. Administrators can disable the capability with
`telemetryEnabled: false`.

Marketplace installations use Alibaba Cloud ESA as a narrow public ingress.
ESA validates and rebuilds the allowlisted request, signs the request to the
origin, and forwards it to a local Node.js receiver and SQLite on the ZeroClave
ECS host. ESA is not the authoritative datastore. The official ZeroClave DSH
deployment can instead use the local receiver directly over loopback with HMAC.

The browser sends only a fresh 16-byte random identifier for the current UTC
day, the plugin version, and one of three fixed events: a successful non-empty
privacy inspection, a successful protected send, or the detector actually
used (`regex`, `embedded`, or `zeroclave`). Each event/value is delivered at
most once per browser profile per day. It does not send message or redacted
text, findings, entity types or counts, custom rules, session/account IDs,
request IDs, errors, latency, URLs, locale, or device attributes. The resulting
DAU is an approximation based on unique daily random IDs, not people. Clearing
browser storage or withdrawing and granting consent again can create another
ID on the same day.

The browser calls only the same-origin DSH Host. The Host strictly validates the
browser payload, rebuilds the fixed allowlist, and adds the package version.
Marketplace Hosts use anonymous HTTPS relay mode and contain no shared
telemetry credential:

```yaml
telemetryEnabled: true
telemetryAuthMode: anonymous
telemetryEndpoint: https://telemetry.zeroclave.ai
telemetryTimeoutMs: 2000
```

Here `telemetryEnabled` means only that the consent control can be offered; it
does not grant browser consent. For the official deployment, configure HMAC
plus the loopback receiver explicitly:

```yaml
telemetryEnabled: true
telemetryAuthMode: hmac
telemetryEndpoint: http://127.0.0.1:8788
telemetryKeyId: dsh-prod-1
telemetrySecretEnv: ZEROCLAVE_TELEMETRY_HMAC_SECRET
telemetryTimeoutMs: 2000
```

The HMAC key comes only from the named environment variable; it is never a
Cordis value, package file, or browser asset. Anonymous marketplace requests
have no Host HMAC headers. ESA validates and rebuilds them before adding its
own origin authentication.

Telemetry is best-effort and never blocks detection, redaction, or sending.
Withdrawing consent aborts pending browser delivery and clears its dedicated
telemetry IndexedDB. The service stores only a metric-scoped keyed hash, not
the raw daily identifier, in a volatile runtime database. Its internal deletion
threshold is 47 hours with a 48-hour external limit; aggregate counts contain
no identifier. The official Host sends over loopback. For marketplace Hosts,
Alibaba Cloud ESA terminates TLS and processes the allowlisted event body and
connection metadata while forwarding it; this design does not intentionally
write either to ESA logs or storage, but provider-level handling remains
governed by Alibaba Cloud's terms. The public ingress and open-source Host can
be imitated, so events are forgeable. These metrics are approximate product
trends only, never billing, abuse decisions, or security policy.

## Regex coverage

The deterministic layer currently recognizes common email addresses, mainland China phone numbers, labeled Chinese national IDs, social credit codes, contract parties and identifiers, addresses, bank details, financial amounts, IPv4 addresses, Luhn-valid payment cards, checksum-valid IBANs, labeled passwords, common API token prefixes, and PEM private keys.

Every finding contains a category, entity type, character range, masked evidence, severity, detector id, and replacement placeholder. Local regex and BERT findings also carry confidence. The Gateway contract does not return confidence, so ZeroClave findings do not display or export a fabricated score. The raw evidence is never included in the normalized JSON view.

### Custom regex rules

Open **Regex rules** in the privacy drawer to edit the detection policy for the current browser origin. Each rule defines a name, JavaScript regular expression, optional `i`/`m`/`s`/`u` flags, the complete match or one capture group to redact, entity type, category, severity, and enabled state. A rule must pass its sample test before the editor saves it. Built-in rules can be edited, disabled, duplicated, or restored; custom rules can also be deleted.

Saved rules apply to draft previews and normal composer sends. The plugin stores them in browser `localStorage`; they do not synchronize across browsers or devices. User-authored expressions run in a disposable Web Worker with limits of 1.5 seconds, 100 rules, 500,000 input characters, and 10,000 matches. A timeout, malformed rule, storage failure, or rule change during admission prevents the send so the original draft remains available.

## Development

This package currently builds against the DeepSeek Harness monorepo because the DSH client bundle preset is repository-owned. Place or link this directory at `packages/experimental/zeroclave-privacy` in a matching Harness checkout, then run:

```bash
pnpm install
pnpm --filter @zeroclave/dsh-privacy test
pnpm run build
```

The browser smoke test also runs from that package location. From a standalone clone, set `DSH_REPO` to the matching Harness checkout before running `node tests/browser-smoke.mjs`.

GitHub Actions performs the same build against the exact Harness revision recorded under `integrations/deepseek-harness/`. Pull requests run type checks, tests, a real Chrome smoke test, and package-content auditing without using secrets. Trusted `main` pushes and manual runs also expose the audited `.tgz` plus its SHA-256 checksum as a short-lived workflow artifact.

Install the built checkout into a Web profile and restart DSH:

```bash
pnpm dsh plugin --profile web add ./packages/experimental/zeroclave-privacy
pnpm dsh web --no-open
```

For marketplace distribution, publish the prebuilt npm package or provide the
prebuilt `npm pack`/`pnpm pack` tarball. Build first with the matching Harness
checkout, then run `pnpm --filter @zeroclave/dsh-privacy pack`. The package
manifest includes the DSH bundle patch and browser client artifact.

Installing this repository directly from a GitHub source URL is not currently
supported: the package has no self-contained `prepare` build, and its tsdown
configuration intentionally resolves build helpers from a matching Harness
monorepo checkout. Use the prebuilt package or tarball until that build is made
self-contained.

## Security boundaries

- Scanning is disabled by default and the enabled flag is stored only in browser local storage.
- Regex, BERT, and ZeroClave inference inspect text drafts only. Attachments, images, audio, and tool payloads are not scanned.
- Loading the model contacts Hugging Face for public model artifacts. It does not make the model remote and does not send draft text.
- Selecting ZeroClave sends draft plaintext through the DSH Host proxy to the configured ZeroClave Gateway over HTTPS. The anonymous endpoint requires no API key, but it is not E2EE and the Gateway can read the plaintext.
- The selected BERT model is English-focused. Chinese structured fields rely primarily on regex rules.
- Detection has false positives and false negatives. It is a review aid, not a compliance guarantee.
- With regex or embedded BERT, enabled composer sends deliver only redacted text to DSH and its configured chat-model Provider. With ZeroClave, DSH Host and the detection Gateway first receive plaintext for detection; the conversation and chat-model Provider receive only the redacted result. Disabling privacy sends original text.
- While privacy is enabled, the browser's lower-level `conversation.send(text)` shortcut is blocked because it cannot preserve the composer's session-aware restoration mapping. Use the normal composer path.
- Restoration mappings contain original sensitive values and stay in IndexedDB on the browser origin. They are never included in the outgoing prompt or the Host session log. Clearing browser data, changing origin/browser, or opening the conversation on another device removes access to those mappings.
- Display restoration is limited to visible message prose. Markdown destinations, code, attachment metadata, paths, identifiers, and tool payloads retain placeholders.
- Old `__PII_*__` messages from releases through alpha.5 have no durable restoration map. Unknown placeholders are preserved; the plugin cannot reconstruct their originals.
- ZeroClave requests are visible in the detection settings, expose connection errors, and use a longer draft debounce. Service failures and incomplete results block sending instead of being interpreted as no findings.
- Product telemetry is separately opt-in, defaults off in the browser, respects GPC, and never contains draft text or detection results. Marketplace relay capability is available by default, but sends nothing without consent. Alibaba Cloud ESA processes the allowlisted event body and connection metadata while forwarding it, and public events can be fabricated, so metrics are approximate only.

## Known Limitations and Deferred Work

- Automatic redaction covers the Web composer's queue and steer sends. Direct Host API/automation requests and slash-command execution outside this browser adapter are not covered; the browser-level `conversation.send(text)` shortcut is blocked while privacy is enabled.
- Custom expressions use the browser's JavaScript regular-expression syntax. The editor does not provide RE2 compatibility or import/export in this alpha.
- Mapping inheritance for forked sessions and synchronization across devices are not implemented.
- This alpha adapts the public `conversation.sendSession` method and Chat `StoredEntry.component` renderers because the supported Harness versions have no dedicated redaction middleware. Both adapters unwind when the plugin unloads and require compatibility checks on Harness upgrades. They never rewrite durable messages or model history.
- Browser history/search exports and non-Chat views retain the Host's redacted representation.

The regression suite covers original composer echoes, redacted admissions, summary-only session activity, failures, cancellation, full overlap coverage, stable mapping reuse, reload restoration, copy actions, and adapter teardown. The optional released-bundle test exercises the locally cached Harness `0.1.1-rc.2` service. `tests/browser-smoke.mjs` exercises the built plugin with real browser IndexedDB and synthetic messages; it does not call a model API.

## License

Apache-2.0. The referenced model is also published under Apache-2.0; consult its model card for intended use, evaluation results, and limitations.
