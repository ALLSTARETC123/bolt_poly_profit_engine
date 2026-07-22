import { ethers } from 'ethers';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

export interface WalletState {
  address: string;
  encryptedKey: string;
  salt: string;
  isUnlocked: boolean;
  signer: ethers.Wallet | null;
  settlementAddress: string | null;
}

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password) as BufferSource, 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: 100000, hash: 'SHA-256' },
    keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

async function encrypt(plaintext: string, key: CryptoKey): Promise<string> {
  const enc = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, enc.encode(plaintext) as BufferSource);
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return ethers.hexlify(combined);
}

async function decrypt(ciphertextHex: string, key: CryptoKey): Promise<string> {
  const combined = ethers.getBytes(ciphertextHex);
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const dec = new TextDecoder();
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, ciphertext as BufferSource);
  return dec.decode(plaintext);
}

async function relay(action: string, payload: Record<string, unknown>): Promise<any> {
  const resp = await fetch(`${supabaseUrl}/functions/v1/relayer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${supabaseKey}` },
    body: JSON.stringify({ action, ...payload }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
    throw new Error(err.error || `Relayer error: ${resp.status}`);
  }
  return resp.json();
}

export async function generateWallet(password: string): Promise<WalletState> {
  const wallet = ethers.Wallet.createRandom();
  const settlementWallet = ethers.Wallet.createRandom();
  const saltBytes = ethers.randomBytes(16);
  const salt = ethers.hexlify(saltBytes);
  const encKey = await deriveKey(password, saltBytes);
  const encrypted = await encrypt(wallet.privateKey, encKey);
  await relay('db_insert', {
    table: 'arb_wallet',
    data: {
      address: wallet.address,
      encrypted_private_key: encrypted,
      salt,
      deployed_contracts: {},
      settlement_address: settlementWallet.address,
      settlement_encrypted_key: await encrypt(settlementWallet.privateKey, encKey),
    },
  });
  return { address: wallet.address, encryptedKey: encrypted, salt, isUnlocked: true, signer: new ethers.Wallet(wallet.privateKey), settlementAddress: settlementWallet.address };
}

export async function importWallet(privateKey: string, password: string): Promise<WalletState> {
  const wallet = new ethers.Wallet(privateKey);
  const settlementWallet = ethers.Wallet.createRandom();
  const saltBytes = ethers.randomBytes(16);
  const salt = ethers.hexlify(saltBytes);
  const encKey = await deriveKey(password, saltBytes);
  const encrypted = await encrypt(privateKey, encKey);
  await relay('db_insert', {
    table: 'arb_wallet',
    data: {
      address: wallet.address,
      encrypted_private_key: encrypted,
      salt,
      deployed_contracts: {},
      settlement_address: settlementWallet.address,
      settlement_encrypted_key: await encrypt(settlementWallet.privateKey, encKey),
    },
  });
  return { address: wallet.address, encryptedKey: encrypted, salt, isUnlocked: true, signer: new ethers.Wallet(privateKey), settlementAddress: settlementWallet.address };
}

export async function unlockWallet(encryptedKey: string, salt: string, password: string): Promise<WalletState> {
  const saltBytes = ethers.getBytes(salt);
  const encKey = await deriveKey(password, saltBytes);
  const privateKey = await decrypt(encryptedKey, encKey);
  const wallet = new ethers.Wallet(privateKey);
  let settlementAddress: string | null = null;
  try {
    const result = await relay('db_select', { table: 'arb_wallet', filter: { address: wallet.address }, limit: 1 });
    if (result.data?.[0]?.settlement_address) settlementAddress = result.data[0].settlement_address;
  } catch { /* non-fatal */ }
  return { address: wallet.address, encryptedKey, salt, isUnlocked: true, signer: wallet, settlementAddress };
}

export async function loadWallet(): Promise<{ address: string; encryptedKey: string; salt: string; settlementAddress: string | null } | null> {
  try {
    const result = await relay('db_select', { table: 'arb_wallet', order: 'created_at.desc', limit: 1 });
    if (!result.data || result.data.length === 0) return null;
    const w = result.data[0];
    return { address: w.address, encryptedKey: w.encrypted_private_key, salt: w.salt, settlementAddress: w.settlement_address || null };
  } catch { return null; }
}

export async function updateDeployedContracts(address: string, contracts: Record<string, string>): Promise<void> {
  await relay('db_update', { table: 'arb_wallet', filter: { address }, data: { deployed_contracts: contracts } });
}
