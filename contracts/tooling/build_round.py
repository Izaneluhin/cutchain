#!/usr/bin/env python3
"""
build_round.py — build a weekly CUT clipper payout round for MerkleDistributor.sol.

Reads a CSV with columns `address,handle,views`, splits `--total` (in wei / smallest token
unit) across addresses proportionally to views, builds a Merkle tree with EXACTLY the leaf
encoding and sorted-pair hashing used by `src/MerkleDistributor.sol`, and writes
`round_<n>.json` containing the root, the total and a per-address {index, amount, proof}.

Leaf encoding (identical to MerkleDistributor.leaf()):

    inner = keccak256( uint256(roundId) ‖ uint256(index) ‖ uint256(uint160(account)) ‖ uint256(amount) )
            (four 32-byte big-endian words; the address is left-padded with 12 zero bytes)
    leaf  = keccak256( inner )                                  # double hash (OpenZeppelin style)

Internal nodes are keccak256(min(a,b) ‖ max(a,b)). At a level with an odd number of nodes the
last node is carried up unchanged, so its proof has no sibling at that level.

Amount math: amount_i = floor(total * views_i / sum(views)); the LAST paid row (in CSV order)
receives the remainder so that sum(amount) == total exactly. Rows with 0 views are excluded
from the tree (they would have nothing to claim) and listed under "excluded" in the output.
Duplicate addresses (case-insensitive) are merged by summing their views.

Dependencies: none required. `pycryptodome` is used for keccak if installed
(`pip install pycryptodome`), otherwise a small pure-Python keccak-256 is used.

Usage:
    python3 build_round.py --csv views.csv --total 1000000000000000000 --round 37
    python3 build_round.py --csv views.csv --total 5e21 --round 38 --token 0xYourCutToken --out round_38.json
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Dict, List, Optional, Tuple

# ----------------------------------------------------------------------------
# keccak-256
# ----------------------------------------------------------------------------

try:  # fast path
    from Crypto.Hash import keccak as _keccak  # type: ignore

    def keccak256(data: bytes) -> bytes:
        return _keccak.new(digest_bits=256, data=data).digest()

    KECCAK_BACKEND = "pycryptodome"
except Exception:  # pragma: no cover - exercised only when pycryptodome is missing
    _RC = [
        0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
        0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
        0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
        0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
        0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
        0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
    ]
    _ROT = [
        [0, 36, 3, 41, 18],
        [1, 44, 10, 45, 2],
        [62, 6, 43, 15, 61],
        [28, 55, 25, 21, 56],
        [27, 20, 39, 8, 14],
    ]
    _MASK = (1 << 64) - 1

    def _rol(x: int, n: int) -> int:
        n %= 64
        return ((x << n) | (x >> (64 - n))) & _MASK if n else x

    def _keccak_f(A: List[List[int]]) -> None:
        for rc in _RC:
            # theta
            C = [A[x][0] ^ A[x][1] ^ A[x][2] ^ A[x][3] ^ A[x][4] for x in range(5)]
            D = [C[(x - 1) % 5] ^ _rol(C[(x + 1) % 5], 1) for x in range(5)]
            for x in range(5):
                for y in range(5):
                    A[x][y] ^= D[x]
            # rho + pi
            B = [[0] * 5 for _ in range(5)]
            for x in range(5):
                for y in range(5):
                    B[y][(2 * x + 3 * y) % 5] = _rol(A[x][y], _ROT[x][y])
            # chi
            for x in range(5):
                for y in range(5):
                    A[x][y] = B[x][y] ^ ((~B[(x + 1) % 5][y]) & B[(x + 2) % 5][y])
            # iota
            A[0][0] ^= rc

    def keccak256(data: bytes) -> bytes:
        rate = 136  # 1088 bits
        # pad10*1 with Keccak (0x01) domain byte, NOT SHA3's 0x06
        padded = bytearray(data)
        padded.append(0x01)
        while len(padded) % rate != 0:
            padded.append(0x00)
        padded[-1] |= 0x80
        A = [[0] * 5 for _ in range(5)]
        for off in range(0, len(padded), rate):
            block = padded[off : off + rate]
            for i in range(rate // 8):
                lane = int.from_bytes(block[8 * i : 8 * i + 8], "little")
                A[i % 5][i // 5] ^= lane
            _keccak_f(A)
        out = bytearray()
        for i in range(4):  # 32 bytes = 4 lanes
            out += A[i % 5][i // 5].to_bytes(8, "little")
        return bytes(out)

    KECCAK_BACKEND = "pure-python"


# ----------------------------------------------------------------------------
# Address helpers
# ----------------------------------------------------------------------------


def normalize_address(raw: str) -> str:
    s = raw.strip()
    if s.startswith(("0x", "0X")):
        s = s[2:]
    if len(s) != 40 or any(c not in "0123456789abcdefABCDEF" for c in s):
        raise ValueError(f"invalid address: {raw!r}")
    return s.lower()


def to_checksum_address(addr_hex40_lower: str) -> str:
    h = keccak256(addr_hex40_lower.encode("ascii")).hex()
    out = "0x"
    for i, c in enumerate(addr_hex40_lower):
        out += c.upper() if (c in "abcdef" and int(h[i], 16) >= 8) else c
    return out


# ----------------------------------------------------------------------------
# Merkle tree (must mirror MerkleDistributor.sol)
# ----------------------------------------------------------------------------


def u256(x: int) -> bytes:
    if x < 0 or x >= 1 << 256:
        raise ValueError("value out of uint256 range")
    return x.to_bytes(32, "big")


def leaf_hash(round_id: int, index: int, account_hex40: str, amount: int) -> bytes:
    inner = keccak256(u256(round_id) + u256(index) + u256(int(account_hex40, 16)) + u256(amount))
    return keccak256(inner)


def hash_pair(a: bytes, b: bytes) -> bytes:
    return keccak256(a + b) if a < b else keccak256(b + a)


def build_tree(leaves: List[bytes]) -> List[List[bytes]]:
    """Returns layers[0] = leaves, layers[-1] = [root]."""
    if not leaves:
        raise ValueError("cannot build a tree with no leaves")
    layers = [list(leaves)]
    while len(layers[-1]) > 1:
        cur = layers[-1]
        nxt = []
        for i in range(0, len(cur), 2):
            if i + 1 < len(cur):
                nxt.append(hash_pair(cur[i], cur[i + 1]))
            else:
                nxt.append(cur[i])  # odd node carried up unchanged
        layers.append(nxt)
    return layers


def get_proof(layers: List[List[bytes]], index: int) -> List[bytes]:
    proof = []
    for layer in layers[:-1]:
        sibling = index ^ 1
        if sibling < len(layer):
            proof.append(layer[sibling])
        index //= 2
    return proof


def verify_proof(proof: List[bytes], root: bytes, leaf: bytes) -> bool:
    node = leaf
    for p in proof:
        node = hash_pair(node, p)
    return node == root


# ----------------------------------------------------------------------------
# Round building
# ----------------------------------------------------------------------------


@dataclass
class Row:
    address: str  # 40 lowercase hex chars, no 0x
    handles: List[str]
    views: int


def read_views_csv(path: Path) -> List[Row]:
    rows: List[Row] = []
    by_addr: Dict[str, Row] = {}
    with path.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        required = {"address", "handle", "views"}
        if reader.fieldnames is None or not required.issubset({c.strip() for c in reader.fieldnames}):
            raise SystemExit(f"CSV must have columns: address,handle,views (got {reader.fieldnames})")
        for lineno, rec in enumerate(reader, start=2):
            addr_raw = (rec.get("address") or "").strip()
            handle = (rec.get("handle") or "").strip()
            views_raw = (rec.get("views") or "").strip().replace(",", "").replace("_", "")
            if not addr_raw and not handle and not views_raw:
                continue  # blank line
            try:
                addr = normalize_address(addr_raw)
            except ValueError as e:
                raise SystemExit(f"line {lineno}: {e}")
            try:
                views = int(views_raw)
            except ValueError:
                raise SystemExit(f"line {lineno}: views must be an integer, got {views_raw!r}")
            if views < 0:
                raise SystemExit(f"line {lineno}: views must be >= 0")
            if addr in by_addr:
                existing = by_addr[addr]
                existing.views += views
                if handle and handle not in existing.handles:
                    existing.handles.append(handle)
                print(f"warning: line {lineno}: duplicate address {to_checksum_address(addr)} merged", file=sys.stderr)
            else:
                row = Row(address=addr, handles=[handle] if handle else [], views=views)
                by_addr[addr] = row
                rows.append(row)
    return rows


def compute_amounts(rows: List[Row], total: int) -> Tuple[List[Tuple[Row, int]], List[Row]]:
    paid = [r for r in rows if r.views > 0]
    excluded = [r for r in rows if r.views == 0]
    if not paid:
        raise SystemExit("no rows with views > 0")
    sum_views = sum(r.views for r in paid)
    amounts: List[Tuple[Row, int]] = []
    distributed = 0
    for i, r in enumerate(paid):
        if i == len(paid) - 1:
            amt = total - distributed  # last paid row absorbs the rounding remainder
        else:
            amt = total * r.views // sum_views
        distributed += amt
        amounts.append((r, amt))
    assert distributed == total
    return amounts, excluded


def parse_total(s: str) -> int:
    """Accepts plain integers, underscores, and scientific notation (e.g. 5e21) as exact integers."""
    s = s.strip().replace("_", "")
    try:
        return int(s)
    except ValueError:
        d = Decimal(s)
        if d != d.to_integral_value():
            raise SystemExit(f"--total must be an integer amount in wei, got {s!r}")
        return int(d)


def build_round(round_id: int, rows: List[Row], total: int, token: Optional[str]) -> dict:
    amounts, excluded = compute_amounts(rows, total)
    leaves = [leaf_hash(round_id, i, r.address, amt) for i, (r, amt) in enumerate(amounts)]
    layers = build_tree(leaves)
    root = layers[-1][0]

    claims = []
    for i, (r, amt) in enumerate(amounts):
        proof = get_proof(layers, i)
        if not verify_proof(proof, root, leaves[i]):
            raise SystemExit(f"internal error: proof for index {i} does not verify")
        claims.append(
            {
                "index": i,
                "account": to_checksum_address(r.address),
                "handle": ",".join(r.handles),
                "views": r.views,
                "amount": str(amt),
                "proof": ["0x" + p.hex() for p in proof],
            }
        )

    return {
        "round": round_id,
        "token": to_checksum_address(normalize_address(token)) if token else None,
        "total": str(total),
        "totalViews": sum(r.views for r, _ in amounts),
        "recipients": len(claims),
        "merkleRoot": "0x" + root.hex(),
        "leafEncoding": "keccak256(bytes.concat(keccak256(abi.encode(uint256 roundId, uint256 index, address account, uint256 amount))))",
        "pairHashing": "keccak256(min(a,b) ‖ max(a,b)); odd node carried up unchanged",
        "claims": claims,
        "excluded": [
            {"account": to_checksum_address(r.address), "handle": ",".join(r.handles), "views": r.views} for r in excluded
        ],
    }


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--csv", required=True, type=Path, help="views CSV with columns address,handle,views")
    ap.add_argument("--total", required=True, help="total payout for the round in wei (integer, 5e21 accepted)")
    ap.add_argument("--round", required=True, type=int, help="roundId to use on-chain (uint256)")
    ap.add_argument("--token", default=None, help="payout token address (omit for ETH rounds); informational")
    ap.add_argument("--out", type=Path, default=None, help="output JSON path (default: round_<round>.json)")
    ap.add_argument("--quiet", action="store_true", help="do not print the summary table")
    args = ap.parse_args(argv)

    total = parse_total(args.total)
    if total <= 0:
        raise SystemExit("--total must be > 0")
    if args.round < 0 or args.round >= 1 << 256:
        raise SystemExit("--round must fit in uint256")

    rows = read_views_csv(args.csv)
    if not rows:
        raise SystemExit("CSV contains no rows")

    result = build_round(args.round, rows, total, args.token)
    out = args.out or Path(f"round_{args.round}.json")
    out.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")

    if not args.quiet:
        print(f"keccak backend : {KECCAK_BACKEND}")
        print(f"round          : {result['round']}")
        print(f"token          : {result['token'] or 'ETH (address(0))'}")
        print(f"total          : {result['total']}")
        print(f"total views    : {result['totalViews']}")
        print(f"recipients     : {result['recipients']} (excluded with 0 views: {len(result['excluded'])})")
        print(f"merkle root    : {result['merkleRoot']}")
        print(f"written        : {out}")
        print()
        print(f"{'idx':>4}  {'account':42}  {'views':>10}  {'amount':>32}  handle")
        for c in result["claims"]:
            print(f"{c['index']:>4}  {c['account']:42}  {c['views']:>10}  {c['amount']:>32}  {c['handle']}")
        print()
        print("setRound call (fill in deadline as a unix timestamp):")
        tok = result["token"] or "0x0000000000000000000000000000000000000000"
        print(
            f"  cast send $DISTRIBUTOR 'setRound(uint256,address,bytes32,uint256,uint64)' "
            f"{result['round']} {tok} {result['merkleRoot']} {result['total']} <claimDeadline> "
            f"--rpc-url $RPC_URL --private-key $PRIVATE_KEY"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
