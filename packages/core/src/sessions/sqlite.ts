/**
 * The SQLite handle, for whichever runtime core is running in.
 *
 * Core was written against `bun:sqlite`, which is right for the CLI — it ships
 * inside `bun build --compile` with WAL and needs no native module. But core is
 * a *library*, and the desktop app wants to use it from Electron's main
 * process, which is Node. `bun:sqlite` does not exist there.
 *
 * MEASURED (Electron 40 = Node 24.15): `node:sqlite` is built in and covers
 * everything core actually uses — `prepare`, `all`, `get`, `run`, `iterate`,
 * and both the WAL and foreign-key pragmas. Only two things are missing, and
 * both are Bun sugar rather than SQLite features:
 *
 *   - `db.query(sql)` — a prepared statement with a cache in front of it.
 *   - `db.transaction(fn)` — a callable that wraps `fn` in BEGIN/COMMIT.
 *
 * So this is an adapter, not an abstraction: **under Bun the real
 * `bun:sqlite` Database is handed back untouched**, so the CLI's behaviour —
 * including corruption recovery and every timing characteristic — is
 * bit-for-bit what it was. Only Node gets a wrapper, and the wrapper exists
 * solely to add those two methods.
 *
 * The specifier is computed rather than written literally, so neither
 * bundler tries to resolve the other runtime's builtin at build time. Both
 * modules are runtime builtins (nothing to bundle), which is why this survives
 * `bun build --compile`.
 */
import { createRequire } from "node:module";

/** A prepared statement, in the shape core uses. */
export interface SqliteStatement<Row = unknown> {
    all(...params: unknown[]): Row[];
    get(...params: unknown[]): Row | undefined;
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    iterate(...params: unknown[]): IterableIterator<Row>;
    /**
     * Result column names, which corruption salvage uses to copy a table it
     * cannot know the shape of. Bun exposes this as a property; Node exposes
     * `columns()` returning descriptors, so the adapter derives it.
     */
    readonly columnNames: string[];
}

/** The database handle, in the shape core uses. */
export interface SqliteDatabase {
    query<Row = unknown, _Params extends unknown[] = unknown[]>(sql: string): SqliteStatement<Row>;
    prepare<Row = unknown>(sql: string): SqliteStatement<Row>;
    run(sql: string, params?: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    exec(sql: string): void;
    transaction<T>(fn: () => T): () => T;
    close(): void;
}

/** True when core is running on Bun (the CLI and every compiled binary). */
export function isBunRuntime(): boolean {
    return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
}

const require_ = createRequire(import.meta.url);

/**
 * Node's `DatabaseSync`, wrapped to add the two Bun conveniences.
 *
 * Statements are cached per SQL string exactly as `bun:sqlite`'s `query` does
 * — core calls `db.query(...)` inside hot loops (every entry insert, every
 * session list) and re-preparing each time would be a real cost, not a
 * theoretical one.
 */
interface NodeStatement {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    iterate(...params: unknown[]): IterableIterator<unknown>;
    columns(): { name: string }[];
}

interface NodeDatabase {
    prepare(sql: string): NodeStatement;
    exec(sql: string): void;
    close(): void;
}

/**
 * `columnNames` as a getter over Node's `columns()`.
 *
 * Deliberately a lazy property rather than eager work in `prepare`: only
 * corruption salvage ever reads it, and `columns()` on a statement that has
 * not been stepped is not free.
 */
function adaptStatement<Row>(statement: NodeStatement): SqliteStatement<Row> {
    return new Proxy(statement, {
        get(target, property) {
            if (property === "columnNames") return target.columns().map((column) => column.name);
            const value = Reflect.get(target, property) as unknown;
            // MEASURED: without this every call throws `TypeError: Illegal
            // invocation`. Node's StatementSync methods are native and reject a
            // `this` that is not the real statement — and an unbound method
            // pulled through a Proxy is invoked with the PROXY as `this`.
            return typeof value === "function" ? value.bind(target) : value;
        },
    }) as unknown as SqliteStatement<Row>;
}

class NodeSqliteDatabase implements SqliteDatabase {
    readonly #db: NodeDatabase;
    readonly #cache = new Map<string, SqliteStatement<never>>();

    constructor(path: string, readonly = false) {
        const { DatabaseSync } = require_("node:sqlite") as {
            DatabaseSync: new (path: string, options?: Record<string, unknown>) => NodeDatabase;
        };
        // `allowExtension` stays off: core loads no SQLite extensions, and the
        // session DB is a file other tools can write.
        this.#db = new DatabaseSync(path, { readOnly: readonly });
    }

    query<Row = unknown>(sql: string): SqliteStatement<Row> {
        const cached = this.#cache.get(sql);
        if (cached) return cached as unknown as SqliteStatement<Row>;
        const statement = adaptStatement<never>(this.#db.prepare(sql));
        this.#cache.set(sql, statement);
        return statement as unknown as SqliteStatement<Row>;
    }

    prepare<Row = unknown>(sql: string): SqliteStatement<Row> {
        return adaptStatement<Row>(this.#db.prepare(sql));
    }

    run(sql: string, params: unknown[] = []) {
        return this.query(sql).run(...params);
    }

    exec(sql: string): void {
        this.#db.exec(sql);
    }

    /**
     * BEGIN/COMMIT around `fn`, rolling back if it throws.
     *
     * `bun:sqlite`'s own `transaction()` returns a callable rather than running
     * immediately, and core relies on that (`const tx = db.transaction(...);
     * tx();`) — so this returns one too. Nested calls join the outer
     * transaction instead of failing on SQLite's "cannot start a transaction
     * within a transaction", which is what bun does.
     */
    transaction<T>(fn: () => T): () => T {
        return () => {
            if (this.#inTransaction) return fn();
            this.#inTransaction = true;
            this.#db.exec("BEGIN");
            try {
                const result = fn();
                this.#db.exec("COMMIT");
                return result;
            } catch (error) {
                try {
                    this.#db.exec("ROLLBACK");
                } catch {
                    // The transaction was already resolved (a statement error
                    // can abort it); the original failure is the useful one.
                }
                throw error;
            } finally {
                this.#inTransaction = false;
            }
        };
    }

    #inTransaction = false;

    close(): void {
        this.#cache.clear();
        this.#db.close();
    }
}

/**
 * Open the session database — or, with `readonly`, another program's
 * database that must never be written to.
 *
 * Under Bun this IS `new Database(path, ...)` — same class, same behaviour,
 * no wrapper in the path. Only Node gets the adapter above.
 */
export function openSqlite(path: string, options?: { create?: boolean; readonly?: boolean }): SqliteDatabase {
    const readonly = options?.readonly ?? false;
    if (isBunRuntime()) {
        const { Database } = require_("bun:sqlite") as {
            Database: new (path: string, options?: Record<string, unknown>) => SqliteDatabase;
        };
        return new Database(path, readonly ? { readonly: true } : { create: options?.create ?? true });
    }
    return new NodeSqliteDatabase(path, readonly);
}

/**
 * Sleep without yielding — the busy-retry backoff in `openDb`.
 *
 * `Bun.sleepSync` has no Node equivalent; `Atomics.wait` on a throwaway buffer
 * is the standard one and blocks the thread the same way, which is the point
 * (the caller is retrying an open that must not interleave).
 */
export function sleepSyncMs(ms: number): void {
    const bun = (globalThis as { Bun?: { sleepSync(ms: number): void } }).Bun;
    if (bun) {
        bun.sleepSync(ms);
        return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
