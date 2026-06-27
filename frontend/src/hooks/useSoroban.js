import { useState, useEffect, useCallback } from 'react';
import { signTransaction } from '@stellar/freighter-api';
import { rpc, TransactionBuilder, Networks, Contract } from '@stellar/stellar-sdk';
import { useWalletStore } from '../store/useWalletStore';

const CONTRACT_ID = import.meta.env.VITE_CONTRACT_ID || 'C...';
const RPC_URL = import.meta.env.VITE_RPC_URL || 'https://soroban-testnet.stellar.org:443';
const NETWORK_PASSPHRASE = import.meta.env.VITE_NETWORK_PASSPHRASE || Networks.TESTNET;

const server = new rpc.Server(RPC_URL);
const contract = new Contract(CONTRACT_ID);

/**
 * useStellarContract
 * Provides shared contract configurations, the Server instance, and network passphrase.
 */
export function useStellarContract() {
  return {
    contract,
    server,
    contractId: CONTRACT_ID,
    networkPassphrase: NETWORK_PASSPHRASE,
  };
}

/**
 * Helper to serialize hook dependencies including XDR ScVal objects.
 */
const serializeArgs = (args) => {
  if (!args) return '';
  return args
    .map((arg) => {
      if (arg && typeof arg === 'object' && typeof arg.toXDR === 'function') {
        try {
          return arg.toXDR('base64');
        } catch {
          return String(arg);
        }
      }
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(',');
};

/**
 * useSorobanRead
 * Hook for executing read-only contract query functions (via simulation).
 */
export function useSorobanRead(fnName, args = [], options = {}) {
  const { publicKey } = useWalletStore();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const serializedArgs = serializeArgs(args);

  const execute = useCallback(async () => {
    if (!publicKey || CONTRACT_ID.length < 50) return null;
    setLoading(true);
    setError(null);
    try {
      const account = await server.getAccount(publicKey);
      const tx = new TransactionBuilder(account, {
        fee: '100',
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(contract.call(fnName, ...args))
        .setTimeout(30)
        .build();

      const simulation = await server.simulateTransaction(tx);
      if (simulation.error) {
        throw new Error(simulation.error);
      }

      setData(simulation.result);
      if (options.onSuccess) {
        options.onSuccess(simulation.result);
      }
      return simulation.result;
    } catch (err) {
      console.error(`[useSorobanRead] Error executing ${fnName}:`, err);
      setError(err.message || `Failed to execute ${fnName}`);
      if (options.onError) {
        options.onError(err);
      }
      throw err;
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicKey, fnName, serializedArgs, options.onSuccess, options.onError]);

  useEffect(() => {
    if (options.skip !== true && publicKey && CONTRACT_ID.length >= 50) {
      execute().catch(() => {});
    }
  }, [execute, publicKey, options.skip]);

  return { data, loading, error, refetch: execute };
}

// Alias for general contract read calls to satisfy task checklist / description
export const useSorobanCall = useSorobanRead;

/**
 * useSorobanWrite
 * Hook for executing transactions that write state (e.g. buying shares).
 */
export function useSorobanWrite(fnName) {
  const { publicKey } = useWalletStore();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const execute = useCallback(async (args = [], options = {}) => {
    if (!publicKey) {
      throw new Error('Wallet not connected');
    }
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const account = await server.getAccount(publicKey);
      let tx = new TransactionBuilder(account, {
        fee: options.fee || '10000',
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(contract.call(fnName, ...args))
        .setTimeout(30)
        .build();

      const simulation = await server.simulateTransaction(tx);
      if (simulation.error) {
        throw new Error(simulation.error);
      }

      tx = rpc.assembleTransaction(tx, simulation).build();
      const { signedTxXdr, error: signError } = await signTransaction(tx.toXDR(), {
        networkPassphrase: NETWORK_PASSPHRASE,
      });

      if (signError || !signedTxXdr) {
        throw new Error(signError?.message || 'Freighter transaction signing failed');
      }

      const submitRes = await server.sendTransaction(
        TransactionBuilder.fromXDR(signedTxXdr, NETWORK_PASSPHRASE)
      );

      setResult(submitRes);
      if (options.onSuccess) {
        options.onSuccess(submitRes);
      }
      return submitRes;
    } catch (err) {
      console.error(`[useSorobanWrite] Error executing tx ${fnName}:`, err);
      setError(err.message || `Transaction ${fnName} failed`);
      if (options.onError) {
        options.onError(err);
      }
      throw err;
    } finally {
      setLoading(false);
    }
  }, [publicKey, fnName]);

  return { execute, loading, error, result, setError, setResult };
}

// Alias for general contract write calls to satisfy task checklist / description
export const useSorobanTx = useSorobanWrite;
