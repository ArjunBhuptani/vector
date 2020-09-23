// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.7.1;
pragma experimental ABIEncoderV2;


struct Balance {
    uint256[2] amount;
    address payable[2] to;
}

struct LatestDeposit {
    uint256 amount;
    uint256 nonce;
}

struct CoreChannelState {
    Balance[] balances; // TODO index by assetAddress? // initiator, responder
    uint256[] lockedBalance; // Indexed by assetAddress -- should always be changed in lockstep with transfers
    address[] assetAddresss;
    address channelAddress;
    address[2] participants; // Signer keys -- does NOT have to be the same as balances.to[]
    uint256 timeout;
    uint256 nonce;
    uint256 latestDepositNonce;
    bytes32 merkleRoot;
}

struct CoreTransferState {
    Balance initialBalance;
    address assetAddress;
    address channelAddress;
    bytes32 transferId;
    address transferDefinition;
    uint256 transferTimeout;
    bytes32 initialStateHash;
}


struct ChannelDispute {
    bytes32 channelStateHash;
    uint256 nonce;
    bytes32 merkleRoot;
    uint256 consensusExpiry;
    uint256 defundExpiry;
    bool isDefunded;
}

struct TransferDispute {
    uint256 transferDisputeExpiry;
    bytes32 transferStateHash;
    bool isDefunded;
}
