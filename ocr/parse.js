function toNumberKRW(s) {
  if (!s) return null;
  const cleaned = String(s)
    .replace(/[₩원\s]/g, "")
    .replace(/,/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function findMoneyNear(text, keyword) {
  const lines = text
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean);

  // 1) 키워드가 들어간 라인에서 금액 추출
  for (const line of lines) {
    if (!line.includes(keyword)) continue;
    const matches = 
line.match(/-?\s*[₩]?\s*\d{1,3}(?:,\d{3})*(?:\s*원)?/g);
    if (!matches) continue;
    for (const m of matches) {
      const n = toNumberKRW(m);
      if (n !== null) return n;
    }
  }

  // 2) 전체 텍스트에서 keyword 근처(80자) 탐색
  const idx = text.indexOf(keyword);
  if (idx >= 0) {
    const window = text.slice(idx, idx + 80);
    const matches = 
window.match(/-?\s*[₩]?\s*\d{1,3}(?:,\d{3})*(?:\s*원)?/g);
    if (matches) {
      for (const m of matches) {
        const n = toNumberKRW(m);
        if (n !== null) return n;
      }
    }
  }

  return null;
}

/**
 * texts: 사진 3장 OCR 결과 텍스트 배열
 * return: { salesTotal, closingCash, delta, confidence, rawText }
 */
function extractFieldsFromOcrTexts(texts) {
  const merged = (texts || []).filter(Boolean).join("\n\n---\n\n");

  const salesTotal =
    findMoneyNear(merged, "실매출액") ??
    findMoneyNear(merged, "실매출") ??
    0;

  const closingCash =
    findMoneyNear(merged, "현금정산금") ??
    findMoneyNear(merged, "정산금") ??
    findMoneyNear(merged, "마감시재") ??
    0;

  const delta =
    findMoneyNear(merged, "오차금액") ??
    findMoneyNear(merged, "오차") ??
    0;

  const found = [salesTotal, closingCash, delta].filter(v => typeof v === 
"number" && v !== 0).length;
  const confidence = found / 3;

  return { salesTotal, closingCash, delta, confidence, rawText: merged };
}

module.exports = { extractFieldsFromOcrTexts };

