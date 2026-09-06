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
| `GPL-2.0.txt` | libzim 9.4.0 (`COPYING` = GPL-2.0; per-file headers are mixed, see the kiwix-tools DRIVE-NOTICES.md section — "GPL-2.0-or-later, with GPL-3.0-or-later files"), Xapian (`xapian-core`) 1.4.23 | `docs/model-policy.md` "Sidecar binaries — kiwix-tools" (review pending) |
| `LGPL-2.1.txt` | libmicrohttpd 0.9.76, statically linked into `kiwix-serve` (`COPYING` as published upstream, including its own dual-license preamble note ahead of the LGPLv2.1 text) | `docs/model-policy.md` "Sidecar binaries — kiwix-tools" (review pending) |
| `curl.txt` | libcurl 8.4.0, statically linked into `kiwix-serve` (`COPYING`, `curl`/`curl-8_4_0` tag) | `docs/model-policy.md` "Sidecar binaries — kiwix-tools" (review pending) |
| `ICU-Unicode.txt` | ICU 74 — the five `icu*74.dll` files in the kiwix-tools Windows bundle (`unicode-org/icu`, tag `release-74-1`) | `docs/model-policy.md` "Sidecar binaries — kiwix-tools" (review pending) |
| `docopt-MIT.txt` | docopt.cpp 0.6.3, statically linked into the kiwix-tools executables (`docopt/docopt.cpp`, tag `v0.6.3`, `LICENSE-MIT`; MIT/Boost dual, taken under MIT) | `docs/model-policy.md` "Sidecar binaries — kiwix-tools" (review pending) |
| `pugixml-MIT.txt` | pugixml 1.15, statically linked into libkiwix (`zeux/pugixml`, tag `v1.15`, `LICENSE.md`) | `docs/model-policy.md` "Sidecar binaries — kiwix-tools" (review pending) |
| `zlib.txt` | zlib 1.3.1, statically linked into libkiwix (`madler/zlib`, tag `v1.3.1`, `LICENSE`) — a *different* copyright line from `SDL2-zlib.txt` above, so it gets its own file | `docs/model-policy.md` "Sidecar binaries — kiwix-tools" (review pending) |
| `zstd-BSD-3-Clause.txt` | Zstandard 1.5.7, statically linked into libzim (`facebook/zstd`, tag `v1.5.7`, `LICENSE`; BSD-3-Clause/GPL-2.0 dual, taken under BSD-3-Clause) | `docs/model-policy.md` "Sidecar binaries — kiwix-tools" (review pending) |
| `xz-COPYING.txt` | xz / liblzma 5.2.6, statically linked into libzim (`tukaani-project/xz`, tag `v5.2.6`, `COPYING`; at 5.2.6 liblzma is public domain — the 0BSD relicensing came in a later xz release, so this file is named for its actual grant, not `xz-0BSD.txt`) | `docs/model-policy.md` "Sidecar binaries — kiwix-tools" (review pending) |

GPL-3.0-or-later components (kiwix-tools itself, libkiwix, and the effectively-v3
combined work of libzim — #339 P8-1) are **not** duplicated here: the full GNU General
Public License v3 text already ships as the drive-root `LICENSE`, and the kiwix-tools
DRIVE-NOTICES.md section references it by name instead of inlining a tenth GPL text.

Keep these byte-clean (LF-only, no BOM, no NUL — `repo-hygiene.test.ts` covers this dir)
and change them only together with a license re-review.
