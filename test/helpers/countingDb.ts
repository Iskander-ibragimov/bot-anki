/** Wraps a D1Database and counts calls that hit D1 (each is one subrequest on Workers). */
export type CountingDb = D1Database & { calls: number };

export function countingDb(db: D1Database): CountingDb {
  const state = { calls: 0 };
  const wrapStmt = (s: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(s, {
      get(target, prop, recv) {
        if (prop === "__raw") return target;
        if (prop === "bind") return (...args: unknown[]) => wrapStmt(target.bind(...args));
        if (prop === "first" || prop === "all" || prop === "run" || prop === "raw")
          return (...args: unknown[]) => {
            state.calls++;
            return (target[prop] as (...a: unknown[]) => unknown).apply(target, args);
          };
        return Reflect.get(target, prop, recv);
      },
    });
  return new Proxy(db, {
    get(target, prop, recv) {
      if (prop === "calls") return state.calls;
      if (prop === "prepare") return (sql: string) => wrapStmt(target.prepare(sql));
      if (prop === "batch")
        return (stmts: D1PreparedStatement[]) => {
          state.calls++;
          return target.batch(stmts.map((s) => (s as unknown as { __raw?: D1PreparedStatement }).__raw ?? s));
        };
      if (prop === "exec") return (sql: string) => { state.calls++; return target.exec(sql); };
      return Reflect.get(target, prop, recv);
    },
    set(_t, prop, value) {
      if (prop === "calls") { state.calls = value as number; return true; }
      return false;
    },
  }) as CountingDb;
}
