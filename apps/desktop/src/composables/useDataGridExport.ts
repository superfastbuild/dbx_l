import { computed, type ComputedRef, type Ref } from "vue";
import { useI18n } from "vue-i18n";
import { isTauriRuntime } from "@/lib/tauriRuntime";
import { formatCsv, formatJson } from "@/lib/exportFormats";
import {
  formatSelectionAsCsv,
  formatSelectionAsJson,
  formatSelectionAsSqlInList,
  formatSelectionAsTsv,
  type CellSelectionRange,
  type SelectionData,
} from "@/lib/gridSelection";
import { useToast } from "@/composables/useToast";
import { displayCellValue, type CellValue } from "@/lib/cellValue";
import { tryStartExclusiveActivation, type ActionActivationGuard } from "@/lib/actionActivation";
import { copyToClipboard } from "@/lib/clipboard";
import { buildDataGridCopyInsertStatement, buildDataGridCopyUpdateStatements } from "@/lib/dataGridSql";
import type { DatabaseType } from "@/types/database";

interface RowItem {
  id: number;
  sourceIndex?: number;
  newIndex?: number;
  data: CellValue[];
  isNew: boolean;
  isDeleted: boolean;
  isDirtyCol: boolean[];
  status: string;
}

export interface UseDataGridExportOptions {
  columns: ComputedRef<string[]>;
  displayItems: ComputedRef<RowItem[]>;
  sql: ComputedRef<string | undefined>;
  tableMeta: ComputedRef<{ schema?: string; tableName: string; primaryKeys: string[] } | undefined>;
  databaseType: ComputedRef<DatabaseType | undefined>;
  sourceColumns: ComputedRef<Array<string | undefined> | undefined>;
  hasCellSelection: ComputedRef<boolean>;
  selectedCells: ComputedRef<SelectionData>;
  selectedRange: ComputedRef<CellSelectionRange | null>;
  contextCell:
    | Ref<{ rowId: number; rowIndex: number; col: number } | null>
    | ComputedRef<{ rowId: number; rowIndex: number; col: number } | null>;
  getRowItem: (rowId: number) => RowItem | undefined;
  selectedRowIds: Ref<Set<number>> | ComputedRef<Set<number>>;
  hasRowSelection: ComputedRef<boolean>;
}

