#!/usr/bin/env python3
# De-duplicate LC_LOAD_DYLIB load commands in a thin 64-bit Mach-O by REPOINTING
# (not removing) the redundant entry to an equivalent path.
#
# Why: cross-linking macOS binaries with zig (cargo-zigbuild) can emit the same
# dylib twice — e.g. /usr/lib/libobjc.A.dylib once from the Rust objc crates and
# once from zig's own SDK linking. Modern macOS dyld treats a duplicate linked
# dylib as a FATAL error and SIGABRTs before main() runs, so the binary never
# starts (this is why the eframe splash spinner died instantly on macOS and the
# launcher fell back to the console line).
#
# Why repoint instead of delete: a binary uses a two-level namespace, so every
# imported symbol is bound to its source dylib by ORDINAL (the 1-based position of
# the load command). Deleting a load command renumbers every later dylib and
# silently rebinds symbols to the wrong library (_NSApp ends up "expected in
# CoreGraphics", etc.). Repointing keeps the command count — and thus all ordinals
# — identical. We change the duplicate's install-name string to a different path
# that resolves to the SAME library (libFoo.A.dylib -> libFoo.dylib, the standard
# macOS symlink), so dyld no longer sees a duplicate path while any symbol bound to
# that ordinal still resolves to the same code. The new name is the same length or
# shorter, so cmdsize is unchanged (we NUL-pad the field).
#
# The edit voids the code signature; the caller MUST re-sign afterwards (ad-hoc is
# fine: `rcodesign sign <path> <path>`). Thin 64-bit Mach-O only; no-op otherwise.

import re
import struct
import sys

MH_MAGIC_64 = 0xFEEDFACF
LC_LOAD_DYLIB = 0x0C
LC_LOAD_WEAK_DYLIB = 0x18
LC_REEXPORT_DYLIB = 0x1F
LC_LOAD_UPWARD_DYLIB = 0x23
DYLIB_LCS = (LC_LOAD_DYLIB, LC_LOAD_WEAK_DYLIB, LC_REEXPORT_DYLIB, LC_LOAD_UPWARD_DYLIB)

# Map a dylib install name to an equivalent alternate path (same library, different
# string) used to break a duplicate. The canonical macOS aliasing is the versioned
# name <stem>.A.dylib <-> the unversioned symlink <stem>.dylib.
_ALIAS_RE = re.compile(rb"^(.*)\.A\.dylib$")


def alias_for(name: bytes) -> bytes | None:
    m = _ALIAS_RE.match(name)
    if m:
        return m.group(1) + b".dylib"
    # Reverse direction as a fallback (unversioned -> add a redundant ./ prefix on
    # the leaf is risky, so only handle the well-formed versioned case).
    return None


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: macho-dedupe-dylibs.py <thin-macho>", file=sys.stderr)
        return 2
    path = sys.argv[1]
    with open(path, "rb") as f:
        data = bytearray(f.read())

    if len(data) < 32:
        print("not a mach-o (too small)", file=sys.stderr)
        return 2
    if struct.unpack_from("<I", data, 0)[0] == MH_MAGIC_64:
        en = "<"
    elif struct.unpack_from(">I", data, 0)[0] == MH_MAGIC_64:
        en = ">"
    else:
        print("not a thin 64-bit mach-o — skipping", file=sys.stderr)
        return 0

    ncmds, sizeofcmds = struct.unpack_from(en + "II", data, 16)
    hdr = 32
    off = hdr
    seen = set()
    repointed = 0
    for _ in range(ncmds):
        cmd, cmdsize = struct.unpack_from(en + "II", data, off)
        if cmdsize < 8 or off + cmdsize > hdr + sizeofcmds:
            print("malformed load command — skipping", file=sys.stderr)
            return 0
        if cmd in DYLIB_LCS:
            name_off = struct.unpack_from(en + "I", data, off + 8)[0]
            field_start = off + name_off
            field_len = cmdsize - name_off
            name = bytes(data[field_start : off + cmdsize]).split(b"\x00", 1)[0]
            if name in seen:
                alt = alias_for(name)
                if alt is None:
                    print(
                        f"WARNING: duplicate dylib {name.decode(errors='replace')} has no "
                        "equivalent alias — leaving as-is (dyld may abort)",
                        file=sys.stderr,
                    )
                elif len(alt) + 1 > field_len:
                    print(
                        f"WARNING: alias for {name.decode(errors='replace')} doesn't fit "
                        "the load command field — leaving as-is",
                        file=sys.stderr,
                    )
                else:
                    data[field_start : off + cmdsize] = alt + b"\x00" * (field_len - len(alt))
                    seen.add(alt)
                    repointed += 1
            else:
                seen.add(name)
        off += cmdsize

    if repointed == 0:
        print("no duplicate dylib load commands repointed")
        return 0

    with open(path, "wb") as f:
        f.write(data)
    print(f"repointed {repointed} duplicate dylib load command(s) in {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
