// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IFlashLoanReceiver {
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool);
}

interface IPool {
    function flashLoanSimple(
        address receiver,
        address asset,
        uint256 amount,
        bytes calldata params
    ) external;
}

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IUniswapV2Router {
    function swapExactTokensForTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external returns (uint[] memory amounts);
    function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts);
}

interface IUniswapV3Router {
    function exactInputSingle(
        ExactInputSingleParams calldata params
    ) external payable returns (uint256 amountOut);
}

struct ExactInputSingleParams {
    address tokenIn;
    address tokenOut;
    uint24 fee;
    address recipient;
    uint256 deadline;
    uint256 amountIn;
    uint256 amountOutMinimum;
    uint160 sqrtPriceLimitX96;
}

/**
 * @title FlashArbExecutor
 * @notice Executes flash loan arbitrage: borrows from Aave V3, swaps through
 *         DEXes, repays loan + fee, keeps profit in the contract (treasury).
 *         Anyone can call executeArb but only owner can withdraw profits.
 */
contract FlashArbExecutor {
    address public owner;
    address public aavePool;
    uint256 public totalProfit;

    // Supported DEX routers
    mapping(string => address) public v2Routers;
    address public v3Router;

    event ArbExecuted(
        address indexed asset,
        uint256 amountBorrowed,
        uint256 amountReturned,
        uint256 profit,
        bytes32 txHash
    );

    event ArbFailed(string reason);

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    constructor(address _aavePool, address _v3Router) {
        owner = msg.sender;
        aavePool = _aavePool;
        v3Router = _v3Router;
    }

    function setV2Router(string memory name, address router) external onlyOwner {
        v2Routers[name] = router;
    }

    function setV3Router(address router) external onlyOwner {
        v3Router = router;
    }

    struct ArbParams {
        string[] dexNames;     // Which DEX to use for each hop
        address[] tokenPath;   // Token addresses for the route
        uint24[] v3Fees;       // Fee tiers for V3 hops (0 = use V2)
        uint256 minProfit;     // Minimum profit to keep (slippage protection)
    }

    /**
     * @notice Execute an arbitrage using a flash loan from Aave V3
     * @param asset The token to flash loan
     * @param amount The amount to flash loan
     * @param params Encoded ArbParams
     */
    function executeArb(
        address asset,
        uint256 amount,
        bytes calldata params
    ) external {
        IPool pool = IPool(aavePool);
        pool.flashLoanSimple(address(this), asset, amount, params);
    }

    /**
     * @notice Called by Aave V3 after the flash loan is sent.
     *         Executes the swaps and repays the loan.
     */
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        require(msg.sender == aavePool, "Caller is not Aave pool");

        ArbParams memory arbParams = abi.decode(params, (ArbParams));

        uint256 currentAmount = amount;
        address currentToken = asset;

        // Execute each swap in the path
        for (uint i = 0; i < arbParams.tokenPath.length - 1; i++) {
            address tokenOut = arbParams.tokenPath[i + 1];
            string memory dexName = arbParams.dexNames[i];
            uint24 fee = arbParams.v3Fees.length > i ? arbParams.v3Fees[i] : 0;

            uint256 amountOut;

            if (fee > 0 && v3Router != address(0)) {
                // Use Uniswap V3
                IERC20(currentToken).approve(v3Router, currentAmount);
                ExactInputSingleParams memory v3Params = ExactInputSingleParams({
                    tokenIn: currentToken,
                    tokenOut: tokenOut,
                    fee: fee,
                    recipient: address(this),
                    deadline: block.timestamp + 300,
                    amountIn: currentAmount,
                    amountOutMinimum: 0,
                    sqrtPriceLimitX96: 0
                });
                amountOut = IUniswapV3Router(v3Router).exactInputSingle(v3Params);
            } else {
                // Use Uniswap V2 compatible
                address router = v2Routers[dexName];
                require(router != address(0), "V2 router not set");

                IERC20(currentToken).approve(router, currentAmount);

                address[] memory path = new address[](2);
                path[0] = currentToken;
                path[1] = tokenOut;

                uint[] memory amounts = IUniswapV2Router(router).swapExactTokensForTokens(
                    currentAmount,
                    0,
                    path,
                    address(this),
                    block.timestamp + 300
                );
                amountOut = amounts[amounts.length - 1];
            }

            currentAmount = amountOut;
            currentToken = tokenOut;
        }

        // Calculate profit
        uint256 amountToReturn = amount + premium;
        require(currentAmount > amountToReturn, "Not profitable");

        uint256 profit = currentAmount - amountToReturn;

        // Repay the flash loan
        IERC20(asset).approve(aavePool, amountToReturn);

        // Keep profit in the contract as treasury
        totalProfit += profit;

        emit ArbExecuted(asset, amount, amountToReturn, profit, bytes32(0));

        return true;
    }

    /**
     * @notice Withdraw accumulated profits to the owner wallet
     * @param token The token to withdraw
     * @param to The address to send to
     */
    function withdrawProfit(address token, address to) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(balance > 0, "No balance");
        IERC20(token).transfer(to, balance);
    }

    /**
     * @notice Withdraw all of a specific token
     */
    function withdrawToken(address token, address to, uint256 amount) external onlyOwner {
        IERC20(token).transfer(to, amount);
    }

    /**
     * @notice Get the contract's balance of a token
     */
    function getBalance(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    receive() external payable {}
}
