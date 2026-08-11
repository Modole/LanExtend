# LanExtend macOS virtual-display helper

`lanextend-vdisplay` is a small Objective-C subprocess that creates and owns one
macOS virtual display. The parent process must keep it running for as long as the
display is needed; sending `SIGTERM` releases the display and exits cleanly.

## Build

The helper requires macOS, the Xcode Command Line Tools, and the macOS SDK:

```sh
npm run build:native
```

The binary is written to `native/macos/.build/lanextend-vdisplay`. To invoke the
compiler directly, run `/bin/sh native/macos/build.sh`. The build is universal2
(`arm64` + `x86_64`) so the same packaged helper runs on Apple Silicon and Intel
Macs supported by the application's macOS 14 minimum.

## Protocol

Standard output is JSON Lines (one compact JSON object per line). Diagnostic
usage text goes to standard error.

Check runtime availability without creating a display:

```sh
native/macos/.build/lanextend-vdisplay --probe
```

Create a display with defaults (`1920x1080@60`, non-HiDPI):

```sh
native/macos/.build/lanextend-vdisplay create
```

Create a named Retina display whose logical desktop is 1280x800 and whose
physical framebuffer is 2560x1600:

```sh
native/macos/.build/lanextend-vdisplay create \
  --width 1280 --height 800 --fps 60 \
  --name "LanExtend Windows Receiver" --serial 42 --hidpi
```

Boolean forms such as `--hidpi false`, `--hi-dpi true`, and `--no-hidpi` are
also accepted. Width and height always describe the logical desktop. HiDPI mode
uses a 2x physical framebuffer. `--serial` accepts `1..4294967295` and should be
stable for a remembered receiver; it defaults to `1`. On success the helper
emits a `ready` record containing the display ID, logical/pixel dimensions, and
serial, then remains alive. It emits `stopped` while handling a normal
signal-driven shutdown. Failures are emitted as `error` records and use a
non-zero exit status.

After the display comes online, the helper checks whether macOS placed it in a
mirror set. If necessary, it requests extended mode through the public Quartz
display-configuration API. A failed unmirror request is reported as a JSON
`warning` on standard error; the `ready.extended` field is then `false` so the
parent can surface the degraded state without losing the display process.

## Important compatibility note

`CGVirtualDisplay` is an undocumented, private CoreGraphics API. Apple may alter
or remove it without notice, App Store distribution is not appropriate, and a
future macOS release can require a helper update. The `--probe` command checks
the classes and selectors needed by this build at runtime so the GUI can disable
the feature gracefully. This helper does not disable SIP/AMFI and does not
require a kernel extension.

The implementation dynamically resolves all four Objective-C classes. This
avoids a hard class-symbol dependency on systems where the API is unavailable,
but it cannot make an incompatible private API safe. Keep the helper isolated as
a child process and treat unexpected exit as display removal.

See [ATTRIBUTION.md](ATTRIBUTION.md) for compatibility references and licensing
boundaries.
