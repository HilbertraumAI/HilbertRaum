// Pinned verbatim license texts for shipped npm packages whose PUBLISHED TARBALL
// carries no license file (full-audit 2026-07-12b LIC-3). The notices generator
// (scripts/generate-third-party-notices.mjs) reproduces only what packages ship, so
// without this map these packages' MIT/BSD notices would appear as a repository
// pointer only — which cannot discharge an attribution duty on an offline product
// (the docs/model-policy.md argument; same convention as licenses/README.md).
//
// CONVENTION: each `text` is pinned VERBATIM from the package's upstream repository
// at review time (review date 2026-07-12), because the published tarball ships no
// license file. `comment` records exactly where the text was taken from. When an
// upstream starts shipping a license file inside the tarball, the generator ignores
// the map entry automatically (it only kicks in when NO license file is found) and
// the freshness gate (apps/desktop/tests/integration/third-party-notices.test.ts)
// fails until the stale entry is removed.
//
// Kept as a lib (the shipped-packages.mjs / drive-notices.mjs precedent) so the
// vitest gate imports the SAME map the generator emits from, without executing the
// generator's side effects.

/**
 * Package name -> pinned notice.
 * @type {Record<string, { comment: string, text: string }>}
 */
export const KNOWN_EXTRA_NOTICES = {
  // BSD-2-Clause declared in package.json (author "Michael Williamson <mike@zwobble.org>").
  // The upstream repository (github.com/mwilliamson/dingbat-to-unicode) publishes no
  // license file either, so this is the standard BSD-2-Clause text with the copyright
  // holder taken from the package's declared `author`; upstream publishes no copyright
  // year, so none is stated.
  'dingbat-to-unicode': {
    comment:
      'The upstream repository publishes no license file either; this is the standard ' +
      'BSD-2-Clause text with the copyright holder from the package’s declared `author` ' +
      '(upstream publishes no copyright year, so none is stated).',
    text: [
      'Copyright (c) Michael Williamson <mike@zwobble.org>',
      '',
      'Redistribution and use in source and binary forms, with or without',
      'modification, are permitted provided that the following conditions are met:',
      '',
      '1. Redistributions of source code must retain the above copyright notice,',
      '   this list of conditions and the following disclaimer.',
      '',
      '2. Redistributions in binary form must reproduce the above copyright notice,',
      '   this list of conditions and the following disclaimer in the documentation',
      '   and/or other materials provided with the distribution.',
      '',
      'THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"',
      'AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE',
      'IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE',
      'ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE',
      'LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR',
      'CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF',
      'SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS',
      'INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN',
      'CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)',
      'ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE',
      'POSSIBILITY OF SUCH DAMAGE.'
    ].join('\n')
  },

  // MIT grant reproduced from the package's OWN README ("License" section, HTML
  // entities decoded) — the tarball ships the notice, just not as a license FILE.
  isarray: {
    comment:
      'Reproduced from the MIT grant in the package’s own README (“License” section).',
    text: [
      'Copyright (c) 2013 Julian Gruber <julian@juliangruber.com>',
      '',
      'Permission is hereby granted, free of charge, to any person obtaining a copy of',
      'this software and associated documentation files (the "Software"), to deal in',
      'the Software without restriction, including without limitation the rights to',
      'use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies',
      'of the Software, and to permit persons to whom the Software is furnished to do',
      'so, subject to the following conditions:',
      '',
      'The above copyright notice and this permission notice shall be included in all',
      'copies or substantial portions of the Software.',
      '',
      'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
      'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
      'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
      'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
      'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
      'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
      'SOFTWARE.'
    ].join('\n')
  },

  // LICENSE at github.com/theKashey/react-remove-scroll-bar (master), fetched
  // 2026-07-12; the copyright line (including its year) is as published upstream at
  // pin time.
  'react-remove-scroll-bar': {
    comment:
      'Reproduced from the upstream repository’s LICENSE; the copyright line ' +
      '(including its year) is as published upstream at pin time.',
    text: [
      'MIT License',
      '',
      'Copyright (c) 2025 Anton Korzunov <thekashey@gmail.com>',
      '',
      'Permission is hereby granted, free of charge, to any person obtaining a copy',
      'of this software and associated documentation files (the "Software"), to deal',
      'in the Software without restriction, including without limitation the rights',
      'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
      'copies of the Software, and to permit persons to whom the Software is',
      'furnished to do so, subject to the following conditions:',
      '',
      'The above copyright notice and this permission notice shall be included in all',
      'copies or substantial portions of the Software.',
      '',
      'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
      'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
      'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
      'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
      'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
      'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
      'SOFTWARE.'
    ].join('\n')
  },

  // rehype-katex and remark-math are workspace packages of the remark-math monorepo
  // (github.com/remarkjs/remark-math); its root `license` file (fetched 2026-07-12)
  // covers both. Same text pinned for each so every section stands alone.
  'rehype-katex': {
    comment:
      'Reproduced from the remark-math monorepo’s root `license` file ' +
      '(github.com/remarkjs/remark-math), which covers this workspace package.',
    text: [
      '(The MIT License)',
      '',
      'Copyright (c) Junyoung Choi <fluke8259@gmail.com>',
      '',
      'Permission is hereby granted, free of charge, to any person obtaining a copy',
      'of this software and associated documentation files (the "Software"), to deal',
      'in the Software without restriction, including without limitation the rights',
      'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
      'copies of the Software, and to permit persons to whom the Software is',
      'furnished to do so, subject to the following conditions:',
      '',
      'The above copyright notice and this permission notice shall be included in all',
      'copies or substantial portions of the Software.',
      '',
      'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
      'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
      'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
      'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
      'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
      'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
      'SOFTWARE.'
    ].join('\n')
  },

  'remark-math': {
    comment:
      'Reproduced from the remark-math monorepo’s root `license` file ' +
      '(github.com/remarkjs/remark-math), which covers this workspace package.',
    text: [
      '(The MIT License)',
      '',
      'Copyright (c) Junyoung Choi <fluke8259@gmail.com>',
      '',
      'Permission is hereby granted, free of charge, to any person obtaining a copy',
      'of this software and associated documentation files (the "Software"), to deal',
      'in the Software without restriction, including without limitation the rights',
      'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
      'copies of the Software, and to permit persons to whom the Software is',
      'furnished to do so, subject to the following conditions:',
      '',
      'The above copyright notice and this permission notice shall be included in all',
      'copies or substantial portions of the Software.',
      '',
      'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
      'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
      'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
      'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
      'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
      'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
      'SOFTWARE.'
    ].join('\n')
  },

  // The shipped tr46@0.0.3 tarball (author "Sebastian Mayr <npm@smayr.name>") ships
  // no license file; the upstream lineage's LICENSE.md (github.com/jsdom/tr46 —
  // also installed in this tree as tr46@6.0.0's LICENSE.md, byte-identical) names
  // Sebastian Mayr as the copyright holder.
  tr46: {
    comment:
      'Reproduced from the upstream lineage’s LICENSE.md (github.com/jsdom/tr46; ' +
      'byte-identical to the LICENSE.md shipped by the newer tr46 in this same tree).',
    text: [
      'The MIT License (MIT)',
      '',
      'Copyright (c) Sebastian Mayr',
      '',
      'Permission is hereby granted, free of charge, to any person obtaining a copy',
      'of this software and associated documentation files (the "Software"), to deal',
      'in the Software without restriction, including without limitation the rights',
      'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
      'copies of the Software, and to permit persons to whom the Software is',
      'furnished to do so, subject to the following conditions:',
      '',
      'The above copyright notice and this permission notice shall be included in all',
      'copies or substantial portions of the Software.',
      '',
      'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
      'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
      'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
      'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
      'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
      'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
      'SOFTWARE.'
    ].join('\n')
  }
}

