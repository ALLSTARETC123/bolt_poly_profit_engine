import { ethers } from 'ethers';

const INFURA_URL = 'https://polygon-mainnet.infura.io/v3/YOUR_INFURA_PROJECT_ID';
const provider = new ethers.JsonRpcProvider(INFURA_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

export async function executeTransaction(txData: any) {
  const tx = {
    to: txData.to,
    data: txData.input,
    gasLimit: 300000
  };
  const response = await wallet.sendTransaction(tx);
  return await response.wait();
}
