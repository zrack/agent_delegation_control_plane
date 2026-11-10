"""Fictional inputs and independently specified expected results."""
CASES = [
    {"id": "invoice-a", "csv": "invoice_id,quantity,unit_price_cents\nA,2,400\nB,3,250\nC,1,500\nD,1,-125\n",
     "expected": {"invoice_count": 4, "subtotal_cents": 1925, "tax_cents": 134, "total_cents": 2059}},
    {"id": "invoice-b", "csv": "invoice_id,quantity,unit_price_cents\nA,1,999\nB,2,101\nC,0,700\nD,1,-50\n",
     "expected": {"invoice_count": 4, "subtotal_cents": 1151, "tax_cents": 80, "total_cents": 1231}},
    {"id": "invoice-c", "csv": "invoice_id,quantity,unit_price_cents\nA,7,333\nB,1,1\nC,2,-25\n",
     "expected": {"invoice_count": 3, "subtotal_cents": 2282, "tax_cents": 159, "total_cents": 2441}},
]

# Deterministic control only; never substituted for live model output.
CONTROL_PROGRAM = '''import csv, json
with open("invoices.csv", newline="") as handle:
    rows = list(csv.DictReader(handle))
subtotal = sum(int(row["quantity"]) * int(row["unit_price_cents"]) for row in rows)
tax = subtotal * 7 // 100
with open("results.json", "w") as handle:
    json.dump({"invoice_count": len(rows), "subtotal_cents": subtotal,
               "tax_cents": tax, "total_cents": subtotal + tax}, handle)
'''
