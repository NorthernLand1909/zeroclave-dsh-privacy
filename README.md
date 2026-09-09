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
- Leaves a disabled `ZeroClaveDetector` Provider as the future remote integration point.

With privacy enabled, the normal composer send action automatically scans and redacts text. The original draft is not replaced. A failed scan or mapping write prevents the send, allowing the composer to retain the original for retry. The inspection drawer remains an explicit view of the original and redacted preview.

The default send policy pauses a message containing critical findings before Host admission. The review lists the matching rule or model source, starts every finding in the redacted state, and lets the user keep an individual value for that send. Cancelling the review leaves the draft available and writes no restoration mapping. Users who prefer an uninterrupted flow can select automatic redaction under **Detection settings**.

Session activity contains only time, counts, highest risk, detector modes, and fallback status. It stores no draft, finding, evidence, replacement, or redacted text, and disappears when the page reloads.

## Detection backends

| Backend | Execution | Network behavior | Status |
| --- | --- | --- | --- |
| Regex | Browser | None | Ready |
| Embedded BERT | Browser WASM | Downloads pinned model files on first load; draft text is not sent to Hugging Face | Ready |
| ZeroClave | Remote | None until a Provider is implemented | Reserved |

The embedded model is pinned to revision `f8c27a85c51c0168f07b9dcf00265bf0a4097939` and loads the repository's 28.7 MB `model.quant.onnx` artifact. Browser cache avoids downloading the weights again in normal use.

## Regex coverage

The deterministic layer currently recognizes common email addresses, mainland China phone numbers, labeled Chinese national IDs, social credit codes, contract parties and identifiers, addresses, bank details, financial amounts, IPv4 addresses, Luhn-valid payment cards, checksum-valid IBANs, labeled passwords, common API token prefixes, and PEM private keys.

Every finding contains a category, entity type, character range, masked evidence, confidence, severity, detector id, and replacement placeholder. The raw evidence is never included in the normalized JSON view.

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

Install the built checkout into a Web profile and restart DSH:

```bash
pnpm dsh plugin --profile web add ./packages/experimental/zeroclave-privacy
pnpm dsh web --no-open
```

For distribution, build first and create a tarball with `pnpm --filter @zeroclave/dsh-privacy pack`. The package manifest includes the DSH bundle patch and browser client artifact.

## Security boundaries

- Scanning is disabled by default and the enabled flag is stored only in browser local storage.
- Regex and BERT inference inspect text drafts only. Attachments, images, audio, and tool payloads are not scanned.
- Loading the model contacts Hugging Face for public model artifacts. It does not make the model remote and does not send draft text.
- The selected BERT model is English-focused. Chinese structured fields rely primarily on regex rules.
- Detection has false positives and false negatives. It is a review aid, not a compliance guarantee.
- Enabled composer sends deliver only their redacted text to DSH and its configured model Provider. Disabling privacy sends original text.
- Restoration mappings contain original sensitive values and stay in IndexedDB on the browser origin. They are never included in the outgoing prompt or the Host session log. Clearing browser data, changing origin/browser, or opening the conversation on another device removes access to those mappings.
- Display restoration is limited to visible message prose. Markdown destinations, code, attachment metadata, paths, identifiers, and tool payloads retain placeholders.
- Old `__PII_*__` messages from releases through alpha.5 have no durable restoration map. Unknown placeholders are preserved; the plugin cannot reconstruct their originals.
- The ZeroClave mode is visibly unconfigured and falls back to regex. It does not perform a hidden network request.

## Known Limitations and Deferred Work

- Automatic redaction covers the Web composer's queue and steer sends. Direct API/automation requests and slash-command execution do not pass through this browser-only adapter.
- Custom expressions use the browser's JavaScript regular-expression syntax. The editor does not provide RE2 compatibility or import/export in this alpha.
- Mapping inheritance for forked sessions and synchronization across devices are not implemented.
- This alpha adapts the public `conversation.sendSession` method and Chat `StoredEntry.component` renderers because the supported Harness versions have no dedicated redaction middleware. Both adapters unwind when the plugin unloads and require compatibility checks on Harness upgrades. They never rewrite durable messages or model history.
- Browser history/search exports and non-Chat views retain the Host's redacted representation.

The regression suite covers original composer echoes, redacted admissions, summary-only session activity, failures, cancellation, full overlap coverage, stable mapping reuse, reload restoration, copy actions, and adapter teardown. The optional released-bundle test exercises the locally cached Harness `0.1.1-rc.2` service. `tests/browser-smoke.mjs` exercises the built plugin with real browser IndexedDB and synthetic messages; it does not call a model API.

## License

Apache-2.0. The referenced model is also published under Apache-2.0; consult its model card for intended use, evaluation results, and limitations.
