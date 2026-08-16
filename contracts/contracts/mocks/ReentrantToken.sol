// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {EscrowVault} from "../EscrowVault.sol";

/// @notice Test-only hostile ERC20 whose `transferFrom` calls back into
/// `EscrowVault.deposit` before returning, used to prove `deposit`'s
/// `nonReentrant` guard actually fires. Not a realistic attack via
/// MockUSDC/real USDC (neither has a transfer hook) - this exists purely
/// to exercise the guard itself, deliberately.
///
/// `EscrowVault.withdraw` is NOT independently testable this way: any
/// reentrant call arriving via a token callback has the token contract as
/// `msg.sender`, which can never equal the configured `operator`, so
/// `onlyOperator` already forecloses that path before `nonReentrant` would
/// even matter.
contract ReentrantToken is ERC20 {
    address public target;
    bool public armed;

    constructor() ERC20("Reentrant", "RENT") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(address vault) external {
        target = vault;
        armed = true;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        bool ok = super.transferFrom(from, to, amount);
        if (armed) {
            armed = false; // one shot, avoids infinite recursion
            EscrowVault(target).deposit(amount);
        }
        return ok;
    }
}
