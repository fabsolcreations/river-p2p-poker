// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Test-only 6-decimal ERC-20 standing in for USDC on a local
/// Hardhat network. NOT used against baseSepolia/base - point
/// worker/chain-config.ts at the real USDC contract address for those.
/// The public capped faucet means automated tests and the sandboxed-
/// browser verification pass never depend on a third-party token faucet.
contract MockUSDC is ERC20 {
    uint256 public constant FAUCET_CAP = 10_000 * 10 ** 6;

    constructor() ERC20("Mock USD Coin", "mUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function faucet(uint256 amount) external {
        require(amount <= FAUCET_CAP, "exceeds faucet cap");
        _mint(msg.sender, amount);
    }
}
