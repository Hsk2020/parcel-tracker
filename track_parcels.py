#!/usr/bin/env python3
"""
track_parcels.py - pull live tracking status for a list of parcels.

Reads a CSV of parcels, queries one or more courier/aggregator APIs through
the adapters in adapters.py, and writes an enriched CSV (or Excel) with the
current status, last location, last update, delivered flag and a tracking URL.

Quick start
-----------
    # 1) see it work with no credentials at all
    python track_parcels.py --demo

    # 2) real run, picking a provider
    python track_parcels.py -i parcels.csv -o tracked.csv --provider shiprocket

    # 3) mixed couriers: put a 'provider' column in the CSV and omit --provider
    python track_parcels.py -i parcels.csv -o tracked.xlsx

Credentials come from config.json and/or environment variables. Nothing is
hardcoded. See README.md.

Input CSV columns (case-insensitive, extra columns are preserved):
    tracking_number   (required)  the AWB / consignment / waybill number
    provider          (optional)  per-row override of the provider
    courier           (optional)  courier name, used by the 'manual' provider
    order_id          (optional)  your own reference, carried through
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path

import pandas as pd

from adapters import ADAPTERS, get_adapter

# --------------------------------------------------------------------------- #
# Config: file + environment variables (env wins). No secrets in code.
# --------------------------------------------------------------------------- #
ENV_MAP = {
    ("delhivery", "token"): "DELHIVERY_TOKEN",
    ("delhivery", "client_name"): "DELHIVERY_CLIENT_NAME",
    ("delhivery", "env"): "DELHIVERY_ENV",
    ("shiprocket", "email"): "SHIPROCKET_EMAIL",
    ("shiprocket", "password"): "SHIPROCKET_PASSWORD",
    ("ship24", "api_key"): "SHIP24_API_KEY",
    ("trackingmore", "api_key"): "TRACKINGMORE_API_KEY",
    ("trackingmore", "courier_code"): "TRACKINGMORE_COURIER_CODE",
    ("shadowfax", "token"): "SHADOWFAX_TOKEN",
    ("shadowfax", "env"): "SHADOWFAX_ENV",
}

DEFAULT_CONFIG = {
    "default_provider": "shiprocket",
    "providers": {
        "delhivery": {"token": "", "client_name": "", "env": "production"},
        "shiprocket": {"email": "", "password": ""},
        "ship24": {"api_key": ""},
        "trackingmore": {"api_key": "", "courier_code": ""},
        "shadowfax": {"token": "", "env": "staging"},
        "manual": {},
    },
}


def load_config(path: str | None) -> dict:
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))  # deep copy
    if path and Path(path).exists():
        with open(path, "r", encoding="utf-8") as fh:
            user = json.load(fh)
        cfg["default_provider"] = user.get("default_provider", cfg["default_provider"])
        for name, vals in (user.get("providers") or {}).items():
            cfg["providers"].setdefault(name, {}).update(vals or {})
    # environment overrides
    for (provider, key), env in ENV_MAP.items():
        val = os.environ.get(env)
        if val:
            cfg["providers"].setdefault(provider, {})[key] = val
    return cfg


# --------------------------------------------------------------------------- #
# Core run
# --------------------------------------------------------------------------- #
def find_column(df: pd.DataFrame, *candidates: str) -> str | None:
    lower = {c.lower().strip(): c for c in df.columns}
    for cand in candidates:
        if cand in lower:
            return lower[cand]
    return None


def run(input_path: str, output_path: str, provider: str | None,
        config_path: str | None, demo: bool, out_format: str) -> int:
    cfg = load_config(config_path)

    if demo:
        provider = "demo"

    # ---- read input ----
    if input_path and Path(input_path).exists():
        df = pd.read_csv(input_path, dtype=str).fillna("")
    else:
        if input_path:
            print(f"[warn] input '{input_path}' not found - using built-in sample.", file=sys.stderr)
        df = pd.DataFrame({"tracking_number": [
            "DEMO123456789", "DEMO987654321", "DEMO555000111", "DEMO222333444"],
            "courier": ["delhivery", "dtdc", "bluedart", "indiapost"],
            "order_id": ["ORD-1001", "ORD-1002", "ORD-1003", "ORD-1004"]})

    tn_col = find_column(df, "tracking_number", "awb", "waybill", "consignment", "tracking_id")
    if not tn_col:
        print("[error] input needs a 'tracking_number' column (aliases: awb, waybill, "
              "consignment, tracking_id).", file=sys.stderr)
        return 2
    prov_col = find_column(df, "provider")
    cour_col = find_column(df, "courier")

    default_provider = provider or cfg.get("default_provider") or "shiprocket"

    # ---- group rows by provider so batch-capable adapters can batch ----
    rows = df.to_dict(orient="records")
    by_provider: dict[str, list[dict]] = {}
    for row in rows:
        p = ((row.get(prov_col, "") if prov_col else "") or default_provider).lower().strip()
        # The 'manual' provider is per-courier (each courier has its own URL),
        # so key it by courier too.
        key = p
        if p == "manual" and cour_col:
            key = f"manual|{(row.get(cour_col, '') or '').lower().strip()}"
        by_provider.setdefault(key, []).append(row)

    results: dict[tuple[int, str], object] = {}  # (row_index, tn) -> TrackingResult
    adapter_cache: dict[str, object] = {}
    setup_failed = False

    for key, group in by_provider.items():
        pname = key.split("|", 1)[0]
        pconf = dict(cfg["providers"].get(pname, {}))
        if pname == "manual" and "|" in key:
            pconf["courier"] = key.split("|", 1)[1]
        try:
            if key not in adapter_cache:
                adapter_cache[key] = get_adapter(pname, pconf)
            adapter = adapter_cache[key]
        except Exception as exc:
            setup_failed = True
            print(f"[error] provider '{pname}': {exc}", file=sys.stderr)
            for row in group:
                tn = row[tn_col]
                from adapters import TrackingResult
                results[(id(row), tn)] = TrackingResult(
                    tracking_number=tn, provider=pname, error=str(exc))
            continue

        tns = [row[tn_col] for row in group if row[tn_col]]
        try:
            got = adapter.track_many(tns)
        except Exception as exc:  # whole-provider failure
            from adapters import TrackingResult
            got = {tn: TrackingResult(tracking_number=tn, provider=pname, error=str(exc))
                   for tn in tns}
        for row in group:
            tn = row[tn_col]
            res = got.get(tn)
            if res is None:
                from adapters import TrackingResult
                res = TrackingResult(tracking_number=tn, provider=pname, error="not tracked")
            results[(id(row), tn)] = res
        print(f"[ok] {pname}: {len(tns)} parcel(s) queried", file=sys.stderr)

    if setup_failed and all(r.error for r in results.values() if r is not None):
        print("[error] no provider could run - check credentials in config.json "
              "or environment variables (see README.md).", file=sys.stderr)
        return 3

    # ---- merge back, preserving input order and extra columns ----
    out_rows = []
    for row in rows:
        tn = row[tn_col]
        res = results.get((id(row), tn))
        merged = dict(row)
        if res is not None:
            merged.update(res.to_row())
        out_rows.append(merged)
    out_df = pd.DataFrame(out_rows)

    # ---- summary ----
    total = len(out_df)
    delivered = int((out_df.get("delivered", "") == "YES").sum())
    errored = int((out_df.get("error", "").astype(str).str.len() > 0).sum())
    print(f"\nSummary: {total} parcel(s) | delivered: {delivered} | "
          f"in progress: {total - delivered - errored} | errors: {errored}", file=sys.stderr)

    # ---- write ----
    out_path = Path(output_path)
    fmt = out_format.lower()
    if fmt == "auto":
        if out_path.suffix.lower() in (".xlsx", ".xls"):
            fmt = "xlsx"
        elif out_path.suffix.lower() == ".json":
            fmt = "json"
        else:
            fmt = "csv"
    if fmt == "xlsx":
        out_path = out_path.with_suffix(".xlsx")
        out_df.to_excel(out_path, index=False, engine="openpyxl")
    elif fmt == "json":
        # JSON is what the tracking web page reads. It includes the full event
        # timeline for each parcel, which the flat CSV/Excel view drops.
        payload = {
            "generated_at": datetime.now().isoformat(timespec="seconds"),
            "parcels": [],
        }
        for row in rows:
            tn = row[tn_col]
            res = results.get((id(row), tn))
            entry = dict(row)
            if res is not None:
                entry.update(res.to_row())
                entry["events"] = res.events
            payload["parcels"].append(entry)
        out_path = out_path.with_suffix(".json")
        with open(out_path, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2, ensure_ascii=False)
    else:
        out_path = out_path.with_suffix(".csv")
        out_df.to_csv(out_path, index=False)
    print(f"Wrote {out_path}", file=sys.stderr)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Track parcels via courier/aggregator APIs.")
    ap.add_argument("-i", "--input", default="parcels.csv",
                    help="input CSV (default: parcels.csv, falls back to built-in sample)")
    ap.add_argument("-o", "--output", default="tracked.csv",
                    help="output file (default: tracked.csv)")
    ap.add_argument("-p", "--provider", default=None,
                    help=f"provider for all rows: {', '.join(sorted(ADAPTERS))}")
    ap.add_argument("-c", "--config", default="config.json",
                    help="config file with credentials (default: config.json)")
    ap.add_argument("--demo", action="store_true",
                    help="run offline with fake data (no credentials needed)")
    ap.add_argument("-f", "--format", default="auto", choices=["auto", "csv", "xlsx", "json"],
                    help="output format (default: auto from the -o extension). "
                         "Use json to feed the tracking web page.")
    args = ap.parse_args()
    return run(args.input, args.output, args.provider, args.config, args.demo, args.format)


if __name__ == "__main__":
    raise SystemExit(main())
