const vision = require("@google-cloud/vision");

// Railway/로컬 ENV에 들어있는 서비스계정 JSON을 읽어서 Vision Client 생성
function getVisionClientFromEnv() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("ENV GOOGLE_SERVICE_ACCOUNT_JSON 필요");

  let creds;
  try {
    creds = JSON.parse(raw);
  } catch (e) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON JSON 파싱 실패 (따옴표/줄바꿈 확인)");
  }

  return new vision.ImageAnnotatorClient({
    credentials: {
      client_email: creds.client_email,
      private_key: creds.private_key,
    },
    projectId: creds.project_id,
  });
}

// 이미지 URL(디스코드 첨부파일 URL)을 받아 OCR 텍스트를 반환
async function ocrFromImageUrl(url) {
  const client = getVisionClientFromEnv();

  // 이미지 다운로드
  const res = await fetch(url);
  if (!res.ok) throw new Error(`이미지 다운로드 실패: ${res.status}`);

  const arrayBuf = await res.arrayBuffer();
  const buf = Buffer.from(arrayBuf);

  // Vision API는 base64(content)로 전달 가능
  const content = buf.toString("base64");

  const [result] = await client.textDetection({
    image: { content },
  });

  const text =
    result?.fullTextAnnotation?.text ||
    result?.textAnnotations?.[0]?.description ||
    "";

  return { text };
}

module.exports = { ocrFromImageUrl };
