#!/usr/bin/env python3
"""把 data/notes/*.md 合併成前端讀取的 data/library.json 與變更偵測用的 data/manifest.json。"""
import json, re, sys, datetime, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
NOTES = ROOT / "data" / "notes"
REQUIRED = ("id", "title", "category")


def parse_front(text, name):
    m = re.match(r"^---\n(.*?)\n---\n(.*)$", text, re.S)
    if not m:
        raise ValueError(f"{name}: 缺少 frontmatter")
    meta = {}
    for line in m.group(1).splitlines():
        if not line.strip() or ":" not in line:
            continue
        k, v = line.split(":", 1)
        v = v.strip()
        if v.startswith("[") and v.endswith("]"):
            v = [x.strip().strip("'\"") for x in v[1:-1].split(",") if x.strip()]
        else:
            v = v.strip("'\"")
        meta[k.strip()] = v
    for k in REQUIRED:
        if not meta.get(k):
            raise ValueError(f"{name}: frontmatter 缺少 {k}")
    return meta, m.group(2).strip() + "\n"


def main():
    docs, errors = [], []
    for f in sorted(NOTES.glob("*.md")):
        try:
            meta, body = parse_front(f.read_text(encoding="utf-8"), f.name)
        except ValueError as e:
            errors.append(str(e))
            continue
        # 基本檢查：顏色標記要成對
        if body.count("{{") != body.count("}}"):
            errors.append(f"{f.name}: 顏色標記 {{{{ }}}} 數量不成對")
        docs.append({**meta, "tags": meta.get("tags") or [], "file": f.name, "body": body})
    if errors:
        print("\n".join(errors), file=sys.stderr)
        sys.exit(1)
    ids = [d["id"] for d in docs]
    dup = {i for i in ids if ids.count(i) > 1}
    if dup:
        sys.exit(f"重複的 id：{dup}")
    now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).isoformat(timespec="minutes")
    (ROOT / "data" / "library.json").write_text(
        json.dumps({"generated": now, "docs": docs}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    manifest = {d["id"]: {"title": d["title"], "source": d.get("source", ""), "drive_modified": d.get("drive_modified", ""),
                          "file": d["file"]} for d in docs}
    (ROOT / "data" / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"OK：{len(docs)} 份講義 → data/library.json")


if __name__ == "__main__":
    main()
