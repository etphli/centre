import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  createWorker,
  type Database,
  type Statement,
  type Env,
  type ExtensionContext,
  type WorkerOptions,
} from "./worker";
export class SQLiteD1 implements Database {
  readonly sqlite = new DatabaseSync(":memory:");
  constructor() {
    const directory = new URL("./migrations/", import.meta.url);
    for (const name of readdirSync(directory)
      .filter((name) => name.endsWith(".sql"))
      .sort())
      this.sqlite.exec(readFileSync(new URL(name, directory), "utf8"));
  }
  prepare(sql: string): Statement {
    let values: unknown[] = [];
    const args = () =>
      values.map((value) => {
        if (
          typeof value === "string" ||
          typeof value === "number" ||
          value === null
        )
          return value;
        throw new Error("Invalid SQL binding.");
      });
    const statement: Statement = {
      bind(...input) {
        values = input;
        return statement;
      },
      async first<T>() {
        const row = thisDb.sqlite.prepare(sql).get(...args());
        return row === undefined ? null : (structuredClone(row) as T);
      },
      async all<T>() {
        return {
          results: thisDb.sqlite
            .prepare(sql)
            .all(...args())
            .map((row) => structuredClone(row) as T),
        };
      },
      async run() {
        return thisDb.sqlite.prepare(sql).run(...args());
      },
    };
    const thisDb = this;
    return statement;
  }
  async batch(statements: Statement[]) {
    this.sqlite.exec("BEGIN");
    try {
      const result = [];
      for (const statement of statements) result.push(await statement.run());
      this.sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}
export const object = (value: unknown) => {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
};
export async function createCloudTestHarness(
  options: Pick<WorkerOptions, "extension"> = {},
) {
  const keys = await generateKeyPair("RS256"),
    other = await generateKeyPair("RS256");
  const jwk = await exportJWK(keys.publicKey);
  jwk.kid = "local";
  let time = Date.parse("2026-10-22T00:00:00.000Z");
  const db = new SQLiteD1();
  let context: ExtensionContext | undefined;
  const worker = createWorker({
    googleKeyResolver: createLocalJWKSet({ keys: [jwk] }),
    now: () => time,
    extension: async (request, c) => {
      context = c;
      return options.extension?.(request, c) ?? null;
    },
  });
  const env: Env = {
    DB: db,
    GOOGLE_CLIENT_IDS: "centre-test",
    GOOGLE_ALLOWED_SUBJECTS: "alice,bob,charlie",
  };
  const call = async (
    path: string,
    method = "GET",
    payload?: unknown,
    token?: string,
  ) => {
    const response = await worker.fetch(
      new Request("https://centre.test" + path, {
        method,
        headers: {
          ...(token ? { Authorization: "Bearer " + token } : {}),
          "Content-Type": "application/json",
        },
        ...(payload !== undefined
          ? {
              body:
                typeof payload === "string" ? payload : JSON.stringify(payload),
            }
          : {}),
      }),
      env,
    );
    return { status: response.status, value: object(await response.json()) };
  };
  const identity = async (
    sub: string,
    options: {
      aud?: string;
      wrongKey?: boolean;
      verified?: boolean;
      expired?: boolean;
    } = {},
  ) =>
    new SignJWT({
      email_verified: options.verified ?? true,
      email: sub + "@centre.test",
      name: sub,
    })
      .setProtectedHeader({ alg: "RS256", kid: "local" })
      .setIssuer("https://accounts.google.com")
      .setAudience(options.aud ?? "centre-test")
      .setSubject(sub)
      .setIssuedAt(Math.floor(time / 1000))
      .setExpirationTime(Math.floor(time / 1000) + (options.expired ? -1 : 300))
      .sign(options.wrongKey ? other.privateKey : keys.privateKey);
  const login = async (sub: string) => {
    const r = await call("/v1/auth/google", "POST", {
      idToken: await identity(sub),
      deviceName: sub,
    });
    assert.equal(r.status, 200);
    return r.value;
  };
  return {
    worker,
    fetch: (input: RequestInfo | URL, init?: RequestInit) =>
      worker.fetch(new Request(input, init), env),
    db,
    env,
    call,
    identity,
    login,
    setTime: (next: number) => {
      time = next;
    },
    context: () => context,
  };
}
