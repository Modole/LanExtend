# Third-Party Notices

This file describes direct runtime/build dependencies and implementation references for LanExtend 0.1.0. The authoritative resolved dependency graph is `package-lock.json`. A release maintainer must re-run license review whenever the lockfile or packaging inputs change.

LanExtend source code is licensed under the repository's MIT License. Third-party components remain under their respective licenses.

## Components distributed or used directly

### Electron 43.2.0

- Project: <https://github.com/electron/electron>
- License: MIT
- Copyright: Copyright (c) Electron contributors; Copyright (c) 2013-2020 GitHub Inc.
- Relationship: Electron is the desktop runtime included in macOS and Windows packages.

Electron includes Chromium, Node.js, and many other third-party components. Electron distributions provide their detailed notices in files such as `LICENSE.electron.txt`/`LICENSE` and `LICENSES.chromium.html`. Packaging and redistribution must preserve those files; this summary is not a replacement for Electron's bundled notices.

### ws 8.21.3

- Project: <https://github.com/websockets/ws>
- License: MIT
- Relationship: production WebSocket server/runtime dependency.
- Copyright notices:
  - Copyright (c) 2011 Einar Otto Stangvik `<einaros@gmail.com>`
  - Copyright (c) 2013 Arnout Kazemier and contributors
  - Copyright (c) 2016 Luigi Pinca and contributors

### electron-builder 26.15.3

- Project: <https://github.com/electron-userland/electron-builder>
- License: MIT
- Copyright: Copyright (c) 2015 Loopline Systems
- Relationship: build-time packaging tool. It is not application business logic, but it and its dependency tree are used to produce distributed artifacts.

### MIT License text for the components above

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

The quotation above is the standard MIT license text and is included to satisfy the notice requirement together with each component's copyright lines.

## API/compatibility references; no code incorporated

The following projects are **not linked, vendored, copied, or included as runtime dependencies**. They were consulted as public documentation or architectural prior art. Listing them here is for provenance and does not relicense LanExtend or imply that their copyleft code may be copied into this MIT repository.

### Chromium virtual display test utility

- Source consulted: <https://chromium.googlesource.com/chromium/src/+/HEAD/ui/display/mac/test/virtual_display_util_mac.mm>
- Upstream project: Chromium
- Upstream license: BSD-style; see the LICENSE in the corresponding Chromium source revision.
- Scope consulted: private Objective-C class/selector names and compatibility observations such as non-zero vendor IDs and unique serial numbers.
- LanExtend relationship: `native/macos/CGVirtualDisplayPrivate.h` contains minimal original declarations; the helper control flow and implementation are original LanExtend code.

### DeskPad private API declaration

- Project: <https://github.com/Stengo/DeskPad>
- File consulted: <https://github.com/Stengo/DeskPad/blob/main/DeskPad/CGVirtualDisplayPrivate.h>
- Upstream license: MIT; copyright (c) 2022 Bastian Andelefski.
- Scope consulted: minimal private class declarations and the create/apply/retain lifecycle.
- LanExtend relationship: the helper implementation, CLI, validation, dynamic probe, JSONL supervision, signal handling, and Quartz unmirror behavior are independently written.

The same provenance is recorded near the implementation in `native/macos/ATTRIBUTION.md`.

## Product research only; no code incorporated

The following repositories were evaluated for architecture/product decisions and are not dependencies:

| Project | Repository | License at research date (2026-08-10) |
| --- | --- | --- |
| OpenDisplay | <https://github.com/peetzweg/opendisplay> | GPL-3.0 on the then-current default branch; its README notes older v0.4.x-and-earlier releases were MIT |
| VoidDisplay | <https://github.com/iamsyc/VoidDisplay> | Apache-2.0 |
| node-mac-virtual-display | <https://github.com/enfp-dev-studio/node-mac-virtual-display> | MIT |
| DeskPad | <https://github.com/Stengo/DeskPad> | MIT |
| Deskreen CE | <https://github.com/pavlobu/deskreen> | AGPL-3.0 |
| Weylus | <https://github.com/H-M-H/Weylus> | AGPL-3.0-or-later; its LICENSE notes contributed work under 3-Clause BSD |
| Sunshine | <https://github.com/LizardByte/Sunshine> | GPL-3.0 |
| Lumen | <https://github.com/trollzem/Lumen> | GPL-3.0 |

See `docs/open-source-research.md` for the comparison and selection rationale. Before any future reuse, pin the exact upstream commit/file and perform a new license review; do not rely on this date-stamped summary.

## Apple private API notice

`CGVirtualDisplay`, `CGVirtualDisplayDescriptor`, `CGVirtualDisplayMode`, and `CGVirtualDisplaySettings` are Apple CoreGraphics runtime class names for an undocumented/private API. Apple does not provide a public compatibility contract for their use here. These names are not a bundled third-party library, and their mention does not imply Apple endorsement.

Because the product uses private API, the macOS build is not intended for Mac App Store distribution. That platform-policy limitation is separate from open-source licensing.

## Release maintainer checklist

- Compare `package.json` and `package-lock.json` with this file.
- Generate a production dependency/license report and manually review exceptions, dual licenses, native binaries and optional packages.
- Confirm the packaged Electron license files are present in every DMG/ZIP/EXE distribution.
- Preserve this file and the repository `LICENSE` in application packages.
- Review new copied assets, fonts, icons, snippets and generated code; npm dependency review alone is insufficient.
- Do not import GPL/AGPL research-project code without an explicit relicensing/distribution decision.
