// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.7.1;
pragma experimental ABIEncoderV2;

import "./TransferDefinition.sol";
import "../lib/LibChannelCrypto.sol";

/// @title CrosschainTransfer
/// @author Connext <support@connext.network>
/// @notice This contract burns the initiator's funds if a mutually signed
///         transfer can be generated

contract CrosschainTransfer is TransferDefinition {
    using LibChannelCrypto for bytes32;

    struct TransferState {
        bytes initiatorSignature;
        address initiator;
        address responder;
        bytes32 data;
        uint256 nonce; // Included so that each transfer commitment has a unique hash.
        uint256 fee;
        address callTo;
        bytes callData;
        bytes32 lockHash;
    }

    struct TransferResolver {
        bytes responderSignature;
        bytes32 preImage;
    }

    // Provide registry information.
    string public constant override Name = "CrosschainTransfer";
    string public constant override StateEncoding =
        "tuple(bytes initiatorSignature, address initiator, address responder, bytes32 data, uint256 nonce, uint256 fee, address callTo, bytes callData, bytes32 lockHash)";
    string public constant override ResolverEncoding =
        "tuple(bytes responderSignature, bytes32 preImage)";

    function EncodedCancel() external pure override returns (bytes memory) {
        TransferResolver memory resolver;
        resolver.responderSignature = new bytes(65);
        resolver.preImage = bytes32(0);
        return abi.encode(resolver);
    }

    function create(bytes calldata encodedBalance, bytes calldata encodedState)
        external
        pure
        override
        returns (bool)
    {
        // Get unencoded information.
        TransferState memory state = abi.decode(encodedState, (TransferState));
        Balance memory balance = abi.decode(encodedBalance, (Balance));

        // Ensure data and nonce provided.
        require(state.data != bytes32(0), "CrosschainTransfer: EMPTY_DATA");
        require(state.nonce != uint256(0), "CrosschainTransfer: EMPTY_NONCE");

        // Initiator balance can be 0 for crosschain contract calls
        require(
            state.fee <= balance.amount[0],
            "CrosschainTransfer: INSUFFICIENT_BALANCE"
        );

        // Recipient balance must be 0.
        require(
            balance.amount[1] == 0,
            "CrosschainTransfer: NONZERO_RECIPIENT_BALANCE"
        );

        // Valid lockHash to secure funds must be provided.
        require(
            state.lockHash != bytes32(0),
            "CrosschainTransfer: EMPTY_LOCKHASH"
        );

        require(
            state.data.checkSignature(
                state.initiatorSignature,
                state.initiator
            ),
            "CrosschainTransfer: INVALID_INITIATOR_SIG"
        );

        require(
            state.initiator != address(0) && state.responder != address(0),
            "CrosschainTransfer: EMPTY_SIGNERS"
        );

        // Valid initial transfer state
        return true;
    }

    function resolve(
        bytes calldata encodedBalance,
        bytes calldata encodedState,
        bytes calldata encodedResolver
    ) external pure override returns (Balance memory) {
        TransferState memory state = abi.decode(encodedState, (TransferState));
        TransferResolver memory resolver =
            abi.decode(encodedResolver, (TransferResolver));
        Balance memory balance = abi.decode(encodedBalance, (Balance));

        require(
            state.data.checkSignature(
                resolver.responderSignature,
                state.responder
            ),
            "CrosschainTransfer: INVALID_RESPONDER_SIG"
        );

        // Check hash for normal payment unlock.
        bytes32 generatedHash = sha256(abi.encode(resolver.preImage));
        require(
            state.lockHash == generatedHash,
            "CrosschainTransfer: INVALID_PREIMAGE"
        );

        // Reduce CrosschainTransfer amount to optional fee.
        // It's up to the offchain validators to ensure that the
        // CrosschainTransfer commitment takes this fee into account.
        balance.amount[1] = state.fee;
        balance.amount[0] = 0;

        return balance;
    }
}
