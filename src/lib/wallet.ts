/**
 * In-browser wallet management using ethers.js.
 * Generates a new wallet, encrypts the private key, and stores it in Supabase.
 * The wallet is used for signing arbitrage execution transactions.
 */

import { ethers } from 'ethers';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

export interface WalletState {
  address: string;
  encryptedKey: string;
  salt: string;
  isUnlocked: boolean;
  signer: ethers.Wallet | null;
}

// Encrypt a private key with a password
async function encryptPrivateKey(privateKey: string, password: string): Promise<{ encrypted: string; salt: string }> {
  // Generate a random salt
  const saltBytes = ethers.randomBytes(16);
  const salt = ethers.hexlify(saltBytes);

  // Derive an encryption key from the password + salt
  const encKey = await deriveKey(password, saltBytes);

  // Encrypt the private key
  const encrypted = await cryptoEncrypt(privateKey, encKey);

  return { encrypted, salt };
}

// Decrypt a private key with a password
export async function decryptPrivateKey(encrypted: string, salt: string, password: string): Promise<string | null> {
  try {
    const saltBytes = ethers.getBytes(salt);
    const encKey = await deriveKey(password, saltBytes);
    return await cryptoDecrypt(encrypted, encKey);
  } catch {
    return null;
  }
}

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function cryptoEncrypt(plaintext: string, key: CryptoKey): Promise<string> {
  const enc = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(plaintext)
  );
  // Combine iv + ciphertext
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return ethers.hexlify(combined);
}

async function cryptoDecrypt(ciphertextHex: string, key: CryptoKey): Promise<string> {
  const combined = ethers.getBytes(ciphertextHex);
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const dec = new TextDecoder();
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  );
  return dec.decode(plaintext);
}

// Generate a new wallet
export async function generateWallet(password: string): Promise<WalletState> {
  const wallet = ethers.Wallet.createRandom();
  const { encrypted, salt } = await encryptPrivateKey(wallet.privateKey, password);

  // Store in Supabase
  const { error } = await supabase.from('arb_wallet').insert({
    address: wallet.address,
    encrypted_private_key: encrypted,
    salt,
    chain_balances: {},
    deployed_contracts: {},
  });

  if (error) throw new Error(`Failed to store wallet: ${error.message}`);

  return {
    address: wallet.address,
    encryptedKey: encrypted,
    salt,
    isUnlocked: true,
    signer: wallet,
  };
}

// Import an existing wallet from private key
export async function importWallet(privateKey: string, password: string): Promise<WalletState> {
  const wallet = new ethers.Wallet(privateKey);
  const { encrypted, salt } = await encryptPrivateKey(privateKey, password);

  const { error } = await supabase.from('arb_wallet').insert({
    address: wallet.address,
    encrypted_private_key: encrypted,
    salt,
    chain_balances: {},
    deployed_contracts: {},
  });

  if (error) throw new Error(`Failed to store wallet: ${error.message}`);

  return {
    address: wallet.address,
    encryptedKey: encrypted,
    salt,
    isUnlocked: true,
    signer: wallet,
  };
}

// Unlock wallet with password
export async function unlockWallet(encryptedKey: string, salt: string, password: string): Promise<WalletState> {
  const privateKey = await decryptPrivateKey(encryptedKey, salt, password);
  if (!privateKey) throw new Error('Invalid password');

  const wallet = new ethers.Wallet(privateKey);
  return {
    address: wallet.address,
    encryptedKey,
    salt,
    isUnlocked: true,
    signer: wallet,
  };
}

// Load wallet from Supabase (without unlocking)
export async function loadWallet(): Promise<{ address: string; encryptedKey: string; salt: string } | null> {
  const { data, error } = await supabase
    .from('arb_wallet')
    .select('address, encrypted_private_key, salt, chain_balances, deployed_contracts')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;

  return {
    address: data.address,
    encryptedKey: data.encrypted_private_key,
    salt: data.salt,
  };
}

// Get a connected signer for a specific chain
export function getSignerForChain(wallet: ethers.Wallet, rpcUrl: string): ethers.Wallet {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  return wallet.connect(provider);
}

// Fetch native token balance for a wallet on a chain
export async function getNativeBalance(address: string, rpcUrl: string): Promise<string> {
  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const balance = await provider.getBalance(address);
    return ethers.formatEther(balance);
  } catch {
    return '0.0';
  }
}

// Fetch ERC20 token balance
export async function getTokenBalance(walletAddress: string, tokenAddress: string, rpcUrl: string): Promise<string> {
  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const contract = new ethers.Contract(tokenAddress, ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'], provider);
    const [balance, decimals] = await Promise.all([
      contract.balanceOf(walletAddress),
      contract.decimals(),
    ]);
    return ethers.formatUnits(balance, decimals);
  } catch {
    return '0.0';
  }
}

// Update wallet balances in Supabase
export async function updateWalletBalances(address: string, balances: Record<string, string>): Promise<void> {
  await supabase.from('arb_wallet').update({ chain_balances: balances }).eq('address', address);
}

// Update deployed contracts
export async function updateDeployedContracts(address: string, contracts: Record<string, string>): Promise<void> {
  await supabase.from('arb_wallet').update({ deployed_contracts: contracts }).eq('address', address);
}
