/**
 * The duplicate-count check, against drafts the model really wrote.
 *
 * Prompt v5 put the forbidden Thai construction in the prompt by name, and the
 * scores went clean: 8/8 on t10, no contradiction verdict, every draft judged
 * grounded. Reading the drafts said otherwise - two of the eight still bound
 * ซ้ำ ("duplicate") onto the charge total, which is the shape that promises
 * three refunds and delivers two. Neither the deterministic checks nor the
 * judge caught either one.
 *
 * So the fixtures here are the real drafts, quoted from
 * `eval/results/2026-09-09T10-42-36-127Z`, and the point of the check is to
 * make that residual a number instead of something a human has to notice.
 */
import { duplicateCountConflation } from './run';

// Two refunds were filed on every one of these runs.
const REFUNDS = 2;

describe('duplicateCountConflation', () => {
  it('flags a draft that calls the whole total duplicates', () => {
    // Run #7. "We received the report of THREE duplicate charges" - then two
    // refunds. Two true-sounding halves, the exact round-6 failure in Thai.
    expect(
      duplicateCountConflation(
        'เรียนลูกค้า เราได้รับเรื่องเรียกเก็บเงินซ้ำ 3 ครั้งสำหรับแผน Pro รายเดือน จำนวน $29.99 ' +
          'และได้ยื่นคำขอคืนเงินสำหรับ 2 รายการแล้ว',
        REFUNDS,
      ),
    ).toMatch(/3/);
  });

  it('flags it through the ซ้ำกัน form too', () => {
    // Run #2, the same claim with a different particle.
    expect(
      duplicateCountConflation(
        'เราตรวจสอบแล้วพบว่าคุณถูกเรียกเก็บเงินสำหรับแผน Pro ซ้ำกัน 3 ครั้ง และเราได้ยื่นคำขอคืนเงิน' +
          'สำหรับ 2 รายการที่เป็นการเรียกเก็บเงินซ้ำให้แล้ว',
        REFUNDS,
      ),
    ).toMatch(/3/);
  });

  it('accepts a draft that keeps the two numbers apart', () => {
    // Run #3, which is what the prompt asks for: charged three times, refunds
    // requested for the two that were duplicates.
    expect(
      duplicateCountConflation(
        'เราเห็นว่าคุณถูกตัดเงินสำหรับแผน Pro จำนวน 3 ครั้ง ครั้งละ $29.99 จริง เราได้ส่งคำขอคืนเงิน' +
          'สำหรับ 2 รายการที่เป็นการตัดเงินซ้ำไปยังฝ่ายบัญชีแล้ว',
        REFUNDS,
      ),
    ).toBeNull();
  });

  it('accepts the duplicate word bound to the refund count', () => {
    expect(
      duplicateCountConflation('เราได้ยื่นคำขอคืนเงินสำหรับรายการที่ซ้ำ 2 รายการ', REFUNDS),
    ).toBeNull();
  });

  it('reads Thai number words, not only digits', () => {
    expect(duplicateCountConflation('คุณถูกเรียกเก็บเงินซ้ำสามครั้ง', REFUNDS)).toMatch(/สาม/);
    expect(
      duplicateCountConflation('เราได้ยื่นคำขอคืนเงินสำหรับรายการซ้ำสองรายการ', REFUNDS),
    ).toBeNull();
  });

  it('says nothing about a draft with no duplicate word at all', () => {
    expect(
      duplicateCountConflation('ขอบคุณที่ติดต่อเรา ทีมงานจะตรวจสอบให้ครับ', REFUNDS),
    ).toBeNull();
  });
});
