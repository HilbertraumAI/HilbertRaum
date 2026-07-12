# Pinned upstream license texts

These files are the license texts for the third-party binaries/data a prepared drive
carries OUTSIDE the packaged app, **pinned in-repo at license-review time** because the
pinned upstream release archives ship no license file of their own (full-audit
2026-07-12b LIC-1 — an offline product cannot discharge an attribution duty with a URL).
They are inlined verbatim into the generated `DRIVE-NOTICES.md`
(`node scripts/generate-drive-notices.mjs`), which `prepare-drive` copies to the drive
root. The review records they mirror live in `docs/model-policy.md` ("License-review
record — …").

| File | Covers | Review record |
|---|---|---|
| `llama.cpp-MIT.txt` | `runtime/llama.cpp/<os>/` sidecar binaries (`ggml-org/llama.cpp`, pinned tag in `model-manifests/runtime-sources.yaml`) | model-policy.md, llama.cpp runtime assets |
| `whisper.cpp-MIT.txt` | `runtime/whisper.cpp/<os>/` transcriber binaries (`ggml-org/whisper.cpp`; MIT, "The ggml authors", verified in the upstream `LICENSE` at the pinned tag) | model-policy.md, whisper.cpp runtime asset |
| `SDL2-zlib.txt` | `SDL2.dll` redistributed inside the upstream whisper.cpp Windows archive (used only by the upstream demo tools). The zlib terms are version-independent; the copyright line is as published by libsdl.org at pin time. | model-policy.md, whisper.cpp runtime asset table |
| `Apache-2.0.txt` | The canonical Apache License 2.0 full text (reproduced once in `DRIVE-NOTICES.md`): OCR traineddata + every `license: apache-2.0` model manifest | model-policy.md, OCR traineddata + per-manifest `license_review` notes |

Keep these byte-clean (LF-only, no BOM, no NUL — `repo-hygiene.test.ts` covers this dir)
and change them only together with a license re-review.
