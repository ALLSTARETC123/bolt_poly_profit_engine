// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IBalancerVault {
    function flashLoan(address recipient, address[] memory tokens, uint256[] memory amounts, bytes memory userData) external;
}

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function decimals() external view returns (uint8);
}

interface IUniswapV2Router {
    function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts);
}

interface IUniswapV3Router {
    function exactInputSingle(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) external returns (uint256 amountOut);
}

contract FlashArbExecutor {
    address public balancerVault;
    address public v3Router;
    address public feeToken;
    address public owner;

    uint256 public totalProfit;
    uint256 public gasReserve;

    mapping(string => address) public v2Routers;
    mapping(address => uint256) public nonces;

    uint256 private locked = 1;

    // Profit distribution: 90% owner, 10% gas reserve
    uint256 constant OWNER_SHARE = 90;
    uint256 constant RESERVE_SHARE = 10;

    event ArbExecuted(address indexed asset, uint256 borrowed, uint256 profit, uint256 toOwner, uint256 toReserve, uint8 provider);
    event RouterSet(string name, address router);
    event OwnerInitialized(address owner);
    event GasReplenished(uint256 amount);

    modifier onlyOwner() { require(msg.sender == owner, "Not owner"); _; }
    modifier nonReentrant() { require(locked == 1, "Reentrant"); locked = 2; _; locked = 1; }

    constructor(address _balancerVault, address _v3Router, address _feeToken, address) {
        balancerVault = _balancerVault;
        v3Router = _v3Router;
        feeToken = _feeToken;
    }

    function initializeOwner(address _owner) external {
        require(owner == address(0), "Owner already set");
        owner = _owner;
        emit OwnerInitialized(_owner);
    }

    function setV2Router(string memory name, address router) external onlyOwner {
        v2Routers[name] = router;
        emit RouterSet(name, router);
    }

    function setV3Router(address router) external onlyOwner {
        v3Router = router;
    }

    function executeArb(address asset, uint256 amount, bytes calldata params) external onlyOwner nonReentrant {
        _executeArb(asset, amount, params);
    }

    function _executeArb(address asset, uint256 amount, bytes memory params) internal {
        (, , string[] memory dexNames, address[] memory tokenPath, uint24[] memory v3Fees) =
            abi.decode(params, (uint8, address, string[], address[], uint24[]));

        address[] memory tokens = new address[](1);
        tokens[0] = asset;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = amount;
        IBalancerVault(balancerVault).flashLoan(address(this), tokens, amounts, abi.encode(dexNames, tokenPath, v3Fees));
    }

    function receiveFlashLoan(address[] memory tokens, uint256[] memory amounts, uint256[] memory feeAmounts, bytes memory userData) external nonReentrant {
        require(msg.sender == balancerVault, "Not vault");
        require(feeAmounts[0] == 0, "Balancer fee not zero");

        address asset = tokens[0];
        uint256 borrowed = amounts[0];
        (string[] memory dexNames, address[] memory tokenPath, uint24[] memory v3Fees) =
            abi.decode(userData, (string[], address[], uint24[]));

        uint256 startBalance = IERC20(asset).balanceOf(address(this));
        _executeSwaps(asset, borrowed, dexNames, tokenPath, v3Fees);
        uint256 endBalance = IERC20(asset).balanceOf(address(this));

        require(endBalance >= borrowed, "Not enough to repay");
        uint256 profit = endBalance - borrowed;

        IERC20(asset).transfer(balancerVault, borrowed);

        if (profit > 0) _distributeProfit(asset, profit);
        emit ArbExecuted(asset, borrowed, profit, 0, 0, 0);
    }

    function _executeSwaps(
        address asset, uint256 amount,
        string[] memory dexNames, address[] memory tokenPath, uint24[] memory v3Fees
    ) internal {
        uint256 currentAmount = amount;
        address currentToken = asset;

        for (uint256 i = 0; i < tokenPath.length - 1; i++) {
            address nextToken = tokenPath[i + 1];
            address router = v2Routers[dexNames[i]];

            if (router != address(0)) {
                address[] memory path = new address[](2);
                path[0] = currentToken;
                path[1] = nextToken;
                IERC20(currentToken).approve(router, currentAmount);
                uint[] memory amounts = IUniswapV2Router(router).swapExactTokensForTokens(
                    currentAmount, 0, path, address(this), block.timestamp + 300
                );
                currentAmount = amounts[amounts.length - 1];
            } else if (v3Router != address(0)) {
                IERC20(currentToken).approve(v3Router, currentAmount);
                uint24 fee = v3Fees.length > i ? v3Fees[i] : 3000;
                currentAmount = IUniswapV3Router(v3Router).exactInputSingle(
                    currentToken, nextToken, fee, address(this), currentAmount, 0, 0
                );
            }
            currentToken = nextToken;
        }
    }

    function _distributeProfit(address asset, uint256 profit) internal {
        uint256 toOwner = (profit * OWNER_SHARE) / 100;
        uint256 toReserve = profit - toOwner;

        if (toOwner > 0) IERC20(asset).transfer(owner, toOwner);
        gasReserve += toReserve;
        totalProfit += profit;
    }

    function withdrawReserve(address to) external onlyOwner {
        uint256 balance = IERC20(feeToken).balanceOf(address(this));
        IERC20(feeToken).transfer(to, balance);
    }

    receive() external payable {}
}

contract FlashArbFactory {
    mapping(address => address[]) public userContracts;

    event ExecutorDeployed(address indexed user, address executor);

    function deployExecutor(
        address balancerVault, address v3Router, address feeToken, address
    ) external returns (address) {
        FlashArbExecutor executor = new FlashArbExecutor(balancerVault, v3Router, feeToken, address(0));
        executor.initializeOwner(msg.sender);
        userContracts[msg.sender].push(address(executor));
        emit ExecutorDeployed(msg.sender, address(executor));
        return address(executor);
    }
}
