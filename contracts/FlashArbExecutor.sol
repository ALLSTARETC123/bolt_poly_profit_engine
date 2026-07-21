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
    function swapTokensForExactTokens(uint amountOut, uint amountInMax, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts);
}

interface IUniswapV3Router {
    function exactInputSingle(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) external returns (uint256 amountOut);
    function exactInput(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, bytes memory path) external returns (uint256 amountOut);
}

interface IDODO {
    function flashLoan(uint256 baseAmount, uint256 quoteAmount, address asset, bytes calldata data) external;
}

contract FlashArbExecutor {
    address public balancerVault;
    address public v3Router;
    address public feeToken;
    address public gelatoFeeCollector;
    address public gelatoRelayer;
    address public owner;

    uint256 public totalProfit;
    uint256 public gasReserve;
    uint256 public totalGasFeesPaid;

    mapping(string => address) public v2Routers;
    mapping(address => uint256) public nonces;

    // Profit distribution: 85% owner, 5% Gelato fee, 10% gas reserve
    uint256 constant OWNER_SHARE = 85;
    uint256 constant GELATO_SHARE = 5;
    uint256 constant RESERVE_SHARE = 10;

    event ArbExecuted(address indexed asset, uint256 borrowed, uint256 profit, uint256 toOwner, uint256 toGelato, uint256 toReserve, uint8 provider);
    event RouterSet(string name, address router);
    event OwnerInitialized(address owner);
    event GasReplenished(uint256 amount);

    modifier onlyOwner() { require(msg.sender == owner, "Not owner"); _; }
    modifier onlyGelato() { require(msg.sender == gelatoRelayer, "Not gelato"); _; }

    constructor(address _balancerVault, address _v3Router, address _feeToken, address _gelatoFeeCollector) {
        balancerVault = _balancerVault;
        v3Router = _v3Router;
        feeToken = _feeToken;
        gelatoFeeCollector = _gelatoFeeCollector;
    }

    function initializeOwner(address _owner) external {
        require(owner == address(0), "Owner already set");
        owner = _owner;
        emit OwnerInitialized(_owner);
    }

    function setGelatoRelayer(address _relayer) external onlyOwner {
        gelatoRelayer = _relayer;
    }

    function setV2Router(string memory name, address router) external onlyOwner {
        v2Routers[name] = router;
        emit RouterSet(name, router);
    }

    function setV3Router(address router) external onlyOwner {
        v3Router = router;
    }

    // ── EIP-712 Gasless Execution ──────────────────────────
    function executeArbWithSig(
        address asset, uint256 amount, bytes calldata params,
        uint256 deadline, uint8 v, bytes32 r, bytes32 s
    ) external {
        require(block.timestamp <= deadline, "Expired");
        bytes32 structHash = keccak256(abi.encode(
            keccak256("ExecuteArb(address asset,uint256 amount,bytes params,uint256 nonce,uint256 deadline)"),
            asset, amount, keccak256(params), nonces[msg.sender], deadline
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        address signer = ecrecover(digest, v, r, s);
        require(signer != address(0) && signer == owner, "Invalid signature");
        nonces[signer]++;
        _executeArb(asset, amount, params);
    }

    function executeArb(address asset, uint256 amount, bytes calldata params) external onlyGelato {
        _executeArb(asset, amount, params);
    }

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("FlashArbExecutor"), keccak256("1"), block.chainid, address(this)
        ));
    }

    function _executeArb(address asset, uint256 amount, bytes memory params) internal {
        (uint8 provider, address dodoPool, string[] memory dexNames, address[] memory tokenPath, uint24[] memory v3Fees) =
            abi.decode(params, (uint8, address, string[], address[], uint24[]));

        if (provider == 1 && dodoPool != address(0)) {
            // DODO V2 flash loan
            IDODO(dodoPool).flashLoan(amount, 0, asset, abi.encode(asset, amount, dexNames, tokenPath, v3Fees));
        } else {
            // Balancer V2 flash loan
            address[] memory tokens = new address[](1);
            tokens[0] = asset;
            uint256[] memory amounts = new uint256[](1);
            amounts[0] = amount;
            IBalancerVault(balancerVault).flashLoan(address(this), tokens, amounts, abi.encode(dexNames, tokenPath, v3Fees));
        }
    }

    // ── Balancer V2 Callback ───────────────────────────────
    function receiveFlashLoan(address[] memory tokens, uint256[] memory amounts, uint256[] memory feeAmounts, bytes memory userData) external {
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
        emit ArbExecuted(asset, borrowed, profit, 0, 0, 0, 0);
    }

    // ── DODO V2 Callback ───────────────────────────────────
    function DVMFlashLoanCall(address sender, uint256 baseAmount, uint256 quoteAmount, bytes memory data) external {
        _dodoCallback(baseAmount, data);
    }

    function DPPFlashLoanCall(address sender, uint256 baseAmount, uint256 quoteAmount, bytes memory data) external {
        _dodoCallback(baseAmount, data);
    }

    function DSPFlashLoanCall(address sender, uint256 baseAmount, uint256 quoteAmount, bytes memory data) external {
        _dodoCallback(baseAmount, data);
    }

    function _dodoCallback(uint256 borrowed, bytes memory data) internal {
        (address asset, uint256 amount, string[] memory dexNames, address[] memory tokenPath, uint24[] memory v3Fees) =
            abi.decode(data, (address, uint256, string[], address[], uint24[]));

        uint256 startBalance = IERC20(asset).balanceOf(address(this));
        _executeSwaps(asset, borrowed, dexNames, tokenPath, v3Fees);
        uint256 endBalance = IERC20(asset).balanceOf(address(this));

        require(endBalance >= borrowed, "Not enough to repay");
        uint256 profit = endBalance - borrowed;

        IERC20(asset).transfer(msg.sender, borrowed);

        if (profit > 0) _distributeProfit(asset, profit);
        emit ArbExecuted(asset, borrowed, profit, 0, 0, 0, 1);
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
                // Uniswap V2 style swap
                address[] memory path = new address[](2);
                path[0] = currentToken;
                path[1] = nextToken;
                IERC20(currentToken).approve(router, currentAmount);
                uint[] memory amounts = IUniswapV2Router(router).swapExactTokensForTokens(
                    currentAmount, 0, path, address(this), block.timestamp + 300
                );
                currentAmount = amounts[amounts.length - 1];
            } else if (v3Router != address(0)) {
                // Uniswap V3 style swap
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
        uint256 toGelato = (profit * GELATO_SHARE) / 100;
        uint256 toReserve = profit - toOwner - toGelato;

        // Pay owner in flash loan asset
        if (toOwner > 0) IERC20(asset).transfer(owner, toOwner);

        // Pay Gelato fee in fee token (USDC)
        if (toGelato > 0 && feeToken != address(0)) {
            // Try to swap profit asset to fee token, or send directly if same
            if (asset == feeToken) {
                IERC20(feeToken).transfer(gelatoFeeCollector, toGelato);
            } else {
                // Send asset to fee collector (Gelato handles conversion)
                IERC20(asset).transfer(gelatoFeeCollector, toGelato);
            }
            totalGasFeesPaid += toGelato;
        }

        // Keep reserve in contract
        gasReserve += toReserve;
        totalProfit += profit;
    }

    function replenishGasTank() external onlyOwner {
        require(gasReserve > 0, "No reserve");
        uint256 amount = gasReserve;
        gasReserve = 0;
        IERC20(feeToken).transfer(gelatoFeeCollector, amount);
        emit GasReplenished(amount);
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
        address balancerVault, address v3Router, address feeToken, address gelatoFeeCollector
    ) external returns (address) {
        FlashArbExecutor executor = new FlashArbExecutor(balancerVault, v3Router, feeToken, gelatoFeeCollector);
        executor.initializeOwner(msg.sender);
        userContracts[msg.sender].push(address(executor));
        emit ExecutorDeployed(msg.sender, address(executor));
        return address(executor);
    }
}
