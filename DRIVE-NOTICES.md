# Drive notices — licenses & attribution

This file covers everything a prepared HilbertRaum drive carries OUTSIDE the
packaged application: the sidecar runtime binaries (llama.cpp, whisper.cpp), the
OCR language data, and the model weights described by the manifests under
`model-manifests/`.

- **HilbertRaum itself** is free software under **GPL-3.0-or-later** — the full
  license text ships as `LICENSE` at this drive's root. The complete corresponding
  source code is available at https://github.com/HilbertraumAI/HilbertRaum.
- **Third-party npm packages bundled inside the application** are covered by
  `THIRD-PARTY-NOTICES.md`, also at this drive's root.

This file is GENERATED — do not edit by hand. It is derived from the committed
model manifests (`model-manifests/**/*.yaml`), the runtime pin file
(`model-manifests/runtime-sources.yaml`), and the license texts pinned under
`licenses/` (the upstream binary release archives ship no license file — see
`licenses/README.md`). Regenerate with:

```
node scripts/generate-drive-notices.mjs
```

## Coverage (machine-readable)

```
runtime-family: llama_cpp b9849
runtime-family: ocr 4.0.0_best_int
runtime-family: whisper_cpp v1.8.6
model: bge-reranker-v2-m3-f16 apache-2.0
model: gemma-4-26b-q4 gemma
model: gemma4-12b-it-qat-q4 apache-2.0
model: gemma4-26b-a4b-it-qat-q4 apache-2.0
model: gemma4-31b-it-qat-q4 apache-2.0
model: gemma4-coding-q8 gemma
model: gemma4-e2b-it-qat-q4 apache-2.0
model: gemma4-e4b-it-qat-q4 apache-2.0
model: granite-4.1-8b-q4 apache-2.0
model: ministral3-8b-instruct-2512-q4 apache-2.0
model: multilingual-e5-small-q8 mit
model: qwen2.5-vl-3b-instruct-q4 apache-2.0
model: qwen3-14b-instruct-q4 apache-2.0
model: qwen3-30b-a3b-q4 apache-2.0
model: qwen3-4b-instruct-2507-q4 apache-2.0
model: qwen3-4b-instruct-q4 apache-2.0
model: qwen3-8b-instruct-q4 apache-2.0
model: qwen3.5-0.8b-q6 apache-2.0
model: qwen3.5-27b-ud-q4kxl apache-2.0
model: qwen3.5-2b-ud-q4kxl apache-2.0
model: qwen3.5-35b-a3b-ud-q4kxl apache-2.0
model: qwen3.5-4b-ud-q4kxl apache-2.0
model: qwen3.5-9b-q8 apache-2.0
model: qwen3.5-9b-ud-q4kxl apache-2.0
model: qwen3.6-27b-q4 apache-2.0
model: qwen3.6-27b-q5 apache-2.0
model: translategemma-12b-it-q4 gemma
model: whisper-small-multilingual mit
```

## Runtime binaries and data

### llama.cpp b9849 — MIT

