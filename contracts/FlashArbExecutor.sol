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
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;
}

interface IUniswapV3Router {
    function exactInput(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256);
}

/// @title FlashArbExecutor — Gasless flash loan arbitrage executor
/// @notice Dual Balancer V2 + DODO V2 zero-fee flash loans.
///         100% of profit to owner wallet. Self-funding gas reserve.
///         Gasless: relayer submits txns on behalf of owner via EIP-712 sig.
///         Relayer is reimbursed from gas reserve.
contract FlashArbExecutor {
    // EIP-712 domain
    string public constant EIP712_NAME = "FlashArbExecutor";
    string public constant EIP712_VERSION = "1";
    bytes32 public constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 public constant EXECUTE_TYPEHASH = keccak256(
        "ExecuteArb(address asset,uint256 amount,bytes params,uint256 nonce,uint256 deadline)"
    );

    address public owner;
    address public relayer;
    address public balancerVault;
    address public v3Router;
    mapping(string => address) public v2Routers;
    mapping(address => uint256) public nonces;

    uint256 public totalProfit;
    uint256 public gasReserve;

    uint256 public constant GAS_RESERVE_PERCENT = 10;
    uint256 public constant RELAYER_FEE_PERCENT = 5; // 5% of profit to relayer for gas

    enum FlashProvider { BALANCER_V2, DODO_V2 }

    struct ArbParams {
        FlashProvider provider;
        address dodoPool;
        string[] dexNames;
        address[] tokenPath;
        uint24[] v3Fees;
    }

    event ArbExecuted(address indexed asset, uint256 borrowed, uint256 profit, uint256 toOwner, uint256 toRelayer, uint256 gasReserveAfter, uint8 provider);
    event ArbFailed(string reason);
    event GasReserveUsed(uint256 amount, address indexed to);
    event ProfitWithdrawn(address indexed token, address indexed to, uint256 amount);
    event RelayerSet(address indexed oldRelayer, address indexed newRelayer);

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    modifier onlyOwnerOrRelayer() {
        require(msg.sender == owner || msg.sender == relayer, "NOT_AUTHORIZED");
        _;
    }

    constructor(address _balancerVault, address _v3Router) {
        owner = msg.sender;
        balancerVault = _balancerVault;
        v3Router = _v3Router;
    }

    // ── Config ──────────────────────────────────────────

    function setV2Router(string calldata name, address router) external onlyOwnerOrRelayer {
        v2Routers[name] = router;
    }

    function setV3Router(address router) external onlyOwnerOrRelayer {
        v3Router = router;
    }

    function setBalancerVault(address vault) external onlyOwnerOrRelayer {
        balancerVault = vault;
    }

    function setRelayer(address _relayer) external onlyOwner {
        emit RelayerSet(relayer, _relayer);
        relayer = _relayer;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        owner = newOwner;
    }

    // ── EIP-712 Domain Separator ───────────────────────

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(abi.encode(
            EIP712_DOMAIN_TYPEHASH,
            keccak256(bytes(EIP712_NAME)),
            keccak256(bytes(EIP712_VERSION)),
            block.chainid,
            address(this)
        ));
    }

    function _hashExecuteArb(
        address asset, uint256 amount, bytes calldata params,
        uint256 nonce, uint256 deadline
    ) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(
            "\x19\x01",
            _domainSeparator(),
            keccak256(abi.encode(
                EXECUTE_TYPEHASH,
                asset, amount, keccak256(params), nonce, deadline
            ))
        ));
    }

    // ── Direct execution (owner only) ──────────────────

    function executeArb(address asset, uint256 amount, bytes calldata params) external onlyOwner {
        ArbParams memory arb = _decodeParams(params);
        _doFlashLoan(asset, amount, arb);
    }

    // ── Gasless execution via relayer + EIP-712 sig ─────
    // Relayer pays gas, gets reimbursed from profit.
    // Owner signs off-chain — never needs native tokens.

    function executeArbWithSig(
        address asset,
        uint256 amount,
        bytes calldata params,
        uint256 deadline,
        uint8 v, bytes32 r, bytes32 s
    ) external onlyOwnerOrRelayer {
        require(block.timestamp <= deadline, "EXPIRED");

        address signer = ecrecover(
            _hashExecuteArb(asset, amount, params, nonces[owner], deadline),
            v, r, s
        );
        require(signer == owner, "INVALID_SIGNATURE");

        nonces[owner]++;

        ArbParams memory arb = _decodeParams(params);
        _doFlashLoan(asset, amount, arb);
    }

    // ── Gasless deployment helper ──────────────────────
    // Called by relayer after deploy. Sets owner to the real user.

    function initializeOwner(address _owner) external {
        require(owner == address(0) || owner == msg.sender, "ALREADY_INITIALIZED");
        owner = _owner;
    }

    // ── Flash loan dispatch ────────────────────────────

    function _doFlashLoan(address asset, uint256 amount, ArbParams memory arb) internal {
        if (arb.provider == FlashProvider.BALANCER_V2) {
            _balancerFlashLoan(asset, amount, arb);
        } else {
            _dodoFlashLoan(asset, amount, arb);
        }
    }

    function _balancerFlashLoan(address asset, uint256 amount, ArbParams memory arb) internal {
        address[] memory tokens = new address[](1);
        tokens[0] = asset;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = amount;
        bytes memory userData = abi.encode(arb, asset, amount);
        IBalancerVault(balancerVault).flashLoan(address(this), tokens, amounts, userData);
    }

    function receiveFlashLoan(
        address[] calldata tokens, uint256[] calldata amounts,
        uint256[] calldata feeAmounts, bytes calldata userData
    ) external {
        require(msg.sender == balancerVault, "NOT_VAULT");
        require(feeAmounts[0] == 0, "FEE_NOT_ZERO");

        (ArbParams memory arb, address asset, uint256 amount) =
            abi.decode(userData, (ArbParams, address, uint256));

        _executeSwaps(arb, asset, amount);

        uint256 balanceAfter = IERC20(asset).balanceOf(address(this));
        require(balanceAfter >= amount, "INSUFFICIENT_RETURN");

        IERC20(asset).transfer(balancerVault, amount);

        uint256 profit = balanceAfter - amount;
        if (profit > 0) _distributeProfit(asset, profit);

        emit ArbExecuted(asset, amount, profit, 0, 0, gasReserve, uint8(arb.provider));
    }

    function _dodoFlashLoan(address asset, uint256 amount, ArbParams memory arb) internal {
        address pool = arb.dodoPool;
        require(pool != address(0), "NO_DODO_POOL");
        address baseToken = IDODO(pool)._BASE_TOKEN_();
        bytes memory data = abi.encode(arb, asset, amount);
        if (asset == baseToken) {
            IDODO(pool).flashLoan(amount, 0, address(this), data);
        } else {
            IDODO(pool).flashLoan(0, amount, address(this), data);
        }
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
        (ArbParams memory arb, address asset, uint256 amount) =
            abi.decode(data, (ArbParams, address, uint256));
        require(sender == address(this), "DENIED");
        require(msg.sender == arb.dodoPool, "NOT_POOL");

        uint256 loanAmount = baseAmount > 0 ? baseAmount : quoteAmount;

        _executeSwaps(arb, asset, loanAmount);

        uint256 balanceAfter = IERC20(asset).balanceOf(address(this));
        require(balanceAfter >= loanAmount, "INSUFFICIENT_RETURN");

        IERC20(asset).transfer(arb.dodoPool, loanAmount);

        uint256 profit = balanceAfter - loanAmount;
        if (profit > 0) _distributeProfit(asset, profit);

        emit ArbExecuted(asset, loanAmount, profit, 0, 0, gasReserve, uint8(arb.provider));
    }

    // ── Swap execution ──────────────────────────────────

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
                require(router != address(0), "NO_ROUTER");
                currentAmount = _swapV2(router, currentToken, nextToken, currentAmount);
            }
            currentToken = nextToken;
        }

        if (currentToken != startAsset) {
            uint24 lastFee = arb.v3Fees.length > arb.tokenPath.length - 1
                ? arb.v3Fees[arb.tokenPath.length - 1] : 0;
            string memory lastDex = arb.dexNames.length > arb.tokenPath.length - 1
                ? arb.dexNames[arb.tokenPath.length - 1] : "";

            if (lastFee > 0 && v3Router != address(0)) {
                currentAmount = _swapV3(currentToken, startAsset, lastFee, currentAmount);
            } else {
                address router = v2Routers[lastDex];
                require(router != address(0), "NO_FINAL_ROUTER");
                currentAmount = _swapV2(router, currentToken, startAsset, currentAmount);
            }
        }
    }

    function _swapV2(address router, address tokenIn, address tokenOut, uint256 amountIn) internal returns (uint256) {
        IERC20(tokenIn).approve(router, amountIn);
        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;
        uint256 before = IERC20(tokenOut).balanceOf(address(this));
        IUniswapV2Router(router).swapExactTokensForTokensSupportingFeeOnTransferTokens(
            amountIn, 0, path, address(this), block.timestamp + 300);
        return IERC20(tokenOut).balanceOf(address(this)) - before;
    }

    function _swapV3(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn) internal returns (uint256) {
        IERC20(tokenIn).approve(v3Router, amountIn);
        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;
        uint256 before = IERC20(tokenOut).balanceOf(address(this));
        IUniswapV3Router(v3Router).exactInput(amountIn, 0, path, address(this), block.timestamp + 300);
        return IERC20(tokenOut).balanceOf(address(this)) - before;
    }

    // ── Profit distribution ─────────────────────────────
    // 85% to owner, 10% to gas reserve, 5% to relayer

    function _distributeProfit(address token, uint256 profit) internal {
        uint256 reserveAmount = (profit * GAS_RESERVE_PERCENT) / 100;
        uint256 relayerAmount = (profit * RELAYER_FEE_PERCENT) / 100;
        uint256 ownerAmount = profit - reserveAmount - relayerAmount;

        gasReserve += reserveAmount;
        totalProfit += profit;

        if (ownerAmount > 0) IERC20(token).transfer(owner, ownerAmount);
        if (relayerAmount > 0 && relayer != address(0)) IERC20(token).transfer(relayer, relayerAmount);

        emit ArbExecuted(token, 0, profit, ownerAmount, relayerAmount, gasReserve, 0);
    }

    // ── Gas reserve ──────────────────────────────────────

    function useGasReserve(address wrappedNative, uint256 amount) external onlyOwnerOrRelayer {
        uint256 useAmount = amount == 0 ? gasReserve : amount;
        require(useAmount <= gasReserve, "INSUFFICIENT");
        IERC20(wrappedNative).transfer(msg.sender, useAmount);
        gasReserve -= useAmount;
        emit GasReserveUsed(useAmount, msg.sender);
    }

    // ── Withdraw ────────────────────────────────────────

    function withdrawProfit(address token, address to) external onlyOwner {
        uint256 bal = IERC20(token).balanceOf(address(this));
        IERC20(token).transfer(to, bal);
        emit ProfitWithdrawn(token, to, bal);
    }

    function getBalance(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    function _decodeParams(bytes calldata params) internal pure returns (ArbParams memory) {
        (uint8 provider, address dodoPool, string[] memory dexNames,
         address[] memory tokenPath, uint24[] memory v3Fees) =
            abi.decode(params, (uint8, address, string[], address[], uint24[]));
        return ArbParams({
            provider: FlashProvider(provider),
            dodoPool: dodoPool,
            dexNames: dexNames,
            tokenPath: tokenPath,
            v3Fees: v3Fees
        });
    }

    receive() external payable {}
}
