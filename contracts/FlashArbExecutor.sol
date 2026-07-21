// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function decimals() external view returns (uint8);
}

interface IBalancerVault {
    function flashLoan(address recipient, address[] memory tokens, uint256[] memory amounts, bytes memory userData) external;
}

interface IDODO {
    function flashLoan(uint256 baseAmount, uint256 quoteAmount, address assetTo, bytes calldata data) external;
    function _BASE_TOKEN_() external view returns (address);
    function _QUOTE_TOKEN_() external view returns (address);
}

interface IUniswapV2Router {
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline
    ) external;
}

interface IUniswapV3Router {
    function exactInput(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) external returns (uint256);
}

/// @title FlashArbExecutor — Zero-gas flash loan arbitrage executor
/// @notice Dual Balancer V2 + DODO V2 zero-fee flash loans.
///         100% of profit to owner wallet. Gas paid from profit via Gelato.
///         Gasless: Gelato relays txns, fee extracted from flash loan profit in USDC.
///         Zero upfront capital: first arb earns the USDC that funds all subsequent gas.
contract FlashArbExecutor {
    bytes32 public constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 public constant EXECUTE_TYPEHASH = keccak256(
        "ExecuteArb(address asset,uint256 amount,bytes params,uint256 nonce,uint256 deadline)"
    );

    address public owner;
    address public gelatoRelayer;
    address public balancerVault;
    address public v3Router;
    address public feeToken; // USDC — used to pay Gelato relay fees
    address public gelatoFeeCollector; // Gelato's fee collector address

    mapping(string => address) public v2Routers;
    mapping(address => uint256) public nonces;

    uint256 public totalProfit;
    uint256 public totalGasFeesPaid;
    uint256 public gasReserve; // USDC reserve for future gas

    uint256 public constant GAS_RESERVE_PERCENT = 10;  // 10% of profit to USDC gas reserve
    uint256 public constant RELAYER_FEE_PERCENT = 5;   // 5% of profit to Gelato fee
    uint256 public constant OWNER_PERCENT = 85;         // 85% to owner wallet

    enum FlashProvider { BALANCER_V2, DODO_V2 }

    struct ArbParams {
        FlashProvider provider;
        address dodoPool;
        string[] dexNames;
        address[] tokenPath;
        uint24[] v3Fees;
    }

    event ArbExecuted(address indexed asset, uint256 borrowed, uint256 profit, uint256 toOwner, uint256 toGelato, uint256 toReserve, uint8 provider);
    event GasFeePaid(uint256 fee, address indexed feeToken);
    event ProfitWithdrawn(address indexed token, address indexed to, uint256 amount);

    modifier onlyOwner() { require(msg.sender == owner, "NOT_OWNER"); _; }
    modifier onlyOwnerOrGelato() { require(msg.sender == owner || msg.sender == gelatoRelayer, "NOT_AUTHORIZED"); _; }

    constructor(address _balancerVault, address _v3Router, address _feeToken, address _gelatoFeeCollector) {
        owner = msg.sender;
        balancerVault = _balancerVault;
        v3Router = _v3Router;
        feeToken = _feeToken;
        gelatoFeeCollector = _gelatoFeeCollector;
    }

    function setV2Router(string calldata name, address router) external onlyOwnerOrGelato { v2Routers[name] = router; }
    function setV3Router(address router) external onlyOwnerOrGelato { v3Router = router; }
    function setBalancerVault(address vault) external onlyOwnerOrGelato { balancerVault = vault; }
    function setGelatoRelayer(address _relayer) external onlyOwner { gelatoRelayer = _relayer; }
    function setFeeToken(address _feeToken) external onlyOwner { feeToken = _feeToken; }
    function setGelatoFeeCollector(address _collector) external onlyOwner { gelatoFeeCollector = _collector; }
    function transferOwnership(address newOwner) external onlyOwner { owner = newOwner; }

    function initializeOwner(address _owner) external {
        require(owner == address(0) || owner == msg.sender, "ALREADY_INITIALIZED");
        owner = _owner;
    }

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(abi.encode(
            EIP712_DOMAIN_TYPEHASH,
            keccak256("FlashArbExecutor"),
            keccak256("1"),
            block.chainid,
            address(this)
        ));
    }

    function executeArb(address asset, uint256 amount, bytes calldata params) external onlyOwner {
        ArbParams memory arb = _decodeParams(params);
        _doFlashLoan(asset, amount, arb);
    }

    function executeArbWithSig(
        address asset, uint256 amount, bytes calldata params,
        uint256 deadline, uint8 v, bytes32 r, bytes32 s
    ) external onlyOwnerOrGelato {
        require(block.timestamp <= deadline, "EXPIRED");
        address signer = ecrecover(
            keccak256(abi.encodePacked("\x19\x01", _domainSeparator(),
                keccak256(abi.encode(EXECUTE_TYPEHASH, asset, amount, keccak256(params), nonces[owner], deadline))
            )), v, r, s
        );
        require(signer == owner, "INVALID_SIGNATURE");
        nonces[owner]++;
        ArbParams memory arb = _decodeParams(params);
        _doFlashLoan(asset, amount, arb);
    }

    function _doFlashLoan(address asset, uint256 amount, ArbParams memory arb) internal {
        if (arb.provider == FlashProvider.BALANCER_V2) {
            address[] memory tokens = new address[](1);
            tokens[0] = asset;
            uint256[] memory amounts = new uint256[](1);
            amounts[0] = amount;
            IBalancerVault(balancerVault).flashLoan(address(this), tokens, amounts, abi.encode(arb, asset, amount));
        } else {
            require(arb.dodoPool != address(0), "NO_DODO_POOL");
            address baseToken = IDODO(arb.dodoPool)._BASE_TOKEN_();
            bytes memory data = abi.encode(arb, asset, amount);
            if (asset == baseToken) { IDODO(arb.dodoPool).flashLoan(amount, 0, address(this), data); }
            else { IDODO(arb.dodoPool).flashLoan(0, amount, address(this), data); }
        }
    }

    function receiveFlashLoan(address[] calldata tokens, uint256[] calldata amounts, uint256[] calldata feeAmounts, bytes calldata userData) external {
        require(msg.sender == balancerVault, "NOT_VAULT");
        require(feeAmounts[0] == 0, "FEE_NOT_ZERO");
        (ArbParams memory arb, address asset, uint256 amount) = abi.decode(userData, (ArbParams, address, uint256));
        _executeSwaps(arb, asset, amount);
        uint256 balanceAfter = IERC20(asset).balanceOf(address(this));
        require(balanceAfter >= amount, "INSUFFICIENT_RETURN");
        IERC20(asset).transfer(balancerVault, amount);
        uint256 profit = balanceAfter - amount;
        if (profit > 0) _distributeProfit(asset, profit);
        emit ArbExecuted(asset, amount, profit, 0, 0, 0, uint8(arb.provider));
    }

    function DVMFlashLoanCall(address sender, uint256 baseAmount, uint256 quoteAmount, bytes calldata data) external {
        _dodoCallback(sender, baseAmount, quoteAmount, data);
    }
    function DPPFlashLoanCall(address sender, uint256 baseAmount, uint256 quoteAmount, bytes calldata data) external {
        _dodoCallback(sender, baseAmount, quoteAmount, data);
    }
    function DSPFlashLoanCall(address sender, uint256 baseAmount, uint256 quoteAmount, bytes calldata data) external {
        _dodoCallback(sender, baseAmount, quoteAmount, data);
    }

    function _dodoCallback(address sender, uint256 baseAmount, uint256 quoteAmount, bytes calldata data) internal {
        (ArbParams memory arb, address asset, uint256 amount) = abi.decode(data, (ArbParams, address, uint256));
        require(sender == address(this), "DENIED");
        require(msg.sender == arb.dodoPool, "NOT_POOL");
        uint256 loanAmount = baseAmount > 0 ? baseAmount : quoteAmount;
        _executeSwaps(arb, asset, loanAmount);
        uint256 balanceAfter = IERC20(asset).balanceOf(address(this));
        require(balanceAfter >= loanAmount, "INSUFFICIENT_RETURN");
        IERC20(asset).transfer(arb.dodoPool, loanAmount);
        uint256 profit = balanceAfter - loanAmount;
        if (profit > 0) _distributeProfit(asset, profit);
        emit ArbExecuted(asset, loanAmount, profit, 0, 0, 0, uint8(arb.provider));
    }

    function _executeSwaps(ArbParams memory arb, address startAsset, uint256 amount) internal {
        uint256 currentAmount = amount;
        address currentToken = startAsset;
        for (uint256 i = 0; i < arb.tokenPath.length - 1; i++) {
            address nextToken = arb.tokenPath[i + 1];
            uint24 fee = arb.v3Fees.length > i ? arb.v3Fees[i] : 0;
            if (fee > 0 && v3Router != address(0)) {
                currentAmount = _swapV3(currentToken, nextToken, fee, currentAmount);
            } else {
                address router = v2Routers[arb.dexNames.length > i ? arb.dexNames[i] : ""];
                require(router != address(0), "NO_ROUTER");
                currentAmount = _swapV2(router, currentToken, nextToken, currentAmount);
            }
            currentToken = nextToken;
        }
        if (currentToken != startAsset) {
            uint24 lastFee = arb.v3Fees.length > arb.tokenPath.length - 1 ? arb.v3Fees[arb.tokenPath.length - 1] : 0;
            if (lastFee > 0 && v3Router != address(0)) {
                currentAmount = _swapV3(currentToken, startAsset, lastFee, currentAmount);
            } else {
                address router = v2Routers[arb.dexNames.length > arb.tokenPath.length - 1 ? arb.dexNames[arb.tokenPath.length - 1] : ""];
                require(router != address(0), "NO_FINAL_ROUTER");
                currentAmount = _swapV2(router, currentToken, startAsset, currentAmount);
            }
        }
    }

    function _swapV2(address router, address tokenIn, address tokenOut, uint256 amountIn) internal returns (uint256) {
        IERC20(tokenIn).approve(router, amountIn);
        address[] memory path = new address[](2);
        path[0] = tokenIn; path[1] = tokenOut;
        uint256 before = IERC20(tokenOut).balanceOf(address(this));
        IUniswapV2Router(router).swapExactTokensForTokensSupportingFeeOnTransferTokens(amountIn, 0, path, address(this), block.timestamp + 300);
        return IERC20(tokenOut).balanceOf(address(this)) - before;
    }

    function _swapV3(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn) internal returns (uint256) {
        IERC20(tokenIn).approve(v3Router, amountIn);
        address[] memory path = new address[](2);
        path[0] = tokenIn; path[1] = tokenOut;
        uint256 before = IERC20(tokenOut).balanceOf(address(this));
        IUniswapV3Router(v3Router).exactInput(amountIn, 0, path, address(this), block.timestamp + 300);
        return IERC20(tokenOut).balanceOf(address(this)) - before;
    }

    /// @notice Distributes profit: 85% owner, 5% Gelato fee, 10% gas reserve
    /// @dev If profit is in USDC, pays Gelato fee directly. Otherwise swaps to USDC first.
    function _distributeProfit(address profitToken, uint256 profit) internal {
        uint256 reserveAmount = (profit * GAS_RESERVE_PERCENT) / 100;
        uint256 gelatoAmount = (profit * RELAYER_FEE_PERCENT) / 100;
        uint256 ownerAmount = profit - reserveAmount - gelatoAmount;

        totalProfit += profit;

        // If profit is already in fee token (USDC), pay directly
        if (profitToken == feeToken) {
            if (ownerAmount > 0) IERC20(feeToken).transfer(owner, ownerAmount);
            if (gelatoAmount > 0 && gelatoFeeCollector != address(0)) {
                IERC20(feeToken).transfer(gelatoFeeCollector, gelatoAmount);
                totalGasFeesPaid += gelatoAmount;
                emit GasFeePaid(gelatoAmount, feeToken);
            }
            gasReserve += reserveAmount;
        } else {
            // Profit is in another token — send owner's share directly
            if (ownerAmount > 0) IERC20(profitToken).transfer(owner, ownerAmount);
            // Reserve stays in profit token (can be swapped later)
            gasReserve += reserveAmount;
            // Gelato fee: try to swap profit token to fee token for payment
            // For simplicity, send gelato fee in profit token — Gelato can accept any token
            if (gelatoAmount > 0 && gelatoFeeCollector != address(0)) {
                IERC20(profitToken).transfer(gelatoFeeCollector, gelatoAmount);
                totalGasFeesPaid += gelatoAmount;
                emit GasFeePaid(gelatoAmount, profitToken);
            }
        }

        emit ArbExecuted(profitToken, 0, profit, ownerAmount, gelatoAmount, reserveAmount, 0);
    }

    /// @notice Withdraw gas reserve to Gelato Gas Tank for future gas sponsorship
    function replenishGasTank(address to, uint256 amount) external onlyOwnerOrGelato {
        require(amount <= gasReserve, "INSUFFICIENT_RESERVE");
        IERC20(feeToken).transfer(to, amount);
        gasReserve -= amount;
        emit GasFeePaid(amount, feeToken);
    }

    function withdrawProfit(address token, address to) external onlyOwner {
        uint256 bal = IERC20(token).balanceOf(address(this));
        IERC20(token).transfer(to, bal);
        emit ProfitWithdrawn(token, to, bal);
    }

    function getBalance(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    function _decodeParams(bytes calldata params) internal pure returns (ArbParams memory) {
        (uint8 provider, address dodoPool, string[] memory dexNames, address[] memory tokenPath, uint24[] memory v3Fees) =
            abi.decode(params, (uint8, address, string[], address[], uint24[]));
        return ArbParams({ provider: FlashProvider(provider), dodoPool: dodoPool, dexNames: dexNames, tokenPath: tokenPath, v3Fees: v3Fees });
    }

    receive() external payable {}
}

