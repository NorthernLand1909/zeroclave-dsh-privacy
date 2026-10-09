# Local vLLM runtime validation

This record covers the Phase 8/9 acceptance checks for the local Qwen3.5 detector. It is a machine-specific smoke record, not a performance guarantee for other GPUs.

## Environment

- Conda executable: `/home/r_user/anaconda3/bin/conda`
- Environment: `vllm`
- vLLM: `0.31.0`
- Transformers: `5.17.0`
- PyTorch: `2.13.0+cu130`
- CUDA: available, one GPU
- Model: `Qwen3.5-0.8B-pii-v2-merged`, bf16 checkpoint, approximately 1.59 GiB
- Model path: `/mnt/c/Users/jy/Qwen3.5-0.8B-pii-v2-merged`

## Smoke result (2026-10-09)

The equivalent Supervisor argv was started on `127.0.0.1` with an API key, `--language-model-only`, `--mm-processor-cache-gb 0`, `--enforce-eager`, max length 8192 and GPU utilization 0.72.

- Model load completed successfully.
- vLLM reported `Qwen3_5ForConditionalGeneration` and served model `zeroclave-local-pii`.
- `/v1/models` returned the expected model only after bearer authentication.
- Synthetic chat completion returned `finish_reason=stop`.
- The model's trained task output was:

  ```json
  [{"pii":"demo@example.com","type":"email","confidence":"0.99"}]
  ```

- The Host adapter derives and validates the UTF-16 span `8..24` before accepting it.
- The process shut down cleanly after the smoke request.

Approximate timings from this run: checkpoint load 15 seconds; HTTP readiness after process launch about 34 seconds; first synthetic completion about 11 seconds. These values include a WSL `/mnt/c` filesystem and should be measured again on release hardware.

## Release/security gates

The automated gate is:

```text
pnpm --filter '@zeroclave/dsh-privacy' exec tsc --project tsconfig.json
pnpm --filter '@zeroclave/dsh-privacy' test
pnpm --filter '@zeroclave/dsh-privacy' run bundle
pnpm --filter '@zeroclave/dsh-privacy' pack --pack-destination ./artifacts
node scripts/audit-package.mjs artifacts/*.tgz
```

The test matrix covers schema and argv injection rejection, loopback/authentication/redirect boundaries, generation races, bounded responses and logs, strict output/Unicode offsets, partial and timeout fail-closed behavior, Host lifecycle controls, and the browser bundle's lack of `node:child_process`.

The release process must still repeat the 20-cycle start/stop leak test and the Windows 11 + WSL2 NVIDIA smoke test on the target machine. Those hardware/lifecycle checks are not inferred from this single Linux/WSL run.
