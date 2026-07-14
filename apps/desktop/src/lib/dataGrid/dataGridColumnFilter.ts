import type { ColumnInfo, DatabaseType } from "@/types/database";
import type { DataGridColumnInfo, DataGridContextFilterMode, GridCellValue } from "@/lib/dataGrid/dataGridSql";
import { buildDataGridColumnValueFilterCondition, buildDataGridColumnValuesFilterCondition } from "@/lib/dataGrid/dataGridSql";
import { normalizeWhereInput } from "@/lib/table/tableSelectSql";

export function buildColumnValueFilterCondition(options: { databaseType?: DatabaseType; columnName: string; columnInfo?: Pick<ColumnInfo, "data_type">; rawValue: string }): Promise<string | undefined> {
  return buildDataGridColumnValueFilterCondition({
    databaseType: options.databaseType,
    columnName: options.columnName,
    columnInfo: options.columnInfo
      ? {
          name: options.columnName,
          data_type: options.columnInfo.data_type,
          is_nullable: true,
        }
      : undefined,
    rawValue: options.rawValue,
  });
}

export function buildColumnValuesFilterCondition(options: { databaseType?: DatabaseType; columnName: string; columnInfo?: Pick<ColumnInfo, "data_type">; values: GridCellValue[] }): Promise<string | undefined> {
  return buildDataGridColumnValuesFilterCondition({
    databaseType: options.databaseType,
    columnName: options.columnName,
    columnInfo: options.columnInfo
      ? {
          name: options.columnName,
          data_type: options.columnInfo.data_type,
          is_nullable: true,
        }
      : undefined,
    values: options.values,
  });
}

export function appendColumnValueFilterCondition(whereInput: string | undefined, condition: string | undefined): string {
  if (!condition) return normalizeWhereInput(whereInput);
  const existing = normalizeWhereInput(whereInput);
  return existing ? `(${existing}) AND (${condition})` : condition;
}

export function combineWhereInputs(manualWhereInput?: string, structuredWhereInput?: string): string | undefined {
  const manual = normalizeWhereInput(manualWhereInput);
  const structured = normalizeWhereInput(structuredWhereInput);
  if (manual && structured) return `(${manual}) AND (${structured})`;
  return manual || structured || undefined;
}

export function filterModeNeedsValue(mode: DataGridContextFilterMode): boolean {
  return mode !== "is-null" && mode !== "is-not-null";
}

export function filterModeUsesList(mode: DataGridContextFilterMode): boolean {
  return mode === "in" || mode === "not-in";
}

export function filterModeUsesRange(mode: DataGridContextFilterMode): boolean {
  return mode === "between" || mode === "not-between";
}

export function filterModeIsSupportedForDatabase(mode: DataGridContextFilterMode, databaseType?: DatabaseType): boolean {
  if (!filterModeUsesList(mode) && !filterModeUsesRange(mode)) return true;
  // These targets do not support all four new SQL predicates reliably.
  return databaseType !== "cassandra" && databaseType !== "influxdb" && databaseType !== "jdbc";
}

export function filterModeHasCompleteValue(mode: DataGridContextFilterMode, rawValue: string, rawEndValue = ""): boolean {
  if (!filterModeNeedsValue(mode)) return true;
  if (filterModeUsesList(mode)) return parseFilterValues(rawValue).length > 0;
  if (filterModeUsesRange(mode)) return rawValue.trim().length > 0 && rawEndValue.trim().length > 0;
  return rawValue.trim().length > 0;
}

export function parseFilterValue(rawValue: string, columnInfo?: Pick<DataGridColumnInfo, "data_type">, databaseType?: DatabaseType): GridCellValue {
  const unquoted = unwrapMatchingQuotes(rawValue.trim());
  const dataType = (columnInfo?.data_type ?? "").toLowerCase();

  if (isBooleanType(dataType, databaseType) && unquoted.toLowerCase() === "true") return true;
  if (isBooleanType(dataType, databaseType) && unquoted.toLowerCase() === "false") return false;

  if (isNumericType(dataType) && isNumericLiteral(unquoted)) {
    // Preserve the original decimal/integer spelling so the backend can emit it exactly.
    return unquoted;
  }

  if (!dataType && isNumericLiteral(unquoted)) {
    const numeric = Number(unquoted);
    if (Number.isFinite(numeric)) {
      // Keep large integers as strings to avoid JS precision loss (> Number.MAX_SAFE_INTEGER).
      if (Number.isInteger(numeric) && Math.abs(numeric) > Number.MAX_SAFE_INTEGER) {
        return unquoted;
      }
      return numeric;
    }
  }

  return unquoted;
}

export function parseFilterValues(rawValue: string, columnInfo?: Pick<DataGridColumnInfo, "data_type">, databaseType?: DatabaseType): GridCellValue[] {
  return splitFilterValues(rawValue).map(({ value, quoted }) => {
    if (!quoted && value.toLowerCase() === "null") return null;
    return parseFilterValue(value, columnInfo, databaseType);
  });
}

type ParsedFilterValue = {
  value: string;
  quoted: boolean;
};

function splitFilterValues(source: string): ParsedFilterValue[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (quote) {
      current += char;
      if (char === quote) {
        if (next === quote) {
          current += next;
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if ((char === "'" || char === '"') && current.trim().length === 0) {
      quote = char;
      current += char;
      continue;
    }

    if (char === "," || char === "\n" || char === "\r") {
      tokens.push(current);
      current = "";
      continue;
    }

    current += char;
  }
  tokens.push(current);

  return tokens.map(normalizeFilterValue).filter((value): value is ParsedFilterValue => !!value);
}

function normalizeFilterValue(token: string): ParsedFilterValue | null {
  const text = token.trim();
  if (!text) return null;

  const first = text[0];
  const last = text[text.length - 1];
  const quoted = text.length >= 2 && ((first === "'" && last === "'") || (first === '"' && last === '"'));
  if (!quoted) return { value: text, quoted: false };

  const quote = first as "'" | '"';
  const value = text.slice(1, -1).replaceAll(`${quote}${quote}`, quote);
  return { value, quoted: true };
}

function unwrapMatchingQuotes(text: string): string {
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      return text.slice(1, -1);
    }
  }
  return text;
}

function isNumericType(dataType: string): boolean {
  return ["int", "integer", "bigint", "smallint", "tinyint", "mediumint", "serial", "number", "numeric", "decimal", "float", "double", "real", "money"].some((part) => dataType.split(/[^a-z0-9]+/).includes(part));
}

function isBooleanType(dataType: string, databaseType?: DatabaseType): boolean {
  return dataType.split(/[^a-z0-9]+/).some((part) => part === "bool" || part === "boolean" || (part === "bit" && databaseType !== "postgres"));
}

function isNumericLiteral(text: string): boolean {
  if (!text || text.trim() !== text) return false;
  return Number.isFinite(Number(text)) && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text);
}
