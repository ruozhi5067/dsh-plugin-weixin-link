"""Minimal Electron ASAR reader (Python stdlib only).

Usage:
  python asar.py <archive.asar> list [needle] [outfile]
  python asar.py <archive.asar> extract <prefix> <outDir>
"""
import json
import os
import struct
import sys


def load(path):
    with open(path, "rb") as handle:
        blob = handle.read()
    marker = blob.find(b'{"files":')
    if marker < 0:
        raise SystemExit("asar header marker not found")
    text = blob[marker:].decode("utf-8", errors="surrogateescape")
    header, length = json.JSONDecoder().raw_decode(text)
    end = marker + length
    # Header string is padded so file data starts on a 4-byte boundary.
    for pad in range(0, 5):
        base = end + pad
        if test_base(blob, base, header):
            return blob, header, base
    raise SystemExit("could not locate asar data offset")


def first_file(header):
    for name, entry in (header.get("files") or {}).items():
        if entry.get("files") is None:
            return name, entry
        found = first_file(entry)
        if found:
            return found
    return None


def test_base(blob, base, header):
    found = first_file(header)
    if not found:
        return False
    _name, entry = found
    if entry.get("unpacked"):
        return True
    offset = int(entry.get("offset", 0))
    size = entry.get("size", 0)
    head = blob[base + offset:base + offset + min(size, 64)]
    return head[:1] in (b"{", b"[", b"/", b"#", b"i", b"e", b"c", b"m", b"v", b"<", b"\n", b'"') or b"\x00" not in head


def walk(node, prefix, out):
    for name, entry in (node.get("files") or {}).items():
        path = f"{prefix}/{name}" if prefix else name
        if entry.get("files") is not None:
            walk(entry, path, out)
        else:
            out.append((path, entry.get("size", 0), int(entry.get("offset", 0)), bool(entry.get("unpacked"))))


def main():
    archive, command = sys.argv[1], sys.argv[2]
    blob, header, base = load(archive)
    files = []
    walk(header, "", files)
    if command == "list":
        needle = sys.argv[3] if len(sys.argv) > 3 else ""
        outfile = sys.argv[4] if len(sys.argv) > 4 else ""
        hits = [f for f in files if needle in f[0]] if needle else files
        lines = [f"{size}\t{path}" + ("\t[unpacked]" if unpacked else "") for path, size, _off, unpacked in hits]
        if outfile:
            with open(outfile, "w", encoding="utf-8") as handle:
                handle.write("\n".join(lines))
        else:
            sys.stdout.write("\n".join(lines[:2000]))
        print(f"total={len(files)} matched={len(hits)}", file=sys.stderr)
    elif command == "extract":
        prefix = sys.argv[3].replace("\\", "/").rstrip("/")
        out_dir = os.path.abspath(sys.argv[4])
        hits = [f for f in files if f[0] == prefix or f[0].startswith(prefix + "/")]
        if not hits:
            print("no match", file=sys.stderr)
            return 2
        written = 0
        for path, size, offset, unpacked in hits:
            rel = path[len(prefix):].lstrip("/") or path.split("/")[-1]
            dest = os.path.join(out_dir, rel.replace("/", os.sep))
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            if unpacked:
                continue
            with open(dest, "wb") as handle:
                handle.write(blob[base + offset:base + offset + size])
            written += 1
        print(f"extracted {written} files -> {out_dir}", file=sys.stderr)
    else:
        print("usage: asar.py <archive> list [needle] [outfile] | extract <prefix> <outDir>", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
