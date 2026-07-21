/**
 * In-browser wallet management using ethers.js.
 * Generates a new wallet, encrypts the private key with AES-256-GCM, stores in Supabase.
 * The wallet is used for SIGNING messages (gasless) — not for sending transactions.
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

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

async function cryptoEncrypt(plaintext: string, key: CryptoKey): Promise<string> {
  const enc = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext));
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv); combined.set(new Uint8Array(ciphertext), iv.length);
  return ethers.hexlify(combined);
}

async function cryptoDecrypt(ciphertextHex: string, key: CryptoKey): Promise<string> {
  const combined = ethers.getBytes(ciphertextHex);
  const iv = combined.slice(0, 12); const ciphertext = combined.slice(12);
  const dec = new TextDecoder();
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return dec.decode(plaintext);
}

export async function generateWallet(password: string): Promise<WalletState> {
  const wallet = ethers.Wallet.createRandom();
  const saltBytes = ethers.randomBytes(16);
  const salt = ethers.hexlify(saltBytes);
  const encKey = await deriveKey(password, saltBytes);
  const encrypted = await cryptoEncrypt(wallet.privateKey, encKey);

  const { error } = await supabase.from('arb_wallet').insert({
    address: wallet.address, encrypted_private_key: encrypted, salt,
    chain_balances: {}, deployed_contracts: {},
  });
  if (error) throw new Error(`Failed to store wallet: ${error.message}`);

  return { address: wallet.address, encryptedKey: encrypted, salt, isUnlocked: true, signer: wallet };
}

export async function importWallet(privateKey: string, password: string): Promise<WalletState> {
  const wallet = new ethers.Wallet(privateKey);
  const saltBytes = ethers.randomBytes(16);
  const salt = ethers.hexlify(saltBytes);
  const encKey = await deriveKey(password, saltBytes);
  const encrypted = await cryptoEncrypt(privateKey, encKey);

  const { error } = await supabase.from('arb_wallet').insert({
    address: wallet.address, encrypted_private_key: encrypted, salt,
    chain_balances: {}, deployed_contracts: {},
  });
  if (error) throw new Error(`Failed to store wallet: ${error.message}`);

  return { address: wallet.address, encryptedKey: encrypted, salt, isUnlocked: true, signer: wallet };
}

export async function unlockWallet(encryptedKey: string, salt: string, password: string): Promise<WalletState> {
  const saltBytes = ethers.getBytes(salt);
  const encKey = await deriveKey(password, saltBytes);
  const privateKey = await cryptoDecrypt(encryptedKey, encKey);
  if (!privateKey) throw new Error('Invalid password');
  const wallet = new ethers.Wallet(privateKey);
  return { address: wallet.address, encryptedKey, salt, isUnlocked: true, signer: wallet };
}

export async function loadWallet(): Promise<{ address: string; encryptedKey: string; salt: string } | null> {
  const { data } = await supabase
    .from('arb_wallet')
    .select('address, encrypted_private_key, salt')
    .order('created_at', { ascending: false })
    .limit(1).maybeSingle();
  if (!data) return null;
  return { address: data.address, encryptedKey: data.encrypted_private_key, salt: data.salt };
}

export async function getNativeBalance(address: string, rpcUrl: string): Promise<string> {
  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    return ethers.formatEther(await provider.getBalance(address));
  } catch { return '0.0'; }
}

export async function updateDeployedContracts(address: string, contracts: Record<string, string>): Promise<void> {
  await supabase.from('arb_wallet').update({ deployed_contracts: contracts }).eq('address', address);
}
