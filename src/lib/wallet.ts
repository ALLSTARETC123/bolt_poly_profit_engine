import { ethers } from 'ethers';

const supabaseUrl = (typeof import.meta !== 'undefined' && import.meta.env) ? import.meta.env.VITE_SUPABASE_URL : '';
const supabaseKey = (typeof import.meta !== 'undefined' && import.meta.env) ? import.meta.env.VITE_SUPABASE_ANON_KEY : '';

export interface WalletState {
  address: string;
  encryptedKey: string;
  salt: string;
  isUnlocked: boolean;
  signer: ethers.Wallet | null;
}

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password) as BufferSource, 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: 100000, hash: 'SHA-256' },
    keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

async function cryptoEncrypt(plaintext: string, key: CryptoKey): Promise<string> {
  const enc = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource }, key, enc.encode(plaintext) as BufferSource,
  );
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
    { name: 'AES-GCM', iv: iv as BufferSource }, key, ciphertext as BufferSource,
  );
  return dec.decode(plaintext);
}

export async function generateWallet(password: string): Promise<WalletState> {
  const wallet = ethers.Wallet.createRandom();
  const saltBytes = ethers.randomBytes(16);
  const salt = ethers.hexlify(saltBytes);
  const encKey = await deriveKey(password, saltBytes);
  const encrypted = await cryptoEncrypt(wallet.privateKey, encKey);

  const response = await fetch(`${supabaseUrl}/functions/v1/relayer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${supabaseKey}` },
    body: JSON.stringify({
      action: 'db_insert',
      table: 'arb_wallet',
      data: { address: wallet.address, encrypted_private_key: encrypted, salt, chain_balances: {}, deployed_contracts: {} },
    }),
  });
  if (!response.ok) throw new Error('Failed to store wallet');

  return { address: wallet.address, encryptedKey: encrypted, salt, isUnlocked: true, signer: new ethers.Wallet(wallet.privateKey) };
}

export async function importWallet(privateKey: string, password: string): Promise<WalletState> {
  const wallet = new ethers.Wallet(privateKey);
  const saltBytes = ethers.randomBytes(16);
  const salt = ethers.hexlify(saltBytes);
  const encKey = await deriveKey(password, saltBytes);
  const encrypted = await cryptoEncrypt(privateKey, encKey);

  const response = await fetch(`${supabaseUrl}/functions/v1/relayer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${supabaseKey}` },
    body: JSON.stringify({
      action: 'db_insert',
      table: 'arb_wallet',
      data: { address: wallet.address, encrypted_private_key: encrypted, salt, chain_balances: {}, deployed_contracts: {} },
    }),
  });
  if (!response.ok) throw new Error('Failed to store wallet');

  return { address: wallet.address, encryptedKey: encrypted, salt, isUnlocked: true, signer: new ethers.Wallet(wallet.privateKey) };
}

export async function unlockWallet(encryptedKey: string, salt: string, password: string): Promise<WalletState> {
  const saltBytes = ethers.getBytes(salt);
  const encKey = await deriveKey(password, saltBytes);
  const privateKey = await cryptoDecrypt(encryptedKey, encKey);
  const wallet = new ethers.Wallet(privateKey);
  return { address: wallet.address, encryptedKey, salt, isUnlocked: true, signer: wallet };
}

export async function loadWallet(): Promise<{ address: string; encryptedKey: string; salt: string } | null> {
  const response = await fetch(`${supabaseUrl}/functions/v1/relayer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${supabaseKey}` },
    body: JSON.stringify({ action: 'db_select', table: 'arb_wallet', order: 'created_at.desc', limit: 1 }),
  });
  if (!response.ok) return null;
  const result = await response.json();
  if (!result.data || result.data.length === 0) return null;
  const w = result.data[0];
  return { address: w.address, encryptedKey: w.encrypted_private_key, salt: w.salt };
}

export async function updateDeployedContracts(address: string, contracts: Record<string, string>): Promise<void> {
  await fetch(`${supabaseUrl}/functions/v1/relayer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${supabaseKey}` },
    body: JSON.stringify({
      action: 'db_update',
      table: 'arb_wallet',
      filter: { address },
      data: { deployed_contracts: contracts },
    }),
  });
}
