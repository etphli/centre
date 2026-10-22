import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { unstable_splitSqlQuery } from "wrangler";

test("Centre migration executes as statements split by the real Wrangler migration parser", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const copies = [
      ["0002_organato.sql", "../cloud-organato/migrations/0001_organato.sql"],
      ["0003_centre_ai.sql", "../cloud-ai/migrations/0001_centre_ai.sql"],
      ["0004_grades.sql", "../cloud-ai/migrations/0002_grades.sql"],
    ];
    for (const [central, canonical] of copies)
      assert.equal(
        readFileSync(
          new URL("./migrations/" + central, import.meta.url),
          "utf8",
        ),
        readFileSync(new URL(canonical, import.meta.url), "utf8"),
        central + " must match its module migration.",
      );
    for (const name of ["0001_centre.sql", ...copies.map(([name]) => name)]) {
      const sql = readFileSync(
          new URL("./migrations/" + name, import.meta.url),
          "utf8",
        ),
        statements = unstable_splitSqlQuery(sql);
      assert.ok(statements.length > 0);
      for (const statement of statements) db.exec(statement);
    }
    for (const name of [
      "centre_ai_runs",
      "centre_ai_grade_runs",
      "centre_organato_connections",
    ])
      assert.ok(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
          )
          .get(name),
      );
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
