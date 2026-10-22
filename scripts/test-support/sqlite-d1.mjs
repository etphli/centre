import { DatabaseSync } from "node:sqlite";

export class LocalD1 {
  constructor(path = ":memory:") {
    this.sqlite = new DatabaseSync(path);
    this.batchTail = Promise.resolve();
  }

  prepare(query) {
    let values = [];
    const sqlite = this.sqlite;
    return {
      bind(...boundValues) {
        values = boundValues;
        return this;
      },
      async first() {
        return sqlite.prepare(query).get(...values) ?? null;
      },
      async run() {
        return this.runSync();
      },
      runSync() {
        const result = sqlite.prepare(query).run(...values);
        return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
      },
    };
  }

  async batch(statements) {
    const operation = this.batchTail.then(() => {
      this.sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((statement) => statement.runSync());
        this.sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        this.sqlite.exec("ROLLBACK");
        throw error;
      }
    });
    this.batchTail = operation.catch(() => {});
    return operation;
  }

  close() {
    this.sqlite.close();
  }
}
