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

/**
 * The SIL Open Font License 1.1, for the KaTeX font files (dist/fonts/KaTeX_*), whose
 * package ships only its MIT LICENSE. Until wave DEP-6 the generator copied this body out of
 * pdfjs-dist/standard_fonts/LICENSE_LIBERATION; pdfjs-dist 6.3 replaced that file with the
 * Liberation 1.07.4 licence (GPL v2), so the text is pinned here. It is the body the notices
 * carried before, with the two dashes that file had lost to an encoding error restored to
 * the official plain-text "--".
 */
export const OFL_1_1_LICENSE = [
  'SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007',
  '',
  'PREAMBLE The goals of the Open Font License (OFL) are to stimulate',
  'worldwide development of collaborative font projects, to support the font',
  'creation efforts of academic and linguistic communities, and to provide',
  'a free and open framework in which fonts may be shared and improved in',
  'partnership with others.',
  '',
  'The OFL allows the licensed fonts to be used, studied, modified and',
  'redistributed freely as long as they are not sold by themselves.',
  'The fonts, including any derivative works, can be bundled, embedded,',
  'redistributed and/or sold with any software provided that any reserved',
  'names are not used by derivative works.  The fonts and derivatives,',
  'however, cannot be released under any other type of license.  The',
  'requirement for fonts to remain under this license does not apply to',
  'any document created using the fonts or their derivatives.',
  '',
  '',
  '',
  'DEFINITIONS',
  '"Font Software" refers to the set of files released by the Copyright',
  'Holder(s) under this license and clearly marked as such.',
  'This may include source files, build scripts and documentation.',
  '',
  '"Reserved Font Name" refers to any names specified as such after the',
  'copyright statement(s).',
  '',
  '"Original Version" refers to the collection of Font Software components',
  'as distributed by the Copyright Holder(s).',
  '',
  '"Modified Version" refers to any derivative made by adding to, deleting,',
  'or substituting -- in part or in whole --',
  'any of the components of the Original Version, by changing formats or',
  'by porting the Font Software to a new environment.',
  '',
  '"Author" refers to any designer, engineer, programmer, technical writer',
  'or other person who contributed to the Font Software.',
  '',
  '',
  'PERMISSION & CONDITIONS',
  '',
  'Permission is hereby granted, free of charge, to any person obtaining a',
  'copy of the Font Software, to use, study, copy, merge, embed, modify,',
  'redistribute, and sell modified and unmodified copies of the Font',
  'Software, subject to the following conditions:',
  '',
  '1) Neither the Font Software nor any of its individual components,in',
  '   Original or Modified Versions, may be sold by itself.',
  '',
  '2) Original or Modified Versions of the Font Software may be bundled,',
  '   redistributed and/or sold with any software, provided that each copy',
  '   contains the above copyright notice and this license. These can be',
  '   included either as stand-alone text files, human-readable headers or',
  '   in the appropriate machine-readable metadata fields within text or',
  '   binary files as long as those fields can be easily viewed by the user.',
  '',
  '3) No Modified Version of the Font Software may use the Reserved Font',
  '   Name(s) unless explicit written permission is granted by the',
  '   corresponding Copyright Holder. This restriction only applies to the',
  '   primary font name as presented to the users.',
  '',
  '4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font',
  '   Software shall not be used to promote, endorse or advertise any',
  '   Modified Version, except to acknowledge the contribution(s) of the',
  '   Copyright Holder(s) and the Author(s) or with their explicit written',
  '   permission.',
  '',
  '5) The Font Software, modified or unmodified, in part or in whole, must',
  '   be distributed entirely under this license, and must not be distributed',
  '   under any other license. The requirement for fonts to remain under',
  '   this license does not apply to any document created using the Font',
  '   Software.',
  '',
  '',
  '',
  'TERMINATION',
  'This license becomes null and void if any of the above conditions are not met.',
  '',
  '',
  '',
  'DISCLAIMER',
  'THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,',
  'EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF',
  'MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT',
  'OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT.  IN NO EVENT SHALL THE',
  'COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,',
  'INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL',
  'DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING',
  'FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM OTHER',
  'DEALINGS IN THE FONT SOFTWARE.'
].join('\n')
