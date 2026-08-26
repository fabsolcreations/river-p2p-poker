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

    /// @notice Every `refId` this vault has already paid out against.
    ///
    /// This is what makes a withdrawal safely *retryable*. The backend
    /// broadcasts a payout and then waits for a receipt, and that wait can
    /// fail for reasons that say nothing about whether the transaction
    /// landed (RPC timeout, dropped response, worker eviction). Without an
    /// on-chain record the backend has to guess, and both guesses are
    /// wrong in a costly direction: refund a payout that actually went
    /// through, or strand a user's balance that never did.
    ///
    /// With this mapping the answer is authoritative and public - the
    /// backend reads `usedRefIds(refId)` to find out what really happened,
    /// and a retry of the same logical withdrawal reverts instead of
    /// paying twice.
    mapping(bytes32 => bool) public usedRefIds;

    /// @notice Largest single payout the operator may make. 0 disables the
    /// check. Bounds the damage from a leaked hot key to one transaction's
    /// worth rather than the entire pool.
    uint256 public maxWithdrawalPerTx;

    /// @notice Ceiling on payouts within a 24h window. 0 disables the check.
    ///
    /// This is a FIXED window, not a sliding one: it resets the first time a
    /// withdrawal lands more than a day after the window opened. An attacker
    /// timing a drain across a boundary could therefore move up to twice the
    /// limit. That is a deliberate trade - a true sliding window costs far
    /// more gas and storage, and the point here is to bound the loss and buy
    /// time to notice and `pause`, not to make theft impossible.
    uint256 public dailyWithdrawalLimit;
    uint256 public windowStart;
    uint256 public withdrawnInWindow;

    event Deposited(address indexed depositor, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount, bytes32 indexed refId, address indexed operator);
    event OperatorUpdated(address indexed previousOperator, address indexed newOperator);
    event LimitsUpdated(uint256 maxWithdrawalPerTx, uint256 dailyWithdrawalLimit);

    error ZeroAddress();
    error ZeroAmount();
    error NotOperator(address caller);
    error ZeroRefId();
    error RefIdAlreadyUsed(bytes32 refId);
    error ExceedsPerTxCap(uint256 amount, uint256 cap);
    error ExceedsDailyLimit(uint256 amount, uint256 remaining);

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator(msg.sender);
        _;
    }

    /// @param maxWithdrawalPerTx_ Per-payout ceiling; 0 disables.
    /// @param dailyWithdrawalLimit_ 24h ceiling; 0 disables.
    /// Both are constructor arguments rather than defaults so a deployment
    /// has to make a deliberate choice about blast radius.
    constructor(
        address token_,
        address operator_,
        address initialOwner,
        uint256 maxWithdrawalPerTx_,
        uint256 dailyWithdrawalLimit_
    ) Ownable(initialOwner) {
        if (token_ == address(0) || operator_ == address(0)) revert ZeroAddress();
        token = IERC20(token_);
        operator = operator_;
        maxWithdrawalPerTx = maxWithdrawalPerTx_;
        dailyWithdrawalLimit = dailyWithdrawalLimit_;
        windowStart = block.timestamp;
        emit OperatorUpdated(address(0), operator_);
        emit LimitsUpdated(maxWithdrawalPerTx_, dailyWithdrawalLimit_);
    }

    /// @notice Owner-only, so a compromised operator cannot raise its own
    /// ceiling. Takes effect immediately, including mid-window.
    function setLimits(uint256 maxWithdrawalPerTx_, uint256 dailyWithdrawalLimit_) external onlyOwner {
        maxWithdrawalPerTx = maxWithdrawalPerTx_;
        dailyWithdrawalLimit = dailyWithdrawalLimit_;
        emit LimitsUpdated(maxWithdrawalPerTx_, dailyWithdrawalLimit_);
    }

    /// @notice How much the operator may still withdraw in the current window.
    function remainingDailyAllowance() public view returns (uint256) {
        if (dailyWithdrawalLimit == 0) return type(uint256).max;
        if (block.timestamp >= windowStart + 1 days) return dailyWithdrawalLimit;
        if (withdrawnInWindow >= dailyWithdrawalLimit) return 0;
        return dailyWithdrawalLimit - withdrawnInWindow;
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
    /// Reverts on a `refId` that has already been paid, so retrying an
    /// ambiguous withdrawal is always safe - see `usedRefIds`.
    function withdraw(address to, uint256 amount, bytes32 refId) external onlyOperator whenNotPaused nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (refId == bytes32(0)) revert ZeroRefId();
        if (usedRefIds[refId]) revert RefIdAlreadyUsed(refId);
        if (maxWithdrawalPerTx != 0 && amount > maxWithdrawalPerTx) {
            revert ExceedsPerTxCap(amount, maxWithdrawalPerTx);
        }
        if (dailyWithdrawalLimit != 0) {
            if (block.timestamp >= windowStart + 1 days) {
                windowStart = block.timestamp;
                withdrawnInWindow = 0;
            }
            uint256 remaining = dailyWithdrawalLimit - withdrawnInWindow;
            if (amount > remaining) revert ExceedsDailyLimit(amount, remaining);
            withdrawnInWindow += amount;
        }
        usedRefIds[refId] = true;
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
