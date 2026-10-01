"""Extract planning-only fields, including intact fields in truncated log lines.
Usage: python3 scripts/extract_test_orders.py INPUT OUTPUT
"""
import collections
import datetime as dt
import json
import sys
from pathlib import Path

DECODER = json.JSONDecoder()
TZ = dt.timezone(dt.timedelta(hours=5))

def prefix_fields(text, start):
    result = {}
    pos = text.index("{", start) + 1
    while True:
        while pos < len(text) and text[pos] in " \n\r\t,":
            pos += 1
        if pos >= len(text) or text[pos] == "}":
            return result
        try:
            key, pos = DECODER.raw_decode(text, pos)
            while text[pos].isspace():
                pos += 1
            if text[pos] != ":":
                return result
            pos += 1
            while text[pos].isspace():
                pos += 1
            value, pos = DECODER.raw_decode(text, pos)
            result[key] = value
        except (json.JSONDecodeError, IndexError):
            return result  # Never guess missing or partially truncated values.

def local(value):
    return dt.datetime.fromisoformat(value).replace(tzinfo=TZ) if value else None

def iso(value):
    return value.isoformat(timespec="seconds") if value else None

rows = json.loads(Path(sys.argv[1]).read_text())
groups = collections.defaultdict(list)
truncated = 0
for index, row in enumerate(rows):
    text = row["line"]
    try:
        json.loads(text)
    except json.JSONDecodeError:
        truncated += 1
    header = prefix_fields(text, text.index('"eventInfo":') + len('"eventInfo":'))
    order = prefix_fields(text, text.index('"order":') + len('"order":'))
    seen = dt.datetime.fromtimestamp(int(row["timestamp"]) / 1e9, TZ)
    groups[header["id"]].append((seen, order, index + 1, header.get("organizationId")))

orders, excluded = [], []
for order_id, entries in groups.items():
    entries.sort(key=lambda entry: entry[0])
    latest = entries[-1][1]
    types = {(entry[1].get("orderType") or {}).get("orderServiceType") for entry in entries}
    point = (latest.get("deliveryPoint") or {}).get("coordinates")
    reason = ("PICKUP" if "DeliveryByClient" in types else
              "CANCELLED" if latest.get("isDeleted") or latest.get("status") == "Cancelled" else
              "MISSING_COORDINATES" if not point else None)
    if reason:
        excluded.append({"id": order_id, "reason": reason})
        continue
    first = entries[0][1]
    created = local(first["whenCreated"])
    start = local(first.get("cookingStartTime")) or created
    ready = start + dt.timedelta(minutes=12)
    deadline = created + dt.timedelta(minutes=35)
    x = round(40 + (point["longitude"] - 69.252) / (69.324 - 69.252) * 720, 1)
    y = round(35 + (41.359 - point["latitude"]) / (41.359 - 41.314) * 530, 1)
    orders.append({
        "id": order_id, "number": first.get("number"), "branchId": entries[0][3],
        "address": f"Тестовый заказ №{first.get('number', order_id)}",
        "status": "COOKING_STARTED", "sum": first["sum"], "service": 0,
        "created": created.strftime("%H:%M"), "ready": ready.strftime("%H:%M"),
        "deadline": deadline.strftime("%H:%M"), "x": x, "y": y,
        "latitude": point["latitude"], "longitude": point["longitude"],
        "createdAt": iso(created), "readyAt": iso(ready), "deadlineAt": iso(deadline),
        "readySource": "cookingStartTime + assumed 12 min", "deadlineSource": "whenCreated + 35 min",
        "sumSource": "iiko.sum (fullSum unavailable)",
        "deliveryTypeConfirmed": "DeliveryByCourier" in types,
        "events": [{"observedAt": iso(seen), "sourceRow": row_index,
            "status": event.get("status"), "sum": event.get("sum"),
            "cookingCompleteBeforeAt": iso(local(event.get("completeBefore"))),
            "cookingCompletedAt": iso(local(event.get("whenCookingCompleted")))}
            for seen, event, row_index, _ in entries]
    })
orders.sort(key=lambda order: (order["createdAt"], order["id"]))
result = {"schemaVersion": 1, "name": "Amir Temur · 2026-10-01 · test orders",
    "timezone": "Asia/Tashkent", "sourceFile": Path(sys.argv[1]).name,
    "extraction": {"rows": len(rows), "truncatedRows": truncated,
        "uniqueOrders": len(groups), "usableOrders": len(orders), "excluded": excluded},
    "assumptions": ["Enough synthetic FREE couriers for every bucket; branch caps apply.",
        "Initial ECT = cookingStartTime + 12 min; actual readiness is used only after its event is observed.",
        "Delivery deadline = whenCreated + 35 min; IIKO completeBefore is a kitchen target, not delivery SLA.",
        "Order value uses IIKO sum; fullSum before discounts is absent.",
        "Incomplete trailing JSON is ignored; only complete fields are extracted.",
        "No phone, customer identity, courier identity, apartment or delivery comment is copied.",
        "Snapshots are independent comparisons, not a simulation of a complete dispatch day.",
        "Snapshot cohort: only observed, not dispatched orders whose delivery deadline has not passed.",
        "Positions are fixed to the latest extracted coordinates; address-change replay is not simulated."],
    "settings": {"allowLate": True, "alwaysFreeCouriers": True,
        "goOutFromBranchMin": 2, "giveOrderToClientMin": 2,
        "bucketMaxFullSum": 1000000, "bucketMaxOrders": 8, "returnBufferPct": 20},
    "couriers": [], "orders": orders}
Path(sys.argv[2]).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
print(json.dumps(result["extraction"], ensure_ascii=False))