/**
 * Leptonica license (full-audit 2026-07-12b LIC-3): tesseract.js-core's WASM
 * binaries statically link the leptonica image-processing library, but the published
 * package reproduces only the tesseract-ocr Apache-2.0 LICENSE (upstream packaging
 * shortfall). Pinned verbatim from the upstream repository's leptonica-license.txt
 * (github.com/DanBloomberg/leptonica) at review time 2026-07-12, including its
 * source-comment framing.
 */
export const LEPTONICA_LICENSE = [
  '/*====================================================================*',
  ' -  Copyright (C) 2001-2020 Leptonica.  All rights reserved.',
  ' -',
  ' -  Redistribution and use in source and binary forms, with or without',
  ' -  modification, are permitted provided that the following conditions',
  ' -  are met:',
  ' -  1. Redistributions of source code must retain the above copyright',
  ' -     notice, this list of conditions and the following disclaimer.',
  ' -  2. Redistributions in binary form must reproduce the above',
  ' -     copyright notice, this list of conditions and the following',
  ' -     disclaimer in the documentation and/or other materials',
  ' -     provided with the distribution.',
  ' -',
  ' -  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS',
  " -  ``AS IS'' AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT",
  ' -  LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR',
  ' -  A PARTICULAR PURPOSE ARE DISCLAIMED.  IN NO EVENT SHALL ANY',
  ' -  CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,',
  ' -  EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,',
  ' -  PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR',
  ' -  PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY',
  ' -  OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING',
  ' -  NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS',
  ' -  SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.',
  ' *====================================================================*/'
].join('\n')
