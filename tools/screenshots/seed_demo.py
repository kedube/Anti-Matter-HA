#!/usr/bin/env python3
"""Anti-Matter screenshot demo data: write the committed fake demo vault into a STORAGE_DIR.

Every pairing code in demo/ is FAKE: made-up passcodes, setup IDs, DSKs and install codes.
None of them belongs to a real device. Vendor and product names are ordinary catalogue names
so the Matter DCL and Z-Wave lookups have something plausible to show.

Usage
  python3 seed_demo.py STORAGE_DIR [--locale en|nl] [--ha-out FILE]
      Writes anti_matter.json, anti-matter-bin.json and backup_settings.json into STORAGE_DIR
      (created if missing; existing files are overwritten, so only point it at a throwaway
      directory). Timestamps are shifted so the newest entry is a few hours old.
      --locale nl translates names, areas, notes and categories with demo/nl.json.
      --ha-out writes the mock Home Assistant devices/areas (same locale) as JSON.

  python3 seed_demo.py --rebuild
      Regenerates demo/demo-vault.json and demo/demo-bin.json from the definitions below,
      encoding the payloads with the add-on's own Matter / HomeKit encoders. Only needed
      when you change the demo set. Stdlib only (plus the add-on's payload modules).
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEMO = HERE / "demo"
APP = HERE.parent.parent / "anti_matter" / "app"
NS = uuid.UUID("5d0c1b3e-9a7f-4c2e-8b61-2f4a6d8e0c13")  # namespace for stable demo ids


def did(key: str) -> str:
    return str(uuid.uuid5(NS, key))


def ha_id(name: str) -> str:
    """Fake 32-hex Home Assistant device id (stable per English name)."""
    return hashlib.md5(("demo-ha:" + name).encode()).hexdigest()


# ----------------------------------------------------------------------------- definitions
CATEGORIES = [
    # key, name, colour, MDI icon, sort
    ("lights", "Lights", "#F59E0B", "lightbulb", 0),
    ("sensors", "Sensors", "#10B981", "thermometer", 1),
    ("security", "Security", "#EF4444", "lock", 2),
    ("climate", "Climate", "#3B82F6", "hvac", 3),
    ("plugs", "Plugs & Switches", "#8B5CF6", "power-plug", 4),
    ("spares", "Spares", "#64748B", "package-variant-closed", 5),
]
TRASHED_CATEGORIES = [("holiday", "Holiday lights", "#E11D48", "string-lights", 6, 4)]  # + days ago

# Matter: (pin, discriminator, vid, pid). HomeKit: (8-digit code, setup id, category).
CODES = [
    dict(key="lamp", days=168, name="Living room floor lamp", kind="matter", m=(69414998, 2417, 0x117C, 0x9010),
         device_vendor="IKEA of Sweden", device_product="VARMBLIXT", device_type="light", area="Living Room",
         cats=["lights"], in_use=True, conn=["matter"], description="Thread, next to the sofa", ha=True),
    dict(key="motion", days=131, name="Hallway motion sensor", kind="matter", m=(27018451, 1370, 0x115F, 0x2003),
         device_vendor="Aqara", device_product="Motion and Light Sensor P2", device_type="motion_sensor", area="Hallway",
         cats=["sensors"], in_use=True, conn=["matter"]),
    dict(key="plug", days=97, name="Office smart plug", kind="matter", m=(51392046, 3598, 0x130A, 0x0050),
         device_vendor="Eve Systems", device_product="Eve Energy", device_type="plug", area="Office",
         cats=["plugs"], in_use=True, conn=["matter", "bluetooth"]),
    dict(key="thermo", days=88, name="Bedroom thermostat", kind="homekit", hk=("03145154", "7HQ2", "thermostat"),
         device_vendor="ecobee", device_product="Smart Thermostat Premium", device_type="thermostat", area="Bedroom",
         cats=["climate"], in_use=True, conn=["wifi"], ha=True),
    dict(key="lock", days=75, name="Front door lock", kind="homekit", hk=("48213607", "K3LP", "lock"),
         device_vendor="Nuki", device_product="Smart Lock Pro", device_type="lock", area="Entrance",
         cats=["security"], in_use=True, conn=["bluetooth", "matter"], ha=True),
    dict(key="switch", days=61, name="Kitchen wall switch", kind="zwave",
         z=([50285, 12045, 44321, 9876, 33120, 5421, 61234, 7788], 271, 1538, 4097),
         device_vendor="Fibaro", device_product="Walli Switch", device_type="switch", area="Kitchen",
         cats=["plugs"], in_use=True, conn=["zwave"], ha=True),
    dict(key="garage", days=54, name="Garage door sensor", kind="zwave",
         z=([11873, 40022, 5610, 27431, 60012, 3301, 19988, 45020], 634, 2, 72),
         device_vendor="Zooz", device_product="ZSE41 Open/Close XS", device_type="door_sensor", area="Garage",
         cats=["security", "sensors"], in_use=False, conn=["zwave"]),
    dict(key="patio", days=40, name="Patio bulb", kind="other", custom_standard="Zigbee", manual_code="ZB-7F21-99A0",
         qr_payload="Z:00158D0004A1B2C3$I:83FED3407A939723A5C639B26916D505",
         device_vendor="Philips Hue", device_product="White Ambiance E27", device_type="light", area="Garden",
         cats=["lights"], in_use=True, conn=["zigbee"]),
    dict(key="strip", days=26, name="Desk LED strip", kind="other", custom_standard="Tuya", manual_code="TY-4F82-K91Q",
         qr_payload="https://smartapp.tuya.com/s/p?p=a8x2k&uuid=demo4f82k91q&v=2.0",
         device_vendor="Tuya", device_product="RGBCW LED strip", device_type="light", area="Office",
         cats=["lights"], in_use=False, conn=["wifi"]),
    dict(key="camera", days=15, name="Nursery camera", kind="other", custom_standard="Wyze", manual_code="WZ-3301-CAM",
         qr_payload="WYZE-DEMO-3301-CAM-V3", device_vendor="Wyze", device_product="Cam v3", device_type="camera",
         area="Nursery", cats=["security"], in_use=True, conn=["wifi"]),
    dict(key="spare", days=3, name="Spare contact sensor", kind="matter", m=(80264113, 3001, 0x130A, 0x004D),
         device_vendor="Eve Systems", device_product="Eve Door & Window", device_type="door_sensor", area="",
         cats=["spares"], in_use=False, conn=["matter"], notes="Still boxed, top shelf of the hall cupboard"),
]
TRASHED_CODES = [
    dict(key="porch", days=210, deleted=4, name="Old porch light", kind="matter", m=(46120387, 1811, 0x117C, 0x9000),
         device_vendor="IKEA of Sweden", device_product="KAJPLATS", device_type="light", area="Garden",
         cats=["holiday"], in_use=False, conn=["matter"]),
    dict(key="guest", days=190, deleted=11, name="Guest room sensor", kind="zwave",
         z=([30418, 7204, 51990, 12630, 40871, 2295, 36004, 18842], 634, 2, 72),
         device_vendor="Zooz", device_product="ZSE41 Open/Close XS", device_type="door_sensor", area="Guest room",
         cats=["sensors"], in_use=False, conn=["zwave"]),
]
HA_EXTRA = [  # extra mock Home Assistant devices (name, area)
    ("Office desk lamp", "Office"), ("Office air purifier", "Office"), ("Office speaker", "Office"),
    ("Kitchen smart plug", "Kitchen"), ("Kitchen ceiling light", "Kitchen"), ("Living room speaker", "Living Room"),
    ("Living room TV", "Living Room"), ("Bedroom ceiling light", "Bedroom"), ("Garage door opener", "Garage"),
    ("Patio string lights", "Garden"), ("Nursery night light", "Nursery"), ("Hallway smoke alarm", "Hallway"),
]
HA_AREAS = ["Bedroom", "Entrance", "Garage", "Garden", "Hallway", "Kitchen", "Living Room", "Nursery", "Office"]


def _matter(pin, disc, vid, pid):
    sys.path.insert(0, str(APP))
    from matter_setup_payload import CommissioningFlow, ParsedSetupPayload, generate_manual_code, generate_qr_payload

    p = ParsedSetupPayload(pincode=pin, short_discriminator=disc >> 8, long_discriminator=disc, discovery=4,
                           flow=CommissioningFlow.STANDARD, vid=vid, pid=pid)
    m = generate_manual_code(p)
    return generate_qr_payload(p), f"{m[:4]}-{m[4:7]}-{m[7:]}"


def _homekit(code, setup_id, category):
    sys.path.insert(0, str(APP))
    from homekit_payload import category_id_for, compose_setup_uri

    uri = compose_setup_uri(category_id=category_id_for(category), password=code, setup_id=setup_id)
    return uri, f"{code[:3]}-{code[3:5]}-{code[5:]}"


def _zwave(groups, mfr, ptype, pid, keys=135):
    """SmartStart QR (fake DSK) with a product-id TLV so the Z-Wave device lookup resolves."""
    dsk = "".join(f"{g:05d}" for g in groups)
    word = (0x10 << 8) | 0x01
    tlv = "00" + "10" + f"{word:05d}" + f"{1792:05d}"
    tlv += "02" + "20" + f"{mfr:05d}{ptype:05d}{pid:05d}{(1 << 8 | 2):05d}"
    tlv += "08" + "02" + "01"
    body = f"{keys:03d}" + dsk + tlv
    d = hashlib.sha1(body.encode()).digest()
    return "9001" + f"{(d[0] << 8) | d[1]:05d}" + body


BASE = datetime(2026, 9, 1, 9, 0, tzinfo=timezone.utc)


def _ts(days_ago: float) -> str:
    return (BASE - timedelta(days=days_ago)).strftime("%Y-%m-%dT%H:%M:%SZ")


def _code(d: dict) -> dict:
    out = dict(id=did("code:" + d["key"]), name=d["name"], code_type=d["kind"], device_type=d.get("device_type", ""),
               device_vendor=d.get("device_vendor", ""), device_product=d.get("device_product", ""),
               area=d.get("area", ""), description=d.get("description", ""),
               category_ids=[did("cat:" + k) for k in d.get("cats", [])], manual_code="", qr_payload="",
               custom_standard=d.get("custom_standard", ""), setup_id="", homekit_category="other", homekit_flag=2,
               zwave_pin="", notes=d.get("notes", ""), in_use=bool(d.get("in_use")))
    for c in ("wifi", "matter", "zigbee", "bluetooth", "zwave"):
        out["conn_" + c] = c in d.get("conn", [])
    if d["kind"] == "matter":
        out["qr_payload"], out["manual_code"] = _matter(*d["m"])
    elif d["kind"] == "homekit":
        code, sid, cat = d["hk"]
        out["qr_payload"], out["manual_code"] = _homekit(code, sid, cat)
        out["setup_id"], out["homekit_category"] = sid, cat
    elif d["kind"] == "zwave":
        out["qr_payload"] = _zwave(*d["z"])
        out["zwave_pin"] = f"{d['z'][0][0]:05d}"
    else:
        out["manual_code"], out["qr_payload"] = d.get("manual_code", ""), d.get("qr_payload", "")
    out["ha_link"] = {"device_id": ha_id(d["name"]) if d.get("ha") else None}
    out["created_at"] = _ts(d["days"])
    out["updated_at"] = _ts(max(0.2, d["days"] - 2))
    out["deleted_at"] = _ts(d["deleted"]) if d.get("deleted") else None
    return out


def rebuild() -> None:
    cats = [dict(id=did("cat:" + k), name=n, color=c, icon=i, sort_order=s, deleted_at=None)
            for k, n, c, i, s in CATEGORIES]
    vault = {"meta": {"version": 1, "exported_at": None, "addon_version": "3.0.0", "source": None,
                      "deletions": {"codes": {}, "categories": {}}},
             "categories": cats, "codes": [_code(d) for d in CODES]}
    tcats = [dict(id=did("cat:" + k), name=n, color=c, icon=i, sort_order=s, deleted_at=_ts(ago))
             for k, n, c, i, s, ago in TRASHED_CATEGORIES]
    trash = {"categories": tcats, "codes": [_code(d) for d in TRASHED_CODES]}
    linked = [(c["name"], c["area"], c["ha_link"]["device_id"]) for c in vault["codes"] if c["ha_link"]["device_id"]]
    # Unlinked codes whose name matches an HA device (the "Suggested: <device>" hint).
    suggest = [(c["name"], c["area"]) for c in vault["codes"] if c["name"] in ("Office smart plug", "Hallway motion sensor")]
    devices = [{"id": i, "name": n, "area": a} for n, a, i in linked]
    devices += [{"id": ha_id(n), "name": n, "area": a} for n, a in suggest + HA_EXTRA]
    devices.sort(key=lambda x: x["name"].lower())
    ha = {"devices": devices, "areas": HA_AREAS}
    for name, data in (("demo-vault.json", vault), ("demo-bin.json", trash), ("demo-ha.json", ha)):
        (DEMO / name).write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print("rebuilt", len(vault["codes"]), "codes,", len(cats), "categories,", len(trash["codes"]), "trashed,",
          len(devices), "HA devices")


# ----------------------------------------------------------------------------- seeding
def _parse(ts: str) -> datetime:
    return datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def _shift_all(objs, delta):
    for o in objs:
        for k in ("created_at", "updated_at", "deleted_at"):
            if o.get(k):
                o[k] = (_parse(o[k]) + delta).strftime("%Y-%m-%dT%H:%M:%SZ")


def _translate(obj, table: dict, fields):
    for f in fields:
        v = obj.get(f)
        if isinstance(v, str) and v in table:
            obj[f] = table[v]


def seed(storage: Path, locale: str, ha_out: Path | None) -> None:
    vault = json.loads((DEMO / "demo-vault.json").read_text(encoding="utf-8"))
    trash = json.loads((DEMO / "demo-bin.json").read_text(encoding="utf-8"))
    ha = json.loads((DEMO / "demo-ha.json").read_text(encoding="utf-8"))
    # Newest timestamp becomes "3 hours ago" so relative dates in the UI stay believable.
    stamps = [_parse(o[k]) for o in vault["codes"] + trash["codes"] + trash["categories"]
              for k in ("created_at", "updated_at", "deleted_at") if o.get(k)]
    delta = (datetime.now(timezone.utc) - timedelta(hours=3)) - max(stamps)
    delta = timedelta(seconds=int(delta.total_seconds()))
    _shift_all(vault["codes"] + trash["codes"] + trash["categories"], delta)
    if locale != "en":
        table = json.loads((DEMO / f"{locale}.json").read_text(encoding="utf-8"))
        for c in vault["codes"] + trash["codes"]:
            _translate(c, table, ("name", "area", "description", "notes", "device_product"))
        for c in vault["categories"] + trash["categories"]:
            _translate(c, table, ("name",))
        for d in ha["devices"]:
            _translate(d, table, ("name", "area"))
        ha["areas"] = sorted(table.get(a, a) for a in ha["areas"])
    storage.mkdir(parents=True, exist_ok=True)
    (storage / "anti_matter.json").write_text(json.dumps(vault, indent=2, ensure_ascii=False), encoding="utf-8")
    (storage / "anti-matter-bin.json").write_text(json.dumps(trash, indent=2, ensure_ascii=False), encoding="utf-8")
    # Weekly Sunday 03:00 schedule that already ran this week (so the dialog shows a last run).
    now = datetime.now(timezone.utc)
    year, week, _ = now.isocalendar()
    settings = {"enabled": True, "frequency": "weekly", "hour": 3, "minute": 0, "weekday": 6, "day_of_month": 1,
                "keep_count": 8, "last_run_key": f"{year}-W{week:02d}"}
    (storage / "backup_settings.json").write_text(json.dumps(settings, indent=2), encoding="utf-8")
    if ha_out:
        ha_out.parent.mkdir(parents=True, exist_ok=True)
        ha_out.write_text(json.dumps(ha, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"seeded {storage} ({locale}): {len(vault['codes'])} codes, {len(trash['codes'])} in trash")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("storage", nargs="?", type=Path)
    ap.add_argument("--locale", default="en", choices=["en", "nl"])
    ap.add_argument("--ha-out", type=Path)
    ap.add_argument("--rebuild", action="store_true")
    a = ap.parse_args()
    if a.rebuild:
        rebuild()
        return
    if not a.storage:
        ap.error("STORAGE_DIR is required (or --rebuild)")
    seed(a.storage, a.locale, a.ha_out)


if __name__ == "__main__":
    main()