export function useDataGridExport(options: UseDataGridExportOptions) {
  const { t } = useI18n();
  const { toast } = useToast();
  const exportGuard: ActionActivationGuard = {};

  const {
    columns,
    displayItems,
    sql,
    tableMeta,
    sourceColumns,
    databaseType,
    hasCellSelection,
    selectedCells,
    selectedRange,
    contextCell,
    getRowItem,
    selectedRowIds,
    hasRowSelection,
  } = options;

  async function copyText(text: string) {
    try {
      await copyToClipboard(text);
      toast(t("grid.copied"));
    } catch (e: any) {
      toast(t("grid.copyFailed", { message: e?.message || String(e) }), 5000);
    }
  }

  function rowsToExport(rowIds?: number[]): RowItem[] {
    if (!rowIds?.length) return displayItems.value;
    const rowIdSet = new Set(rowIds);
    return displayItems.value.filter((item) => rowIdSet.has(item.id));
  }

  function targetedRows(): RowItem[] {
    if (hasRowSelection.value && selectedRowIds.value.size > 0) {
      return displayItems.value.filter((item) => selectedRowIds.value.has(item.id));
    }
    const range = selectedRange.value;
    if (range && range.startRow !== range.endRow) {
      return displayItems.value.slice(range.startRow, range.endRow + 1);
    }
    if (!contextCell.value) return [];
    const item = getRowItem(contextCell.value.rowId);
    return item ? [item] : [];
  }

  function updateEligibleRows(): RowItem[] {
    return targetedRows().filter((item) => !item.isNew && !item.isDeleted);
  }

  // --- Selection copy functions ---
  async function copySelectionTsv() {
    if (!hasCellSelection.value) return;
    await copyText(formatSelectionAsTsv(selectedCells.value));
  }

  async function copySelectionCsv() {
    if (!hasCellSelection.value) return;
    await copyText(formatSelectionAsCsv(selectedCells.value));
  }

  async function copySelectionJson() {
    if (!hasCellSelection.value) return;
    await copyText(formatSelectionAsJson(selectedCells.value));
  }

  async function copySelectionSqlInList() {
    if (!hasCellSelection.value) return;
    await copyText(formatSelectionAsSqlInList(selectedCells.value));
  }

  // --- Cell/row copy ---
  async function copyCell() {
    if (!contextCell.value || contextCell.value.col < 0) return;
    const item = getRowItem(contextCell.value.rowId);
    const val = item?.data[contextCell.value.col] ?? null;
    await copyText(displayCellValue(val));
  }

  async function copyRow() {
    if (hasRowSelection.value && selectedRowIds.value.size > 0) {
      const items = displayItems.value.filter((item) => selectedRowIds.value.has(item.id));
      const objects = items.map((item) => {
        const obj: Record<string, unknown> = {};
        columns.value.forEach((col, i) => {
          obj[col] = item.data[i];
        });
        return obj;
      });
      await copyText(JSON.stringify(objects, null, 2));
      return;
    }
    const range = selectedRange.value;
    if (range && range.startRow !== range.endRow) {
      const items = displayItems.value.slice(range.startRow, range.endRow + 1);
      const objects = items.map((item) => {
        const obj: Record<string, unknown> = {};
        columns.value.forEach((col, i) => {
          obj[col] = item.data[i];
        });
        return obj;
      });
      await copyText(JSON.stringify(objects, null, 2));
      return;
    }
    if (!contextCell.value) return;
    const item = getRowItem(contextCell.value.rowId);
    if (!item) return;
    const obj: Record<string, unknown> = {};
    columns.value.forEach((col, i) => {
      obj[col] = item.data[i];
    });
    await copyText(JSON.stringify(obj, null, 2));
  }

  function insertEligibleRows(): RowItem[] {
    return targetedRows();
  }

  async function copyRowAsInsertStatement(excludePrimaryKeys: boolean) {
    const statement = buildDataGridCopyInsertStatement({
      databaseType: databaseType.value,
      tableMeta: tableMeta.value,
      columns: columns.value,
      sourceColumns: sourceColumns.value,
      rows: insertEligibleRows().map((item) => item.data),
      excludePrimaryKeys,
    });
    if (!statement) return;
    await copyText(statement);
  }

  async function copyRowAsInsert() {
    await copyRowAsInsertStatement(false);
  }

  async function copyRowAsInsertWithoutPrimaryKeys() {
    await copyRowAsInsertStatement(true);
  }

  async function copyRowAsUpdate() {
    if (!tableMeta.value?.primaryKeys.length) return;
    const statements = buildDataGridCopyUpdateStatements({
      databaseType: databaseType.value,
      tableMeta: tableMeta.value,
      columns: columns.value,
      sourceColumns: sourceColumns.value,
      rows: updateEligibleRows().map((item) => item.data),
    });
    if (!statements.length) return;
    await copyText(statements.join("\n"));
  }

  const canCopyRowAsUpdate = computed(() => {
    if (!tableMeta.value?.primaryKeys.length) return false;
    const rows = updateEligibleRows();
    if (!rows.length) return false;
    return (
      buildDataGridCopyUpdateStatements({
        databaseType: databaseType.value,
        tableMeta: tableMeta.value,
        columns: columns.value,
        sourceColumns: sourceColumns.value,
        rows: [rows[0].data],
      }).length > 0
    );
  });

  const canCopyRowAsInsertWithoutPrimaryKeys = computed(() => {
    if (!tableMeta.value?.primaryKeys.length) return false;
    const rows = insertEligibleRows();
    if (!rows.length) return false;
    return !!buildDataGridCopyInsertStatement({
      databaseType: databaseType.value,
      tableMeta: tableMeta.value,
      columns: columns.value,
      sourceColumns: sourceColumns.value,
      rows: [rows[0].data],
      excludePrimaryKeys: true,
    });
  });

  async function copyAll() {
    const header = columns.value.join("\t");
    const body = displayItems.value.map((item) => item.data.map((c) => displayCellValue(c)).join("\t")).join("\n");
    await copyText(`${header}\n${body}`);
  }

  // --- File save helpers ---
  async function saveFileContent(
    content: string,
    defaultFileName: string,
    filterName: string,
    filterExt: string,
  ): Promise<boolean> {
    if (isTauriRuntime()) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      const path = await save({
        defaultPath: defaultFileName,
        filters: [{ name: filterName, extensions: [filterExt] }],
      });
      if (!path) return false;
      await writeTextFile(path, "﻿" + content);
      return true;
    } else {
      const blob = new Blob(["﻿", content], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = defaultFileName;
      a.click();
      URL.revokeObjectURL(url);
      return true;
    }
  }

  async function saveBinaryFileContent(
    content: Uint8Array,
    defaultFileName: string,
    filterName: string,
    filterExt: string,
  ): Promise<boolean> {
    if (isTauriRuntime()) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeFile } = await import("@tauri-apps/plugin-fs");
      const path = await save({
        defaultPath: defaultFileName,
        filters: [{ name: filterName, extensions: [filterExt] }],
      });
      if (!path) return false;
      await writeFile(path, content);
      return true;
    } else {
      const blob = new Blob([content], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = defaultFileName;
      a.click();
      URL.revokeObjectURL(url);
      return true;
    }
  }

  // --- Export functions ---
  async function runExclusiveExport(action: () => Promise<void>) {
    const finish = tryStartExclusiveActivation(exportGuard);
    if (!finish) return;
    try {
      await action();
    } finally {
      finish();
    }
  }

  async function exportCsv(rowIds?: number[]) {
    await runExclusiveExport(async () => {
      try {
        const rows = rowsToExport(rowIds).map((item) => item.data.map((c) => displayCellValue(c)));
        if (await saveFileContent(formatCsv(columns.value, rows), "export.csv", "CSV", "csv")) {
          toast(t("grid.exported"));
        }
      } catch (e: any) {
        toast(t("grid.exportFailed", { message: e?.message || String(e) }), 5000);
      }
    });
  }

  async function exportJson(rowIds?: number[]) {
    await runExclusiveExport(async () => {
      try {
        const rows = rowsToExport(rowIds).map((item) => item.data);
        if (await saveFileContent(formatJson(columns.value, rows), "export.json", "JSON", "json")) {
          toast(t("grid.exported"));
        }
      } catch (e: any) {
        toast(t("grid.exportFailed", { message: e?.message || String(e) }), 5000);
      }
    });
  }

  async function exportMarkdown(rowIds?: number[]) {
    await runExclusiveExport(async () => {
      try {
        const cols = columns.value;
        const visibleRows = rowsToExport(rowIds).map((item) => item.data);
        const { formatMarkdownTable } = await import("@/lib/markdownTable");
        const md = formatMarkdownTable({ columns: cols, rows: visibleRows });
        if (await saveFileContent(md, "export.md", "Markdown", "md")) {
          toast(t("grid.exported"));
        }
      } catch (e: any) {
        toast(t("grid.exportFailed", { message: e?.message || String(e) }), 5000);
      }
    });
  }

  async function exportXlsx(rowIds?: number[]) {
    await runExclusiveExport(async () => {
      try {
        const { buildXlsxWorkbook } = await import("@/lib/xlsxExport");
        const workbook = buildXlsxWorkbook({
          sheetName: tableMeta.value?.tableName || "Export",
          columns: columns.value,
          rows: rowsToExport(rowIds).map((item) => item.data),
        });
        if (await saveBinaryFileContent(workbook, "export.xlsx", "Excel", "xlsx")) {
          toast(t("grid.exported"));
        }
      } catch (e: any) {
        toast(t("grid.exportFailed", { message: e?.message || String(e) }), 5000);
      }
    });
  }

  async function copySql() {
    if (!sql.value) return;
    await copyText(sql.value);
  }

  return {
    copyText,
    copyCell,
    copyRow,
    copyRowAsInsert,
    copyRowAsInsertWithoutPrimaryKeys,
    copyRowAsUpdate,
    canCopyRowAsInsertWithoutPrimaryKeys,
    canCopyRowAsUpdate,
    copyAll,
    copySelectionTsv,
    copySelectionCsv,
    copySelectionJson,
    copySelectionSqlInList,
    exportCsv,
    exportJson,
    exportMarkdown,
    exportXlsx,
    copySql,
  };
}
