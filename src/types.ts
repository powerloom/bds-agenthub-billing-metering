import Database from "better-sqlite3";

/** SQLite connection type for this service */
export type SqliteDb = InstanceType<typeof Database>;
