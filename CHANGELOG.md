# Changelog

## 2026-05-13

### Runtime Stability and Infrastructure Hardening
- Made cache writes deterministic by awaiting canvas blob creation and cache persistence.
- Added image load timeout handling to prevent stuck foreground/background processing.
- Added bounded in-memory cache eviction (LRU-style access refresh).
- Consolidated gallery URL parsing through a single parser.
- Debounced observer-driven background discovery to reduce scan pressure.
- Captured normalized runtime settings snapshots per processing job.
- Hardened adapter contracts with runtime validation and safer fallback behavior.
- Made global fetch/image hooks idempotent to avoid multi-wrap monkey patch issues.
- Added boot diagnostics and startup dependency readiness logging.
- Tightened DNR CORS rewrite scope to gallery images only.
- Added popup runtime diagnostics panel with backend/hook/queue status.
- Migrated content runtime loading to a generated single bundle (`src/runtime/runtime.bundle.js`) with a build script.

### Cleanup
- Removed unused helpers in runtime URL and WebGPU adapter modules.
- Standardized prewarm failure logging to `engine:prewarm-failed`.