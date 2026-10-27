#!/usr/bin/env python3
"""
verify_key.py - check that a TrackingMore API key works, without tracking
anything or spending credits.

It calls the account-info endpoint (GET /v4/trackings/getuserinfo) with the
v4 header Tracking-Api-Key and tells you plainly whether the key is valid.

Usage
-----
    python verify_key.py --key-file Tracking-Api-Key-2.json
    python verify_key.py --key <your-key>
    TRACKINGMORE_API_KEY=... python verify_key.py
    python verify_key.py                 # reads config.json

Exit codes: 0 valid, 1 rejected/unexpected, 2 no key found, 3 network error.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import requests

BASE = "https://api.trackingmore.com/v4"


def mask(k: str) -> str:
    return (k[:4] + "\u2026" + k[-4:]) if len(k) > 10 else "\u2026"


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
    ap = argparse.ArgumentParser(description="Verify a TrackingMore API key.")
    ap.add_argument("--key", help="the API key itself")
    ap.add_argument("--key-file", help="a JSON file containing the key")
    args = ap.parse_args()

    key = load_key(args)
    if not key:
        print("No key found. Pass --key, --key-file, set TRACKINGMORE_API_KEY, "
              "or put it in config.json under providers.trackingmore.api_key.",
              file=sys.stderr)
        return 2

    print(f"Using key {mask(key)} ({len(key)} chars)")
    headers = {"Tracking-Api-Key": key, "Content-Type": "application/json"}

    try:
        r = requests.get(f"{BASE}/trackings/getuserinfo", headers=headers, timeout=20)
    except Exception as e:
        print(f"Network error: {type(e).__name__}: {str(e)[:160]}", file=sys.stderr)
        print("(If you are behind a proxy/firewall, make sure api.trackingmore.com is reachable.)",
              file=sys.stderr)
        return 3

    print("HTTP", r.status_code)
    try:
        body = r.json()
    except Exception:
        body = {}

    if r.status_code == 200:
        data = body.get("data") if isinstance(body, dict) else None
        if isinstance(data, dict):
            for k in ("email", "name", "username", "plan", "credits", "balance"):
                if k in data:
                    print(f"  {k}: {data[k]}")
        print("Key looks VALID.")
        return 0

    if r.status_code in (401, 403):
        msg = (body.get("message") if isinstance(body, dict) else None) or r.text[:150]
        print(f"Key REJECTED: {msg}")
        return 1

    print("Unexpected response:", r.text[:200])
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
