// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {CutPool} from "../src/CutPool.sol";
import {MerkleDistributor} from "../src/MerkleDistributor.sol";

/// @title Deploy
/// @notice Deploys MerkleDistributor (optional) and CutPool on Robinhood Chain.
///
/// Environment (see .env.example):
///   PRIVATE_KEY        deployer key (hex, 0x-prefixed)
///   DEV                dev payout address
///   CLIPPER_POOL       clipper payout address. Leave empty/zero to deploy a fresh
///                      MerkleDistributor and use its address (recommended).
///   TEAM               team payout address
///   BPS_DEV / BPS_CLIPPER / BPS_TEAM   basis points, must sum to 10000
///   CLAIM_TARGET       Pons locker address, or empty/zero to disable CutPool.claim (mode A)
///   CLAIM_SELECTOR     4-byte selector of the locker's claim function, left-aligned in a
///                      bytes32 (e.g. 0x1234567800000000000000000000000000000000000000000000000000000000);
///                      required with CLAIM_TARGET
///   DISTRIBUTOR_OWNER  owner of the deployed MerkleDistributor (defaults to the deployer)
///   DEPLOY_DISTRIBUTOR "true" (default) to deploy MerkleDistributor, "false" to skip
///
/// RPC_URL is consumed by forge itself via `--rpc-url $RPC_URL` (or the `robinhood` alias
/// in foundry.toml).
contract Deploy is Script {
    struct Config {
        address deployer;
        address dev;
        address clipperPool;
        address team;
        uint16 bpsDev;
        uint16 bpsClipper;
        uint16 bpsTeam;
        address claimTarget;
        bytes4 claimSelector;
        address distributorOwner;
        bool deployDistributor;
    }

    function run() external returns (CutPool pool, MerkleDistributor distributor) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        Config memory c = _readConfig(vm.addr(pk));

        console.log("chain id      :", block.chainid);
        console.log("deployer      :", c.deployer);

        vm.startBroadcast(pk);

        if (c.deployDistributor) {
            distributor = new MerkleDistributor(c.distributorOwner);
            if (c.clipperPool == address(0)) c.clipperPool = address(distributor);
        }
        require(c.clipperPool != address(0), "CLIPPER_POOL required when DEPLOY_DISTRIBUTOR=false");

        pool = new CutPool(_recipients(c), _bps(c), c.claimTarget, c.claimSelector);

        vm.stopBroadcast();

        _log(c, pool, distributor);
    }

    function _readConfig(address deployer) internal view returns (Config memory c) {
        c.deployer = deployer;
        c.dev = vm.envAddress("DEV");
        c.team = vm.envAddress("TEAM");
        c.clipperPool = vm.envOr("CLIPPER_POOL", address(0));
        c.claimTarget = vm.envOr("CLAIM_TARGET", address(0));
        c.claimSelector = bytes4(vm.envOr("CLAIM_SELECTOR", bytes32(0)));
        c.distributorOwner = vm.envOr("DISTRIBUTOR_OWNER", deployer);
        c.deployDistributor = vm.envOr("DEPLOY_DISTRIBUTOR", true);

        uint256 bpsDev = vm.envUint("BPS_DEV");
        uint256 bpsClipper = vm.envUint("BPS_CLIPPER");
        uint256 bpsTeam = vm.envUint("BPS_TEAM");
        require(bpsDev + bpsClipper + bpsTeam == 10_000, "BPS must sum to 10000");
        c.bpsDev = uint16(bpsDev);
        c.bpsClipper = uint16(bpsClipper);
        c.bpsTeam = uint16(bpsTeam);

        require(c.dev != address(0) && c.team != address(0), "DEV/TEAM required");
        if (c.claimTarget != address(0)) {
            require(c.claimSelector != bytes4(0), "CLAIM_SELECTOR required when CLAIM_TARGET is set");
        }
    }

    function _recipients(Config memory c) internal pure returns (address[] memory r) {
        r = new address[](3);
        r[0] = c.dev;
        r[1] = c.clipperPool;
        r[2] = c.team;
    }

    function _bps(Config memory c) internal pure returns (uint16[] memory b) {
        b = new uint16[](3);
        b[0] = c.bpsDev;
        b[1] = c.bpsClipper;
        b[2] = c.bpsTeam;
    }

    function _log(Config memory c, CutPool pool, MerkleDistributor distributor) internal pure {
        if (address(distributor) != address(0)) {
            console.log("MerkleDistributor:", address(distributor));
            console.log("  owner        :", c.distributorOwner);
        }
        console.log("CutPool          :", address(pool));
        console.log("  dev          :", c.dev, c.bpsDev);
        console.log("  clipperPool  :", c.clipperPool, c.bpsClipper);
        console.log("  team         :", c.team, c.bpsTeam);
        console.log("  claimTarget  :", c.claimTarget);
        console.log("  claimSelector:", vm.toString(abi.encodePacked(c.claimSelector)));
    }
}
