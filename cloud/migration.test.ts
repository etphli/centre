import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { unstable_splitSqlQuery } from "wrangler";

test("Centre migration executes as statements split by the real Wrangler migration parser", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const sql = readFileSync(
      new URL("./migrations/0001_centre.sql", import.meta.url),
      "utf8",
    );
    const statements = unstable_splitSqlQuery(sql);
    assert.ok(statements.length >= 20);
    for (const statement of statements) db.exec(statement);
    db.prepare(
      "INSERT INTO centre_mutation(workspace,mutation_id,body_hash,kind,id,expected_version,updated_at,deleted,data) VALUES('proof','mutation','hash','topic','topic',0,'2026-10-22T00:00:00.000Z',0,'{}')",
    ).run();
    assert.equal(
      db
        .prepare("SELECT version FROM centre_record WHERE workspace='proof'")
        .get()?.version,
      1,
    );
  } finally {
    db.close();
  }
});
