// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.7.1;
pragma experimental ABIEncoderV2;

import "./interfaces/ICMCCore.sol";
import "./ReentrancyGuard.sol";

contract CMCCore is ICMCCore {
  address constant invalidParticipant = address(1);

  address internal alice;
  address internal bob;

  /// @notice Set invalid participants to block the mastercopy from being used directly
  ///         Nonzero address also prevents the mastercopy from being setup
  ///         Only setting alice is sufficient, setting bob too wouldn't change anything
  constructor () {
      alice = invalidParticipant;
  }

  // Prevents us from calling methods directly from the mastercopy contract
  modifier onlyViaProxy {
    require(alice != address(1), "Mastercopy: ONLY_VIA_PROXY");
    _;
  }

  /// @notice Contract constructor for Proxied copies
  /// @param _alice: Address representing user with function deposit
  /// @param _bob: Address representing user with multisig deposit
  function setup(address _alice, address _bob) external override onlyViaProxy {
    require(alice == address(0), "CMCCore: ALREADY_SETUP");
    require(_alice != address(0) && _bob != address(0), "CMCCore: INVALID_PARTICIPANT");
    require(_alice != _bob, "CMCCore: IDENTICAL_PARTICIPANTS");
    alice = _alice;
    bob = _bob;
  }

  /// @notice A getter function for the bob of the multisig
  /// @return Bob's signer address
  function getAlice() external override view onlyViaProxy returns (address) {
    return alice;
  }

  /// @notice A getter function for the bob of the multisig
  /// @return Alice's signer address
  function getBob() external override view onlyViaProxy returns (address) {
    return bob;
  }
}
