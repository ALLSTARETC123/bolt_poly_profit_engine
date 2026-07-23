import { ethers } from 'ethers';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';
const supabase = supabaseUrl ? createClient(supabaseUrl, supabaseKey) : null;

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

async function deriveKey(password: string, salt: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: 150000, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

function bufToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBuf(hex: string): Uint8Array {
  return new Uint8Array(hex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
}

async function encryptPrivateKey(privateKey: string, password: string): Promise<{ encrypted: string; salt: string }> {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const salt = bufToHex(saltBytes.buffer as ArrayBuffer);
  const key = await deriveKey(password, salt);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv.buffer as ArrayBuffer }, key, enc.encode(privateKey));
  return { encrypted: bufToHex(encrypted), salt };
}

async function decryptPrivateKey(encryptedHex: string, salt: string, password: string): Promise<string> {
  const key = await deriveKey(password, salt);
  const iv = new Uint8Array(12);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv.buffer as ArrayBuffer }, key, hexToBuf(encryptedHex).buffer as ArrayBuffer);
  return new TextDecoder().decode(decrypted);
}

export async function generateWallet(password: string): Promise<WalletState> {
  const wallet = ethers.Wallet.createRandom();
  const { encrypted, salt } = await encryptPrivateKey(wallet.privateKey, password);

  if (supabase) {
    await supabase.from('arb_wallet').insert({
      address: wallet.address,
      encrypted_private_key: encrypted,
      salt,
      deployed_contracts: {},
    });
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

export async function importWallet(privateKey: string, password: string): Promise<WalletState> {
  const wallet = new ethers.Wallet(privateKey);
  const { encrypted, salt } = await encryptPrivateKey(privateKey, password);

  if (supabase) {
    await supabase.from('arb_wallet').insert({
      address: wallet.address,
      encrypted_private_key: encrypted,
      salt,
      deployed_contracts: {},
    });
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
  const { data } = await supabase.from('arb_wallet').select('*').order('created_at', { ascending: false }).limit(1).maybeSingle();
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
  await supabase.from('arb_wallet').update({ deployed_contracts: contracts }).eq('address', address);
}
