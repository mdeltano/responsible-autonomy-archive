// Typed column readers. node:sqlite returns untyped rows; these assert each column's type instead of
// casting, so a schema drift fails loudly rather than producing a wrong value.

type Row = Record<string, unknown>;

export function text(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== "string") throw new TypeError(`Column ${column} is not text`);
  return value;
}

export function textOrNull(row: Row, column: string): string | null {
  return row[column] === null ? null : text(row, column);
}

export function int(row: Row, column: string): number {
  const value = row[column];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new TypeError(`Column ${column} is not a safe integer`);
  return value;
}

export function intOrNull(row: Row, column: string): number | null {
  return row[column] === null ? null : int(row, column);
}

export function json<T = unknown>(row: Row, column: string): T {
  return JSON.parse(text(row, column)) as T;
}

export function jsonOrNull<T = unknown>(row: Row, column: string): T | null {
  return row[column] === null ? null : json<T>(row, column);
}
