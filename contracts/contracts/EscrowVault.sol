// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Pooled custody vault for RIVER's off-chain-dealt poker tables.
///
/// This contract deliberately does NOT keep a per-user balance ledger and
/// does NOT verify anything about poker hands - RIVER's off-chain D1
/// database (`ledgerEntries`/`users.balance`) is already the tested,
/// atomic source of truth for who owns what, and hand fairness is already
/// proven independently via TableProofBundle/verifyTableBundle
/// (worker/table-engine.ts). This contract's only job is: hold the token,
/// and let one authorized `operator` key release it, with an on-chain
/// event trail (`reference`) tying every payout back to the specific
/// off-chain ledger entry that authorized it.
///
/// `owner` and `operator` are deliberately different keys with different
/// blast radii: `owner` is a cold key used by hand for `pause`/`unpause`/
/// `setOperator` and never touches the running app; `operator` is the one
/// hot key the app's backend holds, and it can only ever call `withdraw`.
contract EscrowVault is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    address public operator;

    event Deposited(address indexed depositor, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount, bytes32 indexed refId, address indexed operator);
    event OperatorUpdated(address indexed previousOperator, address indexed newOperator);

    error ZeroAddress();
    error ZeroAmount();
    error NotOperator(address caller);

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator(msg.sender);
        _;
    }

    constructor(address token_, address operator_, address initialOwner) Ownable(initialOwner) {
        if (token_ == address(0) || operator_ == address(0)) revert ZeroAddress();
        token = IERC20(token_);
        operator = operator_;
        emit OperatorUpdated(address(0), operator_);
    }

    /// @notice User-initiated deposit. Requires a prior
    /// `token.approve(vaultAddress, amount)` from `msg.sender`. Emits
    /// `Deposited` so the backend can credit the depositor's off-chain
    /// balance once the transaction is confirmed - this contract itself
    /// does not track who is owed what.
    function deposit(uint256 amount) external whenNotPaused nonReentrant {
        if (amount == 0) revert ZeroAmount();
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount);
    }

    /// @notice Operator-only payout. `refId` should be the off-chain
    /// ledger entry (e.g. a UUID packed into bytes32) that authorized this
    /// withdrawal, so the payout is independently auditable on-chain
    /// without needing database access.
    function withdraw(address to, uint256 amount, bytes32 refId) external onlyOperator whenNotPaused nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        token.safeTransfer(to, amount);
        emit Withdrawn(to, amount, refId, msg.sender);
    }

    /// @notice Rotates the hot operator key. Owner-only, so a compromised
    /// or rotated backend key never requires redeploying the vault.
    function setOperator(address newOperator) external onlyOwner {
        if (newOperator == address(0)) revert ZeroAddress();
        emit OperatorUpdated(operator, newOperator);
        operator = newOperator;
    }

    /// @notice Emergency stop. Pauses BOTH deposit and withdraw - a paused
    /// vault takes no further deposits and pays out nothing until
    /// unpaused, which is the safer default while investigating an
    /// incident (an operator-authorized withdraw is the same function an
    /// attacker with a leaked operator key would call, so it must be
    /// stoppable too, not just deposits).
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function poolBalance() external view returns (uint256) {
        return token.balanceOf(address(this));
    }
}
