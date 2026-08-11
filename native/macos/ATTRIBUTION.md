# Attribution and clean-room notes

The implementation in this directory is original LanExtend code under the
repository's MIT license. No third-party implementation was copied into it.

The following upstream material was consulted to confirm private Objective-C
class names, selector signatures, and known compatibility constraints:

- Chromium, `ui/display/mac/test/virtual_display_util_mac.mm`
  (<https://chromium.googlesource.com/chromium/src/+/HEAD/ui/display/mac/test/virtual_display_util_mac.mm>),
  Copyright The Chromium Authors, BSD-style license. Chromium's generated
  interface declarations and its notes about non-zero vendor IDs and unique
  serial numbers on modern macOS were used as API/compatibility references.
- DeskPad, `DeskPad/CGVirtualDisplayPrivate.h`
  (<https://github.com/Stengo/DeskPad/blob/main/DeskPad/CGVirtualDisplayPrivate.h>),
  Copyright (c) 2022 Bastian Andelefski, MIT license. Its minimal private class
  declarations and create/apply/retain lifecycle were used as an API behavior
  reference. LanExtend's helper implementation, CLI, validation, dynamic probe,
  JSONL supervision protocol, signal handling, and Quartz unmirror step are
  independently written.

`CGVirtualDisplay`, `CGVirtualDisplayDescriptor`, `CGVirtualDisplayMode`, and
`CGVirtualDisplaySettings` are Apple CoreGraphics runtime class names. Their
presence here does not imply endorsement by Apple, and Apple provides no public
compatibility contract for them.
