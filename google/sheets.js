const { google } = require("googleapis");

/**
 * Service Account JSON 문자열을 env로 받는 방식.
 * ENV: GOOGLE_SERVICE_ACCOUNT_JSON (JSON 전체를 문자열로)
 */
function getAuthClientFromEnv() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("ENV GOOGLE_SERVICE_ACCOUNT_JSON 이 없습니다.");

  let creds;
  try {
    creds = JSON.parse(raw);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON 파싱 실패: JSON 문자열이 맞는지 확인하세요.");
  }

  const scopes = ["https://www.googleapis.com/auth/spreadsheets"];
  const auth = new google.auth.JWT(
    creds.client_email,
    null,
    creds.private_key,
    scopes
  );
  return auth;
}

/**
 * A열=영업일자(YYYY-MM-DD), B열=지점 기준으로 업서트
 * sheetName: 일매출_RAW
 */
async function upsertByBizDateBranch({ sheetId, sheetName, auth, bizDate, branch, rowAtoO }) {
  const sheets = google.sheets({ version: "v4", auth });

  // A:B 가져와서 대상 행 찾기
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${sheetName}!A:B`,
  });

  const values = res.data.values || [];
  let targetRowNumber = null; // 1-based

  for (let i = 1; i < values.length; i++) {
    const [d, b] = values[i] || [];
    if (String(d) === String(bizDate) && String(b) === String(branch)) {
      targetRowNumber = i + 1; // 헤더 포함
      break;
    }
  }

  if (targetRowNumber) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${sheetName}!A${targetRowNumber}:O${targetRowNumber}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [rowAtoO] },
    });
    return { mode: "update", rowNumber: targetRowNumber };
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${sheetName}!A:O`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [rowAtoO] },
  });
  return { mode: "append", rowNumber: null };
}

/**
 * (영업일자, 지점) 행을 찾아 특정 칼럼들만 업데이트하고 싶을 때 사용.
 * 단순화를 위해: 전체 A:O를 다시 구성하는 방식으로 처리(안전).
 */
async function updateStatusAndAmounts({
  sheetId, sheetName, auth,
  bizDate, branch,
  patch // { salesTotal, cardSales, cashSales, otherSales, closingCash, delta, status, confirmedAt, reporter, photo1, photo2, photo3, reportId }
}) {
  // 1) 기존 행 읽기(A:O)
  const sheets = google.sheets({ version: "v4", auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${sheetName}!A:O`,
  });

  const rows = res.data.values || [];
  if (rows.length < 2) throw new Error("시트에 헤더 외 데이터가 없습니다.");

  let idx = -1;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    if (String(r[0]) === String(bizDate) && String(r[1]) === String(branch)) {
      idx = i;
      break;
    }
  }
  if (idx === -1) throw new Error(`업데이트 대상 행을 찾지 못함: ${bizDate}, ${branch}`);

  const r = rows[idx];

  // A~O (15개) 보장
  const current = Array.from({ length: 15 }, (_, k) => (r[k] ?? ""));

  // 칼럼 매핑(A=0 ... O=14)
  // A 영업일자, B 지점, C 실매출액, D 카드, E 현금, F 기타, G 마감시재, H 오차
  // I~K 사진URL, L 보고자, M 확정일시, N 상태, O 리포트ID
  const setIf = (col, v) => {
    if (v === undefined || v === null) return;
    current[col] = v;
  };

  setIf(2, patch.salesTotal);
  setIf(3, patch.cardSales);
  setIf(4, patch.cashSales);
  setIf(5, patch.otherSales);
  setIf(6, patch.closingCash);
  setIf(7, patch.delta);

  setIf(8, patch.photo1);
  setIf(9, patch.photo2);
  setIf(10, patch.photo3);

  setIf(11, patch.reporter);
  setIf(12, patch.confirmedAt);
  setIf(13, patch.status);
  setIf(14, patch.reportId);

  // 전체 row update
  const rowNumber = idx + 1;
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${sheetName}!A${rowNumber}:O${rowNumber}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [current] },
  });

  return { rowNumber };
}

module.exports = {
  getAuthClientFromEnv,
  upsertByBizDateBranch,
  updateStatusAndAmounts
};
