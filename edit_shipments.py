#!/usr/bin/env python3
"""
edit_shipments.py - bulk-update Delhivery shipments via the Edit Order API.

Updates package details AFTER manifestation against a list of waybills:
payment mode (pt), COD amount (cod), weight (gm), dimensions, and consignee
details. This is Delhivery's   POST /api/p/edit   endpoint.

It does NOT track parcels - use track_parcels.py for that.

Allowed only while the parcel is Manifested / In Transit / Pending / Scheduled.
Rejected once Delivered, Dispatched, RTO, DTO, Picked Up or Collected.

Credentials are NEVER hardcoded. Provide the token via config.json
(providers.delhivery.token) or the DELHIVERY_TOKEN environment variable.

Usage
-----
    # 1) dry run - prints exactly what would be sent, makes NO network call
    python edit_shipments.py -i shipments_to_edit.csv --dry-run

    # 2) real run against staging (test)
    python edit_shipments.py -i shipments_to_edit.csv -o edit_results.csv --env staging

    # 3) real run against production
    python edit_shipments.py -i shipments_to_edit.csv -o edit_results.csv --env production

Input CSV (header row; only 'waybill' is required - blank cells are skipped):
    waybill, pt, cod, gm, shipment_length, shipment_width, shipment_height, name, add, phone, product_details

Accepted aliases: payment_mode->pt, cod_amount->cod, weight->gm, address->add,
consignee_name->name, consignee_phone->phone, products_desc->product_details
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import pandas as pd
import requests

TIMEOUT = 25  # seconds

BASES = {
    "staging": "https://staging-express.delhivery.com",
    "production": "https://track.delhivery.com",
    "live": "https://track.delhivery.com",
}

# CSV header (lower-cased) -> Delhivery API field
FIELD_ALIASES = {
    "waybill": "waybill",
    "pt": "pt", "payment_mode": "pt", "paymentmode": "pt",
    "cod": "cod", "cod_amount": "cod", "codamount": "cod",
    "gm": "gm", "weight": "gm", "wt": "gm",
    "shipment_length": "shipment_length", "length": "shipment_length",
    "shipment_width": "shipment_width", "width": "shipment_width",
    "shipment_height": "shipment_height", "height": "shipment_height",
    "name": "name", "consignee_name": "name",
    "add": "add", "address": "add", "consignee_address": "add",
    "phone": "phone", "consignee_phone": "phone",
    "product_details": "product_details", "products_desc": "product_details",
}
NUMERIC = {"cod", "gm", "shipment_length", "shipment_width", "shipment_height"}
VALID_PT = {"cod", "pre-paid", "prepaid", "pre paid"}


def load_token(config_path: str | None) -> str:
    if config_path and Path(config_path).exists():
        try:
            cfg = json.loads(Path(config_path).read_text(encoding="utf-8"))
            tok = ((cfg.get("providers") or {}).get("delhivery") or {}).get("token")
            if tok:
                return str(tok).strip()
        except Exception:
            pass
    return os.environ.get("DELHIVERY_TOKEN", "").strip()


def normalise(row: dict) -> dict:
    out: dict = {}
    for k, v in row.items():
        key = FIELD_ALIASES.get(str(k).strip().lower())
        if not key or v is None:
            continue
        s = str(v).strip()
        if s == "" or s.lower() in ("nan", "none"):
            continue
        if key in NUMERIC:
            try:
                f = float(s)
                out[key] = int(f) if f.is_integer() else f
            except ValueError:
                out[key] = s
        else:
            out[key] = s
    return out


def parse_response(http_status: int, body: str) -> tuple[bool, str]:
    """Return (success, message) from a Delhivery edit response, defensively."""
    try:
        j = json.loads(body)
    except Exception:
        return (200 <= http_status < 300, body[:200])
    if isinstance(j, dict):
        if "success" in j:
            ok = bool(j.get("success"))
            msg = j.get("error") or j.get("message") or j.get("rmk") or ("OK" if ok else "")
            return ok, str(msg)[:300]
        if "error" in j and j["error"]:
            return False, str(j["error"])[:300]
        if "status" in j:
            st = str(j["status"])
            return st.lower() in ("success", "ok", "true"), st[:300]
    return (200 <= http_status < 300), str(j)[:200]


def run(input_path: str, output_path: str, env: str, config_path: str | None,
        dry_run: bool) -> int:
    base = BASES.get(env.lower())
    if not base:
        print(f"[error] unknown env '{env}'. Use staging or production.", file=sys.stderr)
        return 2

    if not Path(input_path).exists():
        print(f"[error] input file not found: {input_path}", file=sys.stderr)
        return 2

    df = pd.read_csv(input_path, dtype=str).fillna("")
    rows = df.to_dict(orient="records")
    if not rows:
        print("[error] input CSV has no data rows.", file=sys.stderr)
        return 2

    token = load_token(config_path)
    if not dry_run and not token:
        print("[error] no Delhivery token. Set providers.delhivery.token in config.json "
              "or the DELHIVERY_TOKEN environment variable.", file=sys.stderr)
        return 3

    url = f"{base}/api/p/edit"
    headers = {
        "Authorization": f"Token {token}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }

    results = []
    ok_count = err_count = 0
    print(f"{'[dry-run] ' if dry_run else ''}POST {url}  ({len(rows)} row(s), env={env})",
          file=sys.stderr)

    for i, raw in enumerate(rows, 1):
        body = normalise(raw)
        wb = body.get("waybill", "")
        if not wb:
            results.append({"row": i, "waybill": "", "http_status": "",
                            "success": False, "message": "missing waybill"})
            err_count += 1
            continue
        # Only send the waybill plus the fields actually provided.
        payload = {k: v for k, v in body.items()}
        pt = str(payload.get("pt", "")).lower()
        if pt and pt not in VALID_PT:
            print(f"[warn] row {i} ({wb}): pt='{payload['pt']}' - Delhivery expects "
                  f"'COD' or 'Pre-paid'.", file=sys.stderr)

        if dry_run:
            results.append({"row": i, "waybill": wb, "http_status": "(dry-run)",
                            "success": True, "message": "not sent",
                            "payload": json.dumps(payload, ensure_ascii=False)})
            ok_count += 1
            continue

        try:
            r = requests.post(url, headers=headers, data=json.dumps(payload), timeout=TIMEOUT)
            ok, msg = parse_response(r.status_code, r.text)
            results.append({"row": i, "waybill": wb, "http_status": r.status_code,
                            "success": ok, "message": msg,
                            "payload": json.dumps(payload, ensure_ascii=False)})
            ok_count += 1 if ok else 0
            err_count += 0 if ok else 1
        except Exception as exc:
            results.append({"row": i, "waybill": wb, "http_status": "",
                            "success": False, "message": str(exc)[:300],
                            "payload": json.dumps(payload, ensure_ascii=False)})
            err_count += 1

    out_df = pd.DataFrame(results)
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    out_df.to_csv(output_path, index=False)
    print(f"\nSummary: {len(rows)} row(s) | ok: {ok_count} | errors: {err_count}", file=sys.stderr)
    print(f"Wrote {output_path}", file=sys.stderr)
    if dry_run:
        print("Dry run only - nothing was sent to Delhivery.", file=sys.stderr)
    return 0 if err_count == 0 else 1


def main() -> int:
    ap = argparse.ArgumentParser(description="Bulk-edit Delhivery shipments (Edit Order API).")
    ap.add_argument("-i", "--input", default="shipments_to_edit.csv", help="input CSV")
    ap.add_argument("-o", "--output", default="edit_results.csv", help="results CSV")
    ap.add_argument("--env", default="staging", choices=["staging", "production", "live"],
                    help="Delhivery environment (default: staging)")
    ap.add_argument("-c", "--config", default="config.json", help="config file with the token")
    ap.add_argument("--dry-run", action="store_true",
                    help="show what would be sent without calling the API")
    args = ap.parse_args()
    return run(args.input, args.output, args.env, args.config, args.dry_run)


if __name__ == "__main__":
    raise SystemExit(main())