The `llama-server` binaries under `runtime/llama.cpp/<os>/` are prebuilt release
assets of the MIT-licensed `ggml-org/llama.cpp` project
(https://github.com/ggml-org/llama.cpp), pinned at release b9849
(license review: `docs/model-policy.md`). The upstream archives ship no license
file, so the MIT text was pinned in-repo at review time (`licenses/llama.cpp-MIT.txt`):

```
MIT License

Copyright (c) 2023-2024 The ggml authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### whisper.cpp v1.8.6 — MIT

The `whisper-cli` transcriber binaries under `runtime/whisper.cpp/<os>/` are built
from the MIT-licensed `ggml-org/whisper.cpp` project
(https://github.com/ggml-org/whisper.cpp), pinned at release v1.8.6
(Windows: the upstream prebuilt archive; macOS/Linux: compiled from the same pinned
source — license review: `docs/model-policy.md`). The pinned MIT text
(`licenses/whisper.cpp-MIT.txt`):

```
MIT License

Copyright (c) 2023-2024 The ggml authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

#### SDL2 (bundled in the whisper.cpp Windows archive) — zlib

The upstream whisper.cpp Windows archive redistributes `SDL2.dll` (used only by the
upstream demo tools; recorded in the whisper.cpp license review,
`docs/model-policy.md`). SDL2 is under the zlib license (`licenses/SDL2-zlib.txt`):

```
Simple DirectMedia Layer
Copyright (C) 1997-2025 Sam Lantinga <slouken@libsdl.org>

This software is provided 'as-is', without any express or implied
warranty.  In no event will the authors be held liable for any damages
arising from the use of this software.

Permission is granted to anyone to use this software for any purpose,
including commercial applications, and to alter it and redistribute it
freely, subject to the following restrictions:

1. The origin of this software must not be misrepresented; you must not
   claim that you wrote the original software. If you use this software
   in a product, an acknowledgment in the product documentation would be
   appreciated but is not required.
2. Altered source versions must be plainly marked as such, and must not be
   misrepresented as being the original software.
3. This notice may not be removed or altered from any source distribution.
```

### OCR language data 4.0.0_best_int — Apache-2.0

The `ocr/*.traineddata.gz` language files are the tesseract-ocr project's
traineddata (the integerized tessdata_best variant, repackaged by the tesseract.js
project as `@tesseract.js-data/*`), licensed **Apache-2.0** (license review:
`docs/model-policy.md`). The full Apache License 2.0 text is reproduced once in the
"Apache License 2.0" section at the end of this file.

## Model weights

One attribution line per model manifest shipped under `model-manifests/` (the
manifests are always on the drive; whether a weight is pre-loaded varies by drive).
Grouped by the license each manifest declares; each line's license URL is the
manifest's recorded `download.license_url`. A `license_review.status` other than
`approved` is noted on the line — such a model is never pre-loaded on a sold drive
(the sell gate requires an approved review for every manifest).

### apache-2.0 (23 models)

Licensed under the Apache License 2.0 — the full text is reproduced once in the
"Apache License 2.0" section at the end of this file.

- BGE Reranker v2 M3 (F16) (`bge-reranker-v2-m3-f16`) — upstream: https://huggingface.co/gpustack/bge-reranker-v2-m3-GGUF — license: apache-2.0 (https://huggingface.co/BAAI/bge-reranker-v2-m3)
- Gemma 4 12B Instruct QAT Q4 (`gemma4-12b-it-qat-q4`) — upstream: https://huggingface.co/google/gemma-4-12B-it-qat-q4_0-gguf — license: apache-2.0 (https://www.apache.org/licenses/LICENSE-2.0)
- Gemma 4 26B-A4B Instruct QAT Q4 (`gemma4-26b-a4b-it-qat-q4`) — upstream: https://huggingface.co/google/gemma-4-26B-A4B-it-qat-q4_0-gguf — license: apache-2.0 (https://www.apache.org/licenses/LICENSE-2.0)
- Gemma 4 31B Instruct QAT Q4 (`gemma4-31b-it-qat-q4`) — upstream: https://huggingface.co/google/gemma-4-31B-it-qat-q4_0-gguf — license: apache-2.0 (https://www.apache.org/licenses/LICENSE-2.0)
- Gemma 4 E2B Instruct QAT Q4 (`gemma4-e2b-it-qat-q4`) — upstream: https://huggingface.co/google/gemma-4-E2B-it-qat-q4_0-gguf — license: apache-2.0 (https://www.apache.org/licenses/LICENSE-2.0)
- Gemma 4 E4B Instruct QAT Q4 (`gemma4-e4b-it-qat-q4`) — upstream: https://huggingface.co/google/gemma-4-E4B-it-qat-q4_0-gguf — license: apache-2.0 (https://www.apache.org/licenses/LICENSE-2.0)
- Granite 4.1 8B Q4 (`granite-4.1-8b-q4`) — upstream: https://huggingface.co/ibm-granite/granite-4.1-8b-GGUF — license: apache-2.0 (https://www.apache.org/licenses/LICENSE-2.0)
- Ministral 3 8B Instruct (2512) Q4 (`ministral3-8b-instruct-2512-q4`) — upstream: https://huggingface.co/mistralai/Ministral-3-8B-Instruct-2512-GGUF — license: apache-2.0 (https://www.apache.org/licenses/LICENSE-2.0)
- Qwen2.5-VL 3B Instruct Q4 (`qwen2.5-vl-3b-instruct-q4`) — upstream: https://huggingface.co/ggml-org/Qwen2.5-VL-3B-Instruct-GGUF — license: apache-2.0 (https://huggingface.co/Qwen/Qwen2.5-VL-3B-Instruct/blob/main/LICENSE)
- Qwen3 14B Instruct Q4 (`qwen3-14b-instruct-q4`) — upstream: https://huggingface.co/Qwen/Qwen3-14B-GGUF — license: apache-2.0 (https://huggingface.co/Qwen/Qwen3-14B-GGUF/blob/main/LICENSE)
- Qwen3 30B-A3B (MoE) Q4 (`qwen3-30b-a3b-q4`) — upstream: https://huggingface.co/Qwen/Qwen3-30B-A3B-GGUF — license: apache-2.0 (https://huggingface.co/Qwen/Qwen3-30B-A3B-GGUF/blob/main/LICENSE)
- Qwen3 4B Instruct 2507 Q4 (`qwen3-4b-instruct-2507-q4`) — upstream: https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF — license: apache-2.0 (https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507/blob/main/LICENSE)
- Qwen3 4B Instruct Q4 (`qwen3-4b-instruct-q4`) — upstream: https://huggingface.co/Qwen/Qwen3-4B-GGUF — license: apache-2.0 (https://huggingface.co/Qwen/Qwen3-4B-GGUF/blob/main/LICENSE)
- Qwen3 8B Instruct Q4 (`qwen3-8b-instruct-q4`) — upstream: https://huggingface.co/Qwen/Qwen3-8B-GGUF — license: apache-2.0 (https://huggingface.co/Qwen/Qwen3-8B-GGUF/blob/main/LICENSE)
- Qwen3.5 0.8B Q6_K (`qwen3.5-0.8b-q6`) — upstream: https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF — license: apache-2.0 (https://huggingface.co/Qwen/Qwen3.5-0.8B/blob/main/LICENSE)
- Qwen3.5 27B (UD-Q4_K_XL) (`qwen3.5-27b-ud-q4kxl`) — upstream: https://huggingface.co/unsloth/Qwen3.5-27B-GGUF — license: apache-2.0 (https://huggingface.co/Qwen/Qwen3.5-27B/blob/main/LICENSE)
- Qwen3.5 2B (UD-Q4_K_XL) (`qwen3.5-2b-ud-q4kxl`) — upstream: https://huggingface.co/unsloth/Qwen3.5-2B-GGUF — license: apache-2.0 (https://huggingface.co/Qwen/Qwen3.5-2B/blob/main/LICENSE)
- Qwen3.5 35B-A3B (UD-Q4_K_XL) (`qwen3.5-35b-a3b-ud-q4kxl`) — upstream: https://huggingface.co/unsloth/Qwen3.5-35B-A3B-GGUF — license: apache-2.0 (https://huggingface.co/Qwen/Qwen3.5-35B-A3B/blob/main/LICENSE)
- Qwen3.5 4B (UD-Q4_K_XL) (`qwen3.5-4b-ud-q4kxl`) — upstream: https://huggingface.co/unsloth/Qwen3.5-4B-GGUF — license: apache-2.0 (https://huggingface.co/Qwen/Qwen3.5-4B/blob/main/LICENSE)
- Qwen3.5 9B Q8_0 (`qwen3.5-9b-q8`) — upstream: (no download block — see the manifest) — license: apache-2.0
- Qwen3.5 9B (UD-Q4_K_XL) (`qwen3.5-9b-ud-q4kxl`) — upstream: https://huggingface.co/unsloth/Qwen3.5-9B-GGUF — license: apache-2.0 (https://huggingface.co/Qwen/Qwen3.5-9B/blob/main/LICENSE)
- Qwen3.6 27B Q4_K_M (`qwen3.6-27b-q4`) — upstream: https://huggingface.co/unsloth/Qwen3.6-27B-GGUF — license: apache-2.0 (https://huggingface.co/Qwen/Qwen3.6-27B/blob/main/LICENSE)
- Qwen3.6 27B Q5_K_M (`qwen3.6-27b-q5`) — upstream: https://huggingface.co/unsloth/Qwen3.6-27B-GGUF — license: apache-2.0 (https://huggingface.co/Qwen/Qwen3.6-27B/blob/main/LICENSE)

### gemma (3 models)

Not covered by a permissive text reproduced in this file — see each line's
license URL for the governing terms and the manifest's `license_review` block
for the review record.

- Gemma 4 26B A4B Q4_K_M (`gemma-4-26b-q4`) — upstream: (no download block — see the manifest) — license: gemma
- Gemma 4 Coding Q8_0 (`gemma4-coding-q8`) — upstream: (no download block — see the manifest) — license: gemma
- TranslateGemma 12B (Q4_K_M) (`translategemma-12b-it-q4`) — upstream: https://huggingface.co/mradermacher/translategemma-12b-it-GGUF — license: gemma (https://ai.google.dev/gemma/terms) — license_review.status: pending

### mit (2 models)

Licensed under the MIT license — the MIT text is reproduced verbatim in the
llama.cpp section above. MIT requires the copyright notice to accompany copies,
so each line below carries its model's upstream copyright line, pinned at
review time (as published upstream — the `licenses/README.md` convention).

- Multilingual E5 Small (F16) (`multilingual-e5-small-q8`) — upstream: https://huggingface.co/keisuke-miyako/multilingual-e5-small-gguf-f16 — license: mit (https://huggingface.co/intfloat/multilingual-e5-small) — Copyright (c) Microsoft Corporation (github.com/microsoft/unilm, the multilingual-e5 upstream)
- Whisper Small (multilingual transcriber) (`whisper-small-multilingual`) — upstream: https://huggingface.co/ggerganov/whisper.cpp — license: mit (https://github.com/openai/whisper/blob/main/LICENSE) — Copyright (c) 2022 OpenAI (github.com/openai/whisper)

## Apache License 2.0

The full text (`licenses/Apache-2.0.txt`), applying to every artifact marked
Apache-2.0 above:

```
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "{}"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright {yyyy} {name of copyright owner}

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```
