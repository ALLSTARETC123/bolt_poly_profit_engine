// src/engine.ts
import { runHeadlessEngine } from './lib/scanner-engine.js';
import { executeTransaction } from './lib/executor.js';

runHeadlessEngine(async (tx, result) => {
  console.log("Profitable route identified:", result.profitEstimate);
  await executeTransaction(tx);
});
