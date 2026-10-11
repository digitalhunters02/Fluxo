// sqlitePool.js — faz o banco SQLite do produto (node:sqlite ou better-sqlite3: `db.prepare(sql).all/run`) falar a "língua" do pool do Postgres
// que photoImport.pg.js usa (`pool.query(sql, params)` → `{ rows, rowCount }`), traduzindo o pouco de SQL específico do Postgres.
//   const pool = sqlitePool(() => currentDb());   // currentDb() devolve o banco da empresa da requisição (um arquivo por empresa)
// Cada empresa tem o SEU banco, então o limite do mês, o crédito extra e os avisos já são por empresa sem mudar nada no router.
export function toSqlite(sql) {
  return String(sql)
    .replace(/SERIAL PRIMARY KEY/gi, "INTEGER PRIMARY KEY AUTOINCREMENT")
    .replace(/TIMESTAMPTZ NOT NULL DEFAULT now\(\)/gi, "TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))")
    .replace(/TIMESTAMPTZ/gi, "TEXT")
    .replace(/BOOLEAN NOT NULL DEFAULT FALSE/gi, "INTEGER NOT NULL DEFAULT 0")
    .replace(/\bnow\(\)/gi, "strftime('%Y-%m-%dT%H:%M:%SZ','now')")
    .replace(/::(int|text)\b/gi, "")
    .replace(/\bTRUE\b/g, "1").replace(/\bFALSE\b/g, "0")
    .replace(/\$(\d+)/g, "?$1");
}

export function sqlitePool(getDb) {
  return {
    async query(sql, params = []) {
      const db = getDb();
      const text = toSqlite(sql);
      const st = db.prepare(text);
      if (/^\s*(select|with)\b/i.test(text)) return { rows: st.all(...params).map((r) => ({ ...r })) };
      const r = st.run(...params);
      return { rows: [], rowCount: Number(r.changes ?? 0) };
    },
  };
}

// Variante para produtos que já têm helpers `all(sql, ...params)` e `run(sql, ...params)` ligados ao banco da empresa da requisição (ex.: Pulso, Mesa, Fluxo).
export function sqlitePoolFrom({ all, run }) {
  return {
    async query(sql, params = []) {
      const text = toSqlite(sql);
      if (/^\s*(select|with)\b/i.test(text)) return { rows: all(text, ...params) };
      const r = run(text, ...params);
      return { rows: [], rowCount: Number(r?.changes ?? 0) };
    },
  };
}
