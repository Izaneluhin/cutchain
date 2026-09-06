// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Test-only Merkle tree builder that mirrors tooling/build_round.py:
///      sorted-pair hashing, odd node carried up unchanged.
library MerkleTreeLib {
    function hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    /// @dev Returns all layers, layers[0] = leaves, layers[last] = [root].
    function layers(bytes32[] memory leaves) internal pure returns (bytes32[][] memory out) {
        require(leaves.length > 0, "no leaves");
        uint256 depth = 1;
        uint256 n = leaves.length;
        while (n > 1) {
            n = (n + 1) / 2;
            depth++;
        }
        out = new bytes32[][](depth);
        out[0] = leaves;
        for (uint256 d = 1; d < depth; d++) {
            bytes32[] memory cur = out[d - 1];
            bytes32[] memory nxt = new bytes32[]((cur.length + 1) / 2);
            for (uint256 i = 0; i < cur.length; i += 2) {
                nxt[i / 2] = i + 1 < cur.length ? hashPair(cur[i], cur[i + 1]) : cur[i];
            }
            out[d] = nxt;
        }
    }

    function root(bytes32[] memory leaves) internal pure returns (bytes32) {
        bytes32[][] memory l = layers(leaves);
        return l[l.length - 1][0];
    }

    function proof(bytes32[] memory leaves, uint256 index) internal pure returns (bytes32[] memory p) {
        bytes32[][] memory l = layers(leaves);
        uint256 count;
        uint256 idx = index;
        for (uint256 d = 0; d + 1 < l.length; d++) {
            if ((idx ^ 1) < l[d].length) count++;
            idx /= 2;
        }
        p = new bytes32[](count);
        idx = index;
        uint256 k;
        for (uint256 d = 0; d + 1 < l.length; d++) {
            uint256 sib = idx ^ 1;
            if (sib < l[d].length) p[k++] = l[d][sib];
            idx /= 2;
        }
    }
}
