import { ethers } from 'ethers';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

export interface WalletState {
  address: string;
  encryptedKey: string;
  salt: string;
  isUnlocked: boolean;
  signer: ethers.AbstractSigner | null;
  settlementAddress?: string;
}

interface StoredWallet {
  address: string;
  encrypted_private_key: string;
  salt: string;
  deployed_contracts?: Record<string, string>;
}

const PBKDF2_ITERATIONS = 150000;
const IV_LENGTH = 12;
const SALT_LENGTH = 16;

function bufToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBuf(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex string');
  return new Uint8Array(hex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
}

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(0, bytes.byteLength) as ArrayBuffer;
}

async function deriveKey(password: string, saltHex: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const saltBytes = hexToBuf(saltHex);
  const saltBuffer = toBuffer(saltBytes);
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBuffer, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptPrivateKey(privateKey: string, password: string): Promise<{ encrypted: string; salt: string }> {
  const saltBytes = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const saltHex = bufToHex(toBuffer(saltBytes));
  const key = await deriveKey(password, saltHex);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ivBuffer = toBuffer(iv);
  const enc = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: ivBuffer },
    key,
    enc.encode(privateKey)
  );
  const ivHex = bufToHex(ivBuffer);
  const ctHex = bufToHex(ciphertext);
  return { encrypted: ivHex + ctHex, salt: saltHex };
}

async function decryptPrivateKey(encryptedHex: string, saltHex: string, password: string): Promise<string> {
  if (encryptedHex.length < (IV_LENGTH * 2) + 2) {
    throw new Error('Invalid encrypted data format');
  }
  const ivHex = encryptedHex.slice(0, IV_LENGTH * 2);
  const ctHex = encryptedHex.slice(IV_LENGTH * 2);
  const key = await deriveKey(password, saltHex);
  const iv = hexToBuf(ivHex);
  const ivBuffer = toBuffer(iv);
  const ctBytes = hexToBuf(ctHex);
  const ctBuffer = toBuffer(ctBytes);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBuffer },
    key,
    ctBuffer
  );
  return new TextDecoder().decode(decrypted);
}

function validatePassword(password: string): string | null {
  if (!password || password.length < 8) {
    return 'Password must be at least 8 characters';
  }
  if (password.length > 256) {
    return 'Password is too long';
  }
  return null;
}

function sanitizePrivateKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) throw new Error('Private key is empty');
  if (!ethers.isHexString(trimmed) && !ethers.isHexString('0x' + trimmed)) {
    throw new Error('Invalid private key format');
  }
  return trimmed.startsWith('0x') ? trimmed : '0x' + trimmed;
}

export async function generateWallet(password: string): Promise<WalletState> {
  const pwdError = validatePassword(password);
  if (pwdError) throw new Error(pwdError);

  const wallet = ethers.Wallet.createRandom();
  const { encrypted, salt } = await encryptPrivateKey(wallet.privateKey, password);

  if (supabase) {
    const { error } = await supabase.from('arb_wallet').insert({
      address: wallet.address,
      encrypted_private_key: encrypted,
      salt,
      deployed_contracts: {},
    });
    if (error) throw new Error(`Failed to store wallet: ${error.message}`);
  }

  return {
    address: wallet.address,
    encryptedKey: encrypted,
    salt,
    isUnlocked: true,
    signer: wallet,
    settlementAddress: wallet.address,
  };
}

export async function importWallet(privateKeyInput: string, password: string): Promise<WalletState> {
  const pwdError = validatePassword(password);
  if (pwdError) throw new Error(pwdError);

  const privateKey = sanitizePrivateKey(privateKeyInput);
  const wallet = new ethers.Wallet(privateKey);
  const { encrypted, salt } = await encryptPrivateKey(privateKey, password);

  if (supabase) {
    const { error } = await supabase.from('arb_wallet').insert({
      address: wallet.address,
      encrypted_private_key: encrypted,
      salt,
      deployed_contracts: {},
    });
    if (error) throw new Error(`Failed to store wallet: ${error.message}`);
  }

  return {
    address: wallet.address,
    encryptedKey: encrypted,
    salt,
    isUnlocked: true,
    signer: wallet,
    settlementAddress: wallet.address,
  };
}

export async function loadWallet(): Promise<WalletState | null> {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('arb_wallet')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return null;
  if (!data) return null;
  const stored = data as StoredWallet;
  return {
    address: stored.address,
    encryptedKey: stored.encrypted_private_key,
    salt: stored.salt,
    isUnlocked: false,
    signer: null,
    settlementAddress: stored.deployed_contracts ? undefined : stored.address,
  };
}

export async function unlockWallet(encryptedKey: string, salt: string, password: string): Promise<WalletState> {
  const pwdError = validatePassword(password);
  if (pwdError) throw new Error(pwdError);

  const privateKey = await decryptPrivateKey(encryptedKey, salt, password);
  const wallet = new ethers.Wallet(privateKey);
  return {
    address: wallet.address,
    encryptedKey,
    salt,
    isUnlocked: true,
    signer: wallet,
  };
}

export async function updateDeployedContracts(address: string, contracts: Record<string, string>): Promise<void> {
  if (!supabase) return;
  if (!ethers.isAddress(address)) return;
  await supabase.from('arb_wallet').update({ deployed_contracts: contracts }).eq('address', address);
}

export async function getDeployedContracts(address: string): Promise<Record<string, string>> {
  if (!supabase) return {};
  if (!ethers.isAddress(address)) return {};
  const { data } = await supabase
    .from('arb_wallet')
    .select('deployed_contracts')
    .eq('address', address)
    .maybeSingle();
  if (!data) return {};
  return (data as { deployed_contracts?: Record<string, string> }).deployed_contracts || {};
}
