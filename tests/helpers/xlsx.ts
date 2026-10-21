import ExcelJS from 'exceljs';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Birinchi qator sarlavha bo'lgan xlsx buferi */
export async function xlsxBuffer(rows: unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  rows.forEach((r) => ws.addRow(r as ExcelJS.CellValue[]));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function readXlsx(buf: Buffer): Promise<unknown[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as never);
  const out: unknown[][] = [];
  wb.worksheets[0].eachRow((row) => out.push((row.values as unknown[]).slice(1)));
  return out;
}

export const HEADER = ['F.I.Sh.', 'Sinf', "Tug'ilgan sana", 'Jinsi', 'ID', 'Ota-ona telefoni'];
