// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IBalancerVault {
    function flashLoan(
        address recipient,
        address[] memory tokens,
        uint256[] memory amounts,
        bytes memory userData
    ) external;
}

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function deposit(uint256 amount, address to) external;
    function withdraw(uint256 amount, address to) external;
}

interface IUniswapV2Router {
    function swapExactTokensForTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external returns (uint[] memory amounts);
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
 * @notice Zero-fee flash loan arbitrage executor using Balancer V2 Vault.
 *         Borrows tokens for free, executes multi-hop swaps across DEXes,
 *         repays the loan, and keeps 100% of profit in the contract (treasury).
 *         Accumulated profit can be used to pay for gas on future transactions.
 *
 * Flash loan providers used (all 0% fee):
 *   - Balancer V2 Vault: 0xBA12222222228d8Ba445958a75a0704D566BF2C8
 *   - (Aave V3 available as fallback, 0.05% fee)
 *
 * The contract is designed to be deployed once per chain and then
 * called by the off-chain engine to execute arbitrage.
 */
contract FlashArbExecutor {
    address public owner;
    address public balancerVault;
    uint256 public totalProfit;
    uint256 public gasReserve; // Accumulated gas money from profits

    // Supported DEX routers
    mapping(string => address) public v2Routers;
    address public v3Router;

    event ArbExecuted(
        address indexed asset,
        uint256 amountBorrowed,
        uint256 amountReturned,
        uint256 profit,
        uint256 gasReserveAfter
    );

    event ArbFailed(string reason);

    event GasReserveUsed(uint256 amount, address indexed to);

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    constructor(address _balancerVault, address _v3Router) {
        owner = msg.sender;
        balancerVault = _balancerVault;
        v3Router = _v3Router;
    }

    function setV2Router(string memory name, address router) external onlyOwner {
        v2Routers[name] = router;
    }

    function setV3Router(address router) external onlyOwner {
        v3Router = router;
    }

    function setBalancerVault(address vault) external onlyOwner {
        balancerVault = vault;
    }

    struct ArbParams {
        string[] dexNames;
        address[] tokenPath;     // Full route: [borrowToken, ...intermediates, repayToken]
        uint24[] v3Fees;         // Fee tiers for V3 hops (0 = use V2)
    }

    /**
     * @notice Execute an arbitrage using a zero-fee flash loan from Balancer V2.
     *         The route is: borrow token -> swap through DEXes -> repay same token.
     *         Profit stays in the contract.
     */
    function executeArb(
        address asset,
        uint256 amount,
        bytes calldata params
    ) external {
        address[] memory tokens = new address[](1);
        tokens[0] = asset;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = amount;

        IBalancerVault vault = IBalancerVault(balancerVault);
        vault.flashLoan(address(this), tokens, amounts, params);
    }

    /**
     * @notice Called by Balancer V2 after sending flash loaned tokens.
     *         Executes swaps and repays the loan. 0% fee from Balancer.
     */
    function receiveFlashLoan(
        address[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external {
        require(msg.sender == balancerVault, "Caller is not Balancer vault");
        require(feeAmounts[0] == 0, "Balancer flash loan should be free");

        address asset = tokens[0];
        uint256 amount = amounts[0];

        ArbParams memory arbParams = abi.decode(userData, (ArbParams));

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

                uint[] memory swapAmounts = IUniswapV2Router(router).swapExactTokensForTokens(
                    currentAmount,
                    0,
                    path,
                    address(this),
                    block.timestamp + 300
                );
                amountOut = swapAmounts[swapAmounts.length - 1];
            }

            currentAmount = amountOut;
            currentToken = tokenOut;
        }

        // Calculate profit (Balancer charges 0% fee)
        uint256 amountToReturn = amount; // No fee from Balancer
        require(currentAmount > amountToReturn, "Not profitable");

        uint256 profit = currentAmount - amountToReturn;

        // Repay the flash loan (exact amount, no fee)
        IERC20(asset).approve(balancerVault, amountToReturn);

        // Keep profit in the contract as treasury
        totalProfit += profit;

        // Auto-allocate a portion of profit to gas reserve
        // Gas reserve = 10% of profit, used to pay for future transactions
        uint256 gasAllocation = profit / 10;
        gasReserve += gasAllocation;

        emit ArbExecuted(asset, amount, amountToReturn, profit, gasReserve);
    }

    /**
     * @notice Use accumulated gas reserve to send gas money to the owner wallet.
     *         This allows the system to self-fund its own gas from micro-profits.
     *         Converts WETH/WMATIC gas reserve to native token and sends to owner.
     */
    function useGasReserve(address wrappedNative, uint256 amount) external onlyOwner {
        require(gasReserve >= amount, "Insufficient gas reserve");
        require(IERC20(wrappedNative).balanceOf(address(this)) >= amount, "Insufficient balance");

        // Unwrap wrapped native to native
        IERC20(wrappedNative).withdraw(amount, address(this));

        // Send native to owner
        (bool success, ) = payable(owner).call{value: amount}("");
        require(success, "Transfer failed");

        gasReserve -= amount;

        emit GasReserveUsed(amount, owner);
    }

    /**
     * @notice Withdraw all profits (treasury) to the owner wallet.
     *         100% of accumulated profit goes to the owner.
     */
    function withdrawProfit(address token, address to) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(balance > 0, "No balance");
        IERC20(token).transfer(to, balance);
    }

    function withdrawToken(address token, address to, uint256 amount) external onlyOwner {
        IERC20(token).transfer(to, amount);
    }

    function getBalance(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    receive() external payable {}
}