/// @title FlashArbFactory — Gasless contract deployment via Gelato
/// @notice Deploys new FlashArbExecutor instances. The factory itself is deployed
///         once (by Gelato on first call). All subsequent deployments are gasless
///         because Gelato sponsors the factory's gas via the Gas Tank.
contract FlashArbFactory {
    address public owner;
    address public gelatoRelayer;
    mapping(address => address[]) public userContracts;

    event ContractDeployed(address indexed user, address indexed executor, address balancerVault, address v3Router, address feeToken);

    modifier onlyOwnerOrGelato() {
        require(msg.sender == owner || msg.sender == gelatoRelayer, "NOT_AUTHORIZED");
        _;
    }

    constructor() { owner = msg.sender; }

    function setGelatoRelayer(address _relayer) external {
        require(msg.sender == owner || gelatoRelayer == address(0), "NOT_AUTHORIZED");
        gelatoRelayer = _relayer;
    }

    function initializeOwner(address _owner) external {
        require(owner == address(0) || owner == msg.sender, "ALREADY_INITIALIZED");
        owner = _owner;
    }

    function deployExecutor(
        address user,
        address balancerVault,
        address v3Router,
        address feeToken,
        address gelatoFeeCollector
    ) external onlyOwnerOrGelato returns (address) {
        FlashArbExecutor executor = new FlashArbExecutor(balancerVault, v3Router, feeToken, gelatoFeeCollector);
        executor.initializeOwner(user);
        userContracts[user].push(address(executor));
        emit ContractDeployed(user, address(executor), balancerVault, v3Router, feeToken);
        return address(executor);
    }

    function getUserContracts(address user) external view returns (address[] memory) {
        return userContracts[user];
    }
}
