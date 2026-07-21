// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function decimals() external view returns (uint8);
}

interface IBalancerVault {
    function flashLoan(
        address recipient,
        address[] memory tokens,
        uint256[] memory amounts,
        bytes memory userData
    ) external;
    function receiveFlashLoan(
        address[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external;
}

interface IDODO {
    function flashLoan(
        uint256 baseAmount,
        uint256 quoteAmount,
        address assetTo,
        bytes calldata data
    ) external;
    function _BASE_TOKEN_() external view returns (address);
    function _QUOTE_TOKEN_() external view returns (address);
}

interface IUniswapV2Router {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;
    function factory() external view returns (address);
}

interface IUniswapV3Router {
    function exactInputSingle(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256 amountOut);
    function exactInput(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256 amountOut);
}

/// @title FlashArbExecutor — Dual-provider flash loan arbitrage executor
/// @notice Supports Balancer V2 (0% fee) and DODO V2 (0% fee) flash loans.
///         100% of profit is sent directly to the owner wallet. No reinvestment.
///         Self-funding gas: 10% of profit allocated to gas reserve, rest to owner.
///         Private mempool compatible: all state changes in single transaction.
contract FlashArbExecutor {
    address public owner;
    address public balancerVault;
    address public v3Router;

    mapping(string => address) public v2Routers;
    string[] private v2RouterNames;

    uint256 public totalProfit;
    uint256 public gasReserve;

    uint256 public constant GAS_RESERVE_PERCENT = 10; // 10% of profit to gas reserve
    uint256 public constant MAX_SLIPPAGE_BPS = 9900; // 1% max slippage

    enum FlashProvider { BALANCER_V2, DODO_V2 }

    struct ArbParams {
        FlashProvider provider;
        address dodoPool;      // DODO pool to flash loan from (if DODO_V2)
        string[] dexNames;     // DEX names for each hop
        address[] tokenPath;   // Token addresses for the route
        uint24[] v3Fees;       // V3 fee tiers (0 for V2 hops)
    }

    event ArbExecuted(
        address indexed asset,
        uint256 amountBorrowed,
        uint256 amountReturned,
        uint256 profit,
        uint256 toOwner,
        uint256 gasReserveAfter,
        FlashProvider provider
    );
    event ArbFailed(string reason);
    event GasReserveUsed(uint256 amount, address indexed to);
    event ProfitWithdrawn(address indexed token, address indexed to, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    constructor(address _balancerVault, address _v3Router) {
        owner = msg.sender;
        balancerVault = _balancerVault;
        v3Router = _v3Router;
    }

    // ──────────────────────────────────────────────────────────
    //  Configuration
    // ──────────────────────────────────────────────────────────

    function setV2Router(string calldata name, address router) external onlyOwner {
        if (v2Routers[name] == address(0)) {
            v2RouterNames.push(name);
        }
        v2Routers[name] = router;
    }

    function setV3Router(address router) external onlyOwner {
        v3Router = router;
    }

    function setBalancerVault(address vault) external onlyOwner {
        balancerVault = vault;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        owner = newOwner;
    }

    // ──────────────────────────────────────────────────────────
    //  Execution entry point
    // ──────────────────────────────────────────────────────────

    function executeArb(
        address asset,
        uint256 amount,
        bytes calldata params
    ) external onlyOwner {
        ArbParams memory arb = decodeParams(params);

        if (arb.provider == FlashProvider.BALANCER_V2) {
            _balancerFlashLoan(asset, amount, arb);
        } else {
            _dodoFlashLoan(asset, amount, arb);
        }
    }

    // ──────────────────────────────────────────────────────────
    //  Balancer V2 flash loan (0% fee)
    // ──────────────────────────────────────────────────────────

    function _balancerFlashLoan(address asset, uint256 amount, ArbParams memory arb) internal {
        address[] memory tokens = new address[](1);
        tokens[0] = asset;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = amount;

        bytes memory userData = abi.encode(arb, asset, amount);

        IBalancerVault(balancerVault).flashLoan(address(this), tokens, amounts, userData);
    }

    /// @notice Balancer V2 callback — receives tokens, executes arb, returns loan
    function receiveFlashLoan(
        address[] calldata tokens,
        uint256[] calldata amounts,
        uint256[] calldata feeAmounts,
        bytes calldata userData
    ) external {
        require(msg.sender == balancerVault, "NOT_VAULT");
        require(feeAmounts[0] == 0, "BALANCER_FEE_NOT_ZERO");

        (ArbParams memory arb, address asset, uint256 amount) =
            abi.decode(userData, (ArbParams, address, uint256));

        uint256 balanceBefore = IERC20(asset).balanceOf(address(this));
        require(balanceBefore >= amount, "FLASH_LOAN_NOT_RECEIVED");

        _executeSwaps(arb, asset, amount);

        uint256 balanceAfter = IERC20(asset).balanceOf(address(this));
        require(balanceAfter >= amount, "INSUFFICIENT_RETURN");

        // Return the flash loan
        IERC20(asset).transfer(balancerVault, amount);

        // Process profit
        uint256 profit = balanceAfter - amount;
        if (profit > 0) {
            _distributeProfit(asset, profit);
        }

        emit ArbExecuted(asset, amount, balanceAfter, profit, 0, gasReserve, FlashProvider.BALANCER_V2);
    }

    // ──────────────────────────────────────────────────────────
    //  DODO V2 flash loan (0% fee)
    // ──────────────────────────────────────────────────────────

    function _dodoFlashLoan(address asset, uint256 amount, ArbParams memory arb) internal {
        address pool = arb.dodoPool;
        require(pool != address(0), "NO_DODO_POOL");

        address baseToken = IDODO(pool)._BASE_TOKEN_();
        address quoteToken = IDODO(pool)._QUOTE_TOKEN_();

        bytes memory data = abi.encode(arb, asset, amount);

        if (asset == baseToken) {
            IDODO(pool).flashLoan(amount, 0, address(this), data);
        } else if (asset == quoteToken) {
            IDODO(pool).flashLoan(0, amount, address(this), data);
        } else {
            revert("ASSET_NOT_IN_DODO_POOL");
        }
    }

    /// @notice DODO V2 DVM callback
    function DVMFlashLoanCall(
        address sender,
        uint256 baseAmount,
        uint256 quoteAmount,
        bytes calldata data
    ) external {
        _dodoCallback(sender, baseAmount, quoteAmount, data);
    }

    /// @notice DODO V2 DPP callback
    function DPPFlashLoanCall(
        address sender,
        uint256 baseAmount,
        uint256 quoteAmount,
        bytes calldata data
    ) external {
        _dodoCallback(sender, baseAmount, quoteAmount, data);
    }

    /// @notice DODO V2 DSP callback
    function DSPFlashLoanCall(
        address sender,
        uint256 baseAmount,
        uint256 quoteAmount,
        bytes calldata data
    ) external {
        _dodoCallback(sender, baseAmount, quoteAmount, data);
    }

    function _dodoCallback(
        address sender,
        uint256 baseAmount,
        uint256 quoteAmount,
        bytes calldata data
    ) internal {
        (ArbParams memory arb, address asset, uint256 amount) =
            abi.decode(data, (ArbParams, address, uint256));

        require(sender == address(this), "HANDLE_FLASH_DENIED");
        require(msg.sender == arb.dodoPool, "NOT_DODO_POOL");

        uint256 loanAmount = baseAmount > 0 ? baseAmount : quoteAmount;

        uint256 balanceBefore = IERC20(asset).balanceOf(address(this));
        require(balanceBefore >= loanAmount, "FLASH_LOAN_NOT_RECEIVED");

        _executeSwaps(arb, asset, loanAmount);

        uint256 balanceAfter = IERC20(asset).balanceOf(address(this));
        require(balanceAfter >= loanAmount, "INSUFFICIENT_RETURN");

        // Return the flash loan to the DODO pool
        IERC20(asset).transfer(arb.dodoPool, loanAmount);

        // Process profit
        uint256 profit = balanceAfter - loanAmount;
        if (profit > 0) {
            _distributeProfit(asset, profit);
        }

        emit ArbExecuted(asset, loanAmount, balanceAfter, profit, 0, gasReserve, FlashProvider.DODO_V2);
    }

    // ──────────────────────────────────────────────────────────
    //  Swap execution — routes through configured DEXes
    // ──────────────────────────────────────────────────────────

    function _executeSwaps(ArbParams memory arb, address startAsset, uint256 amount) internal {
        uint256 currentAmount = amount;
        address currentToken = startAsset;

        for (uint256 i = 0; i < arb.tokenPath.length - 1; i++) {
            address nextToken = arb.tokenPath[i + 1];
            uint24 fee = arb.v3Fees.length > i ? arb.v3Fees[i] : 0;

            if (fee > 0 && v3Router != address(0)) {
                currentAmount = _swapV3(currentToken, nextToken, fee, currentAmount);
            } else {
                string memory dexName = arb.dexNames.length > i ? arb.dexNames[i] : "";
                address router = v2Routers[dexName];
                require(router != address(0), "V2_ROUTER_NOT_SET");
                currentAmount = _swapV2(router, currentToken, nextToken, currentAmount);
            }

            currentToken = nextToken;
        }

        // Final swap back to start asset if last token != start asset
        if (currentToken != startAsset) {
            uint24 lastFee = arb.v3Fees.length > arb.tokenPath.length - 1
                ? arb.v3Fees[arb.tokenPath.length - 1] : 0;
            string memory lastDex = arb.dexNames.length > arb.tokenPath.length - 1
                ? arb.dexNames[arb.tokenPath.length - 1] : "";

            if (lastFee > 0 && v3Router != address(0)) {
                currentAmount = _swapV3(currentToken, startAsset, lastFee, currentAmount);
            } else {
                address router = v2Routers[lastDex];
                require(router != address(0), "FINAL_V2_ROUTER_NOT_SET");
                currentAmount = _swapV2(router, currentToken, startAsset, currentAmount);
            }
        }
    }

    function _swapV2(
        address router,
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    ) internal returns (uint256) {
        IERC20(tokenIn).approve(router, amountIn);

        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;

        uint256 balanceBefore = IERC20(tokenOut).balanceOf(address(this));

        IUniswapV2Router(router).swapExactTokensForTokensSupportingFeeOnTransferTokens(
            amountIn,
            0, // Accept any amount (profit check is done after all swaps)
            path,
            address(this),
            block.timestamp + 300
        );

        uint256 received = IERC20(tokenOut).balanceOf(address(this)) - balanceBefore;
        return received;
    }

    function _swapV3(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn
    ) internal returns (uint256) {
        IERC20(tokenIn).approve(v3Router, amountIn);

        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;

        uint256 balanceBefore = IERC20(tokenOut).balanceOf(address(this));

        IUniswapV3Router(v3Router).exactInput(
            amountIn,
            0,
            path,
            address(this),
            block.timestamp + 300
        );

        uint256 received = IERC20(tokenOut).balanceOf(address(this)) - balanceBefore;
        return received;
    }

    // ──────────────────────────────────────────────────────────
    //  Profit distribution — 100% to owner, 10% to gas reserve
    // ──────────────────────────────────────────────────────────

    function _distributeProfit(address token, uint256 profit) internal {
        uint256 reserveAmount = (profit * GAS_RESERVE_PERCENT) / 100;
        uint256 ownerAmount = profit - reserveAmount;

        gasReserve += reserveAmount;
        totalProfit += profit;

        // Send 90% directly to owner wallet — no reinvestment
        if (ownerAmount > 0) {
            IERC20(token).transfer(owner, ownerAmount);
        }

        emit ArbExecuted(token, 0, 0, profit, ownerAmount, gasReserve, FlashProvider.BALANCER_V2);
    }

    // ──────────────────────────────────────────────────────────
    //  Gas reserve — self-funding mechanism
    // ──────────────────────────────────────────────────────────

    function useGasReserve(address wrappedNative, uint256 amount) external onlyOwner {
        require(amount <= gasReserve, "INSUFFICIENT_RESERVE");
        require(gasReserve > 0, "NO_RESERVE");

        uint256 useAmount = amount == 0 ? gasReserve : amount;
        if (useAmount > gasReserve) useAmount = gasReserve;

        // Transfer wrapped native to owner for unwrapping to gas
        IERC20(wrappedNative).transfer(owner, useAmount);
        gasReserve -= useAmount;

        emit GasReserveUsed(useAmount, owner);
    }

    // ──────────────────────────────────────────────────────────
    //  Withdrawal
    // ──────────────────────────────────────────────────────────

    function withdrawProfit(address token, address to) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(balance > 0, "NO_BALANCE");

        IERC20(token).transfer(to, balance);
        emit ProfitWithdrawn(token, to, balance);
    }

    function withdrawToken(address token, address to, uint256 amount) external onlyOwner {
        IERC20(token).transfer(to, amount);
        emit ProfitWithdrawn(token, to, amount);
    }

    // ──────────────────────────────────────────────────────────
    //  View functions
    // ──────────────────────────────────────────────────────────

    function getBalance(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    function getV2RouterNames() external view returns (string[] memory) {
        return v2RouterNames;
    }

    // ──────────────────────────────────────────────────────────
    //  Decoding
    // ──────────────────────────────────────────────────────────

    function decodeParams(bytes calldata params) internal pure returns (ArbParams memory) {
        (
            uint8 provider,
            address dodoPool,
            string[] memory dexNames,
            address[] memory tokenPath,
            uint24[] memory v3Fees
        ) = abi.decode(params, (uint8, address, string[], address[], uint24[]));

        return ArbParams({
            provider: FlashProvider(provider),
            dodoPool: dodoPool,
            dexNames: dexNames,
            tokenPath: tokenPath,
            v3Fees: v3Fees
        });
    }

    // Allow receiving native tokens
    receive() external payable {}
}
