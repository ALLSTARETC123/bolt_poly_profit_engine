import { ethers } from 'ethers';

const CREATE2_FACTORY_ADDRESS = '0x4e59b44847b379578588920cA78FbF26c0B4956C';

const FACTORY_ABI = [
  {
    inputs: [{ name: 'salt', type: 'uint256' }, { name: 'initCode', type: 'bytes' }],
    name: 'deploy',
    outputs: [{ name: 'deployedContract', type: 'address' }],
    stateMutability: 'payable',
    type: 'function',
  },
];

export interface Create2Deployment {
  chain: string;
  salt: string;
  computedAddress: string;
  bytecode: string;
  deployed: boolean;
  deployTxHash?: string;
}

export function computeCreate2Address(
  deployerAddress: string,
  salt: string,
  bytecode: string
): string {
  const saltHex = ethers.id(salt);
  const initCodeHash = ethers.keccak256('0x' + bytecode.replace(/^0x/, ''));
  const create2Input = '0xff' + deployerAddress.slice(2) + saltHex.slice(2) + initCodeHash.slice(2);
  const create2Hash = ethers.keccak256('0x' + create2Input);
  return ethers.getAddress('0x' + create2Hash.slice(-40));
}

export function generateSalt(walletAddress: string, chainKey: string): string {
  return ethers.id(`FlashArb:${walletAddress}:${chainKey}:v1`);
}

export async function deployViaCreate2(
  signer: ethers.Wallet,
  chainKey: string,
  bytecode: string,
  constructorArgs: string
): Promise<Create2Deployment> {
  const walletAddress = await signer.getAddress();
  const salt = generateSalt(walletAddress, chainKey);
  const fullBytecode = '0x' + bytecode.replace(/^0x/, '') + constructorArgs.replace(/^0x/, '');
  const computedAddress = computeCreate2Address(CREATE2_FACTORY_ADDRESS, salt, bytecode + constructorArgs.replace(/^0x/, ''));

  const factory = new ethers.Contract(CREATE2_FACTORY_ADDRESS, FACTORY_ABI, signer);

  const code = await signer.provider?.getCode(computedAddress);
  if (code && code !== '0x') {
    return { chain: chainKey, salt, computedAddress, bytecode: fullBytecode, deployed: true };
  }

  const tx = await factory.deploy(BigInt(salt), fullBytecode, { gasLimit: 3000000 });
  const receipt = await tx.wait();
  return {
    chain: chainKey, salt, computedAddress, bytecode: fullBytecode,
    deployed: receipt?.status === 1,
    deployTxHash: tx.hash,
  };
}

export function encodeConstructorArgs(
  balancerVault: string,
  v3Router: string,
  feeToken: string,
  paymasterAddress: string
): string {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'address', 'address', 'address'],
    [balancerVault, v3Router, feeToken, paymasterAddress]
  );
}

export async function precomputeAllAddresses(
  walletAddress: string,
  bytecode: string,
  constructorArgs: string
): Promise<Record<string, string>> {
  const { CHAIN_KEYS } = await import('./chains');
  const addresses: Record<string, string> = {};
  for (const chainKey of CHAIN_KEYS) {
    const salt = generateSalt(walletAddress, chainKey);
    addresses[chainKey] = computeCreate2Address(CREATE2_FACTORY_ADDRESS, salt, bytecode + constructorArgs.replace(/^0x/, ''));
  }
  return addresses;
}
