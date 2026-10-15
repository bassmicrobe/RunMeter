const DATABASE_NAME = "runmeter-browser";
const DATABASE_VERSION = 1;
const STORE_NAME = "relay-session";
const SESSION_KEY = "local-relay";

export const DEFAULT_RELAY_ORIGIN = "http://127.0.0.1:47831";

export interface StoredRelaySession {
  storageVersion: 1;
  token: string;
  tokenVersion: string;
  expiresAt: string | null;
  origin: typeof DEFAULT_RELAY_ORIGIN;
  pairedAt: string;
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.addEventListener("upgradeneeded", () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME);
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("端末との接続情報を保存できませんでした")),
    );
  });
}

async function transactStore<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
) {
  if (typeof window === "undefined" || !window.indexedDB) {
    throw new Error("このブラウザでは端末とのペアリングを保存できません");
  }

  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode);
      const request = operation(transaction.objectStore(STORE_NAME));
      let requestResult: T;
      request.addEventListener("success", () => {
        requestResult = request.result;
      });
      request.addEventListener("error", () =>
        reject(request.error ?? new Error("端末との接続情報を保存できませんでした")),
      );
      transaction.addEventListener("complete", () => resolve(requestResult));
      transaction.addEventListener("abort", () =>
        reject(transaction.error ?? new Error("端末との接続情報を保存できませんでした")),
      );
    });
  } finally {
    database.close();
  }
}

export async function readRelaySession() {
  const value = await transactStore<StoredRelaySession | undefined>("readonly", (store) =>
    store.get(SESSION_KEY),
  );

  if (
    !value ||
    value.storageVersion !== 1 ||
    typeof value.token !== "string" ||
    value.token.length === 0 ||
    typeof value.tokenVersion !== "string" ||
    value.origin !== DEFAULT_RELAY_ORIGIN
  ) {
    if (typeof value?.token === "string") await clearRelaySession(value.token);
    return null;
  }

  if (
    value.expiresAt !== null &&
    (Number.isNaN(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.now())
  ) {
    await clearRelaySession(value.token);
    return null;
  }

  return value;
}

export async function saveRelaySession(
  token: string,
  metadata: { tokenVersion?: string; expiresAt?: string } = {},
) {
  const serverExpiry =
    metadata.expiresAt && !Number.isNaN(Date.parse(metadata.expiresAt))
      ? new Date(metadata.expiresAt).toISOString()
      : null;
  const expiresAt =
    serverExpiry ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000).toISOString();
  const session: StoredRelaySession = {
    storageVersion: 1,
    token,
    tokenVersion: metadata.tokenVersion ?? "1",
    expiresAt,
    origin: DEFAULT_RELAY_ORIGIN,
    pairedAt: new Date().toISOString(),
  };
  await transactStore<IDBValidKey>("readwrite", (store) =>
    store.put(session, SESSION_KEY),
  );
  return session;
}

export async function clearRelaySession(expectedToken?: string) {
  const previous = await transactStore<StoredRelaySession | undefined>("readwrite", (store) => {
    const request = store.get(SESSION_KEY);
    request.addEventListener("success", () => {
      const current = request.result as StoredRelaySession | undefined;
      // A late 401 from an old request must not erase a newly paired session.
      if (expectedToken === undefined || current?.token === expectedToken) {
        store.delete(SESSION_KEY);
      }
    });
    return request;
  });
  return expectedToken === undefined || previous?.token === expectedToken;
}
