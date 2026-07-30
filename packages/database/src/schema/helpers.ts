import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { check } from "drizzle-orm/pg-core";

const canonicalDecimalSqlPattern = "'^-?(0|[1-9][0-9]*)([.][0-9]*[1-9])?$'";

export function canonicalDecimalCheck(name: string, column: AnyPgColumn) {
  return check(
    name,
    sql`${column} ~ ${sql.raw(canonicalDecimalSqlPattern)} AND ${column} <> '-0'`,
  );
}

export function nonNegativeCheck(name: string, column: AnyPgColumn) {
  return check(name, sql`${column} >= 0`);
}

export function positiveCheck(name: string, column: AnyPgColumn) {
  return check(name, sql`${column} > 0`);
}
