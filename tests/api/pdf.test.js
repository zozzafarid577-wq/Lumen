import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { pdfName } from '../../api/_lib/pdf.js';

describe('the PDF copy of an email', () => {
  it('is named after the subject', () => {
    expect(pdfName('S2 (Senior 2) — marks before Friday at 16:00')).toBe('S2-Senior-2-marks-before-Friday-at-16-00.pdf');
    expect(pdfName('[TEST] Hardest questions')).toBe('TEST-Hardest-questions.pdf');
    expect(pdfName('رويدا محمد — تقرير')).toBe('رويدا-محمد-تقرير.pdf');
  });

  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  it.runIf(process.platform === 'darwin' && existsSync(chrome))('prints the email, Arabic included', async () => {
    process.env.LUMEN_PDF = 'on';
    const { htmlToPdf } = await import('../../api/_lib/pdf.js');
    const pdf = await htmlToPdf('<!DOCTYPE html><html><head></head><body><h1>Marks</h1><p dir="rtl">رويدا محمد</p></body></html>');
    process.env.LUMEN_PDF = 'off';
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(pdf.length).toBeGreaterThan(5000);
  }, 30000);
});
