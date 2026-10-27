#!/usr/bin/env python3
"""
list_couriers.py - list every courier TrackingMore supports, with courier codes.

Calls GET https://api.trackingmore.com/v4/couriers/all (header Tracking-Api-Key)
and prints name + code. This is the authoritative answer to "what couriers does
TrackingMore cover?" - the live list is ~1,700 carriers.

Needs a TrackingMore API key: --key, --key-file, the TRACKINGMORE_API_KEY
environment variable, or config.json.

Usage
-----
    python list_couriers.py                      # everything
    python list_couriers.py --search india       # only couriers matching "india"
    python list_couriers.py --search delhivery   # filter by name or code
    python list_couriers.py --csv couriers.csv   # also save a CSV

Exit codes: 0 ok, 1 rejected/unexpected, 2 no key, 3 network error.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from pathlib import Path

import requests

BASE = "https://api.trackingmore.com/v4"


def load_key(args) -> str:
    if getattr(args, "key", None):
        return args.key.strip()
    if getattr(args, "key_file", None):
        try:
            d = json.loads(Path(args.key_file).read_text(encoding="utf-8"))
        except Exception as e:
            print(f"Could not read key file: {e}", file=sys.stderr)
            return ""
        if isinstance(d, dict):
            for k in ("Tracking-Api-Key", "tracking_api_key", "api_key", "key"):
                if k in d and d[k]:
                    return str(d[k]).strip()
            if len(d) == 1:
                return str(next(iter(d.values()))).strip()
        elif isinstance(d, str):
            return d.strip()
    env = os.environ.get("TRACKINGMORE_API_KEY")
    if env:
        return env.strip()
    cfgp = Path("config.json")
    if cfgp.exists():
        try:
            cfg = json.loads(cfgp.read_text(encoding="utf-8"))
            tok = ((cfg.get("providers") or {}).get("trackingmore") or {}).get("api_key")
            if tok:
                return str(tok).strip()
        except Exception:
            pass
    return ""


def main() -> int:
    ap = argparse.ArgumentParser(description="List couriers supported by TrackingMore.")
    ap.add_argument("--key", help="the API key")
    ap.add_argument("--key-file", help="a JSON file containing the key")
    ap.add_argument("--search", default="", help="filter by courier name or code")
    ap.add_argument("--csv", default="", help="write the results to this CSV file")
    args = ap.parse_args()

    key = load_key(args)
    if not key:
        print("No key found. Pass --key / --key-file, set TRACKINGMORE_API_KEY, "
              "or put it in config.json under providers.trackingmore.api_key.",
              file=sys.stderr)
        return 2

    headers = {"Tracking-Api-Key": key, "Content-Type": "application/json"}
    try:
        r = requests.get(f"{BASE}/couriers/all", headers=headers, timeout=30)
    except Exception as e:
        print(f"Network error: {type(e).__name__}: {str(e)[:160]}", file=sys.stderr)
        return 3

    if r.status_code in (401, 403):
        msg = ""
        try:
            msg = r.json().get("message", "")
        except Exception:
            msg = r.text[:150]
        print(f"Key REJECTED: {msg}", file=sys.stderr)
        return 1
    if r.status_code != 200:
        print(f"Unexpected response: HTTP {r.status_code} {r.text[:200]}", file=sys.stderr)
        return 1

    data = (r.json() or {}).get("data") or []
    rows = []
    for c in data:
        rows.append({
            "name": c.get("courier_name") or c.get("name") or "",
            "code": c.get("courier_code") or c.get("code") or "",
            "country": c.get("country") or "",
            "type": c.get("type") or "",
        })

    q = args.search.lower().strip()
    if q:
        rows = [x for x in rows if q in x["name"].lower() or q in x["code"].lower()]

    rows.sort(key=lambda y: y["name"].lower())
    label = f" matching '{args.search}'" if q else ""
    print(f"{len(rows)} courier(s){label}:\n")
    for x in rows:
        extra = " / ".join(v for v in (x["country"], x["type"]) if v)
        print(f"  {x['name'][:34]:<34} {x['code'][:26]:<26} {extra}")

    if args.csv:
        with open(args.csv, "w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=["name", "code", "country", "type"])
            w.writeheader()
            w.writerows(rows)
        print(f"\nWrote {args.csv}", file=sys.stderr)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
