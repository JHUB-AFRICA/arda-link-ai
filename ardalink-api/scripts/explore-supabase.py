#!/usr/bin/env python3
"""
Supabase schema + data explorer for ArdaLink.

Strategy:
  1. Parse the PostgREST OpenAPI spec (already fetched to /tmp/supabase-openapi.json).
  2. For each table: enumerate columns + types from the definition.
  3. Hit the table with a count query (?select=count) via HEAD + Prefer: count=exact.
  4. Sample 3 rows (?limit=3).
  5. Detect RLS visibility: if we can read as anon vs service_role.
  6. Write a full structured report to /tmp/supabase-report.json and print a summary.
"""
import json
import os
import sys
import urllib.request
import urllib.parse
import urllib.error

BASE = os.environ.get("SUPABASE_URL", "").rstrip("/")
KEY = os.environ.get("SUPABASE_SECRET_KEY", "")
if not BASE or not KEY:
    print("SUPABASE_URL and SUPABASE_SECRET_KEY required", file=sys.stderr)
    sys.exit(2)

with open("/tmp/supabase-openapi.json") as f:
    SPEC = json.load(f)

HEADERS = {
    "apikey": KEY,
    "Authorization": f"Bearer {KEY}",
    "Accept": "application/json",
}


def get(path, extra_headers=None, timeout=15):
    url = f"{BASE}{path}"
    req = urllib.request.Request(url, headers={**HEADERS, **(extra_headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def table_defs():
    """Extract per-table column info from the OpenAPI definitions block."""
    out = {}
    for name, spec in SPEC.get("definitions", {}).items():
        props = spec.get("properties", {})
        cols = []
        for col, info in props.items():
            cols.append(
                {
                    "name": col,
                    "type": info.get("type"),
                    "format": info.get("format"),
                    "description": info.get("description"),
                    "default": info.get("default"),
                    "nullable": "null" in (info.get("type") or ""),
                }
            )
        out[name] = {
            "columns": cols,
            "required": spec.get("required", []),
            "description": spec.get("description"),
        }
    return out


def table_row_count(name):
    """Get exact row count via HEAD + Prefer: count=exact."""
    encoded = urllib.parse.quote(name, safe="")
    req = urllib.request.Request(
        f"{BASE}/rest/v1/{encoded}?select=count",
        headers={**HEADERS, "Prefer": "count=exact"},
        method="HEAD",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            cr = resp.headers.get("Content-Range", "")
            if "/" in cr:
                return int(cr.split("/")[-1])
    except urllib.error.HTTPError as e:
        return f"ERR {e.code}"
    except Exception as e:
        return f"ERR {e}"
    return None


def sample_rows(name, limit=3):
    encoded = urllib.parse.quote(name, safe="")
    status, _, body = get(f"/rest/v1/{encoded}?select=*&limit={limit}")
    if status != 200:
        return {"error": f"HTTP {status}", "body": body[:200].decode(errors="replace")}
    try:
        return json.loads(body)
    except Exception:
        return {"error": "non-json"}


def main():
    print(f"→ Base: {BASE}")
    print(f"→ Key:  {KEY[:20]}…")
    print()

    defs = table_defs()
    tables = sorted(defs.keys())
    report = {"base": BASE, "tables": {}}

    print(f"═══ {len(tables)} tables in exposed schema ═══\n")
    for t in tables:
        cols = defs[t]["columns"]
        count = table_row_count(t)
        sample = sample_rows(t, limit=3) if isinstance(count, int) and count > 0 else []
        report["tables"][t] = {
            "columns": cols,
            "row_count": count,
            "sample": sample if not isinstance(sample, dict) or "error" not in sample else [],
            "sample_error": sample.get("error") if isinstance(sample, dict) else None,
        }
        # Print a one-line summary
        col_summary = ", ".join(
            f"{c['name']}:{c['format'] or c['type']}" for c in cols[:6]
        )
        if len(cols) > 6:
            col_summary += f", …+{len(cols) - 6} more"
        print(f"● {t}  ({count} rows)")
        print(f"   {col_summary}")
        if isinstance(sample, list) and sample:
            first = sample[0]
            # Print first row keys briefly
            keys = list(first.keys())[:5]
            print(f"   sample keys: {keys}{'…' if len(first) > 5 else ''}")
        elif isinstance(sample, dict) and sample.get("error"):
            print(f"   sample error: {sample['error']}")
        print()

    with open("/tmp/supabase-report.json", "w") as f:
        json.dump(report, f, indent=2, default=str)
    print(f"→ Full report: /tmp/supabase-report.json ({os.path.getsize('/tmp/supabase-report.json')} bytes)")


if __name__ == "__main__":
    main()
