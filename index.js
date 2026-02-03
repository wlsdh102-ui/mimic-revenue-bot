const {
  Client, GatewayIntentBits,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  EmbedBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  InteractionType
} = require("discord.js");

const { DateTime } = require("luxon");
const {
  getAuthClientFromEnv,
  upsertByBizDateBranch,
  updateStatusAndAmounts
} = require("./google/sheets");

// ✅ OCR 추가
const { ocrFromImageUrl } = require("./google/vision");
const { extractFieldsFromOcrTexts } = require("./ocr/parse");

// ===== ENV =====
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const SHEET_ID = process.env.SHEET_ID;
const RAW_SHEET_NAME = process.env.RAW_SHEET_NAME || "일매출_RAW";
const FINANCE_ROLE_ID = process.env.FINANCE_ROLE_ID; // 재무 역할 ID (필수)
const TZ = "Asia/Seoul";

if (!DISCORD_TOKEN) throw new Error("ENV DISCORD_TOKEN 필요");
if (!SHEET_ID) throw new Error("ENV SHEET_ID 필요");
if (!FINANCE_ROLE_ID) throw new Error("ENV FINANCE_ROLE_ID 필요");

// ===== Google Auth =====
const auth = getAuthClientFromEnv();

// ===== Discord Client =====
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

function todayISO() {
  return DateTime.now().setZone(TZ).toFormat("yyyy-LL-dd");
}

function validateBizDate(str) {
  return /^\d{4}-\d{2}-\d{2}$/.test(str);
}

function won(n) {
  const x = Number(n || 0);
  return x.toLocaleString("ko-KR");
}

function financeOnly(interaction) {
  const member = interaction.member;
  if (!member || !member.roles) return false;
  return member.roles.cache.has(FINANCE_ROLE_ID);
}

function buildButtons(reportId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`rev:ok:${reportId}`).setLabel("확정(OK)").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`rev:review:${reportId}`).setLabel("검수필요").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`rev:reshoot:${reportId}`).setLabel("재촬영").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`rev:edit:${reportId}`).setLabel("수정").setStyle(ButtonStyle.Primary)
  );
}

function buildEmbed({
  branch, bizDate, reporterTag,
  photo1, photo2, photo3,
  status, memo,
  salesTotal, closingCash, delta,
  ocrConfidence,
  ocrNote
}) {
  const e = new EmbedBuilder()
    .setTitle("매출 보고 접수")
    .addFields(
      { name: "지점", value: branch, inline: true },
      { name: "영업일자", value: bizDate, inline: true },
      { name: "상태", value: status, inline: true },
      { name: "보고자", value: reporterTag, inline: false },
      { name: "실매출액", value: `₩ ${won(salesTotal)}`, inline: true },
      { name: "마감시재", value: `₩ ${won(closingCash)}`, inline: true },
      { name: "오차", value: `₩ ${won(delta)}`, inline: true }
    );

  if (typeof ocrConfidence === "number") {
    e.addFields({ name: "OCR 신뢰도", value: `${Math.round(ocrConfidence * 100)}%`, inline: true });
  }
  if (ocrNote) {
    e.addFields({ name: "OCR 메모", value: ocrNote, inline: false });
  }

  if (memo) e.addFields({ name: "메모", value: memo, inline: false });

  e.addFields(
    { name: "사진1", value: photo1 || "-", inline: false },
    { name: "사진2", value: photo2 || "-", inline: false },
    { name: "사진3", value: photo3 || "-", inline: false }
  );

  e.setFooter({ text: "재무 담당자가 버튼으로 확정/검수/재촬영/수정 처리" });
  return e;
}

async function runOcrFor3Photos(photoUrls) {
  const urls = (photoUrls || []).filter(Boolean);
  if (urls.length !== 3) throw new Error("사진 URL 3개가 필요합니다.");

  // 병렬 OCR
  const texts = await Promise.all(urls.map(u => ocrFromImageUrl(u).then(r => r.text)));
  const { salesTotal, closingCash, delta, confidence } = extractFieldsFromOcrTexts(texts);

  // 운영상 방어: 값이 모두 0이면 OCR 실패로 간주
  const allZero = (Number(salesTotal) === 0 && Number(closingCash) === 0 && Number(delta) === 0);
  const note =
    allZero ? "OCR 결과가 모두 0입니다. (검수/수정 권장)" :
    confidence < 0.67 ? "OCR 신뢰도가 낮습니다. (검수/수정 권장)" :
    "OCR 자동 추출 완료";

  return { salesTotal, closingCash, delta, confidence, note };
}

async function upsertPendingFromCommand(interaction) {
  // OCR 때문에 응답 지연될 수 있어 defer
  await interaction.deferReply();

  const branch = interaction.options.getString("branch", true);
  const bizDateInput = interaction.options.getString("biz_date", false);
  const bizDate = bizDateInput ? bizDateInput : todayISO();

  if (!validateBizDate(bizDate)) {
    await interaction.editReply({ content: "biz_date 형식이 올바르지 않습니다. 예: 2026-01-31" });
    return;
  }

  const photo1 = interaction.options.getAttachment("photo1", true)?.url;
  const photo2 = interaction.options.getAttachment("photo2", true)?.url;
  const photo3 = interaction.options.getAttachment("photo3", true)?.url;
  const memo = interaction.options.getString("memo", false) || "";

  const reporterTag = `${interaction.user.username}#${interaction.user.discriminator}`;
  const reportId = String(interaction.id);

  // 1차 MVP: 카드/현금/기타 분해는 아직 0 유지
  let salesTotal = 0;
  let cardSales = 0;
  let cashSales = 0;
  let otherSales = 0;
  let closingCash = 0;
  let delta = 0;

  let ocrConfidence = null;
  let ocrNote = "";

  // ✅ OCR 실행 (실패해도 접수는 진행)
  try {
    const r = await runOcrFor3Photos([photo1, photo2, photo3]);
    salesTotal = r.salesTotal;
    closingCash = r.closingCash;
    delta = r.delta;
    ocrConfidence = r.confidence;
    ocrNote = r.note;
  } catch (e) {
    console.error("OCR 실패:", e);
    ocrNote = `OCR 실패: ${e.message}`;
  }

  const confirmedAt = "";
  const status = "PENDING";

  // A~O row 구성 (현재 시트 구조 유지)
  const row = [
    bizDate,        // A 영업일자
    branch,         // B 지점
    salesTotal,     // C 실매출액
    cardSales,      // D 카드
    cashSales,      // E 현금
    otherSales,     // F 기타
    closingCash,    // G 마감시재
    delta,          // H 오차
    photo1,         // I
    photo2,         // J
    photo3,         // K
    reporterTag,    // L 보고자
    confirmedAt,    // M 확정일시
    status,         // N 상태
    reportId        // O 리포트ID
  ];

  await upsertByBizDateBranch({
    sheetId: SHEET_ID,
    sheetName: RAW_SHEET_NAME,
    auth,
    bizDate,
    branch,
    rowAtoO: row
  });

  const embed = buildEmbed({
    branch, bizDate, reporterTag,
    photo1, photo2, photo3,
    status,
    memo,
    salesTotal, closingCash, delta,
    ocrConfidence,
    ocrNote
  });

  await interaction.editReply({
    embeds: [embed],
    components: [buildButtons(reportId)]
  });
}

async function handleStatusButton(interaction, mode) {
  if (!financeOnly(interaction)) {
    await interaction.reply({ content: "재무 권한이 없습니다.", ephemeral: true });
    return;
  }

  const msg = interaction.message;
  const embed = msg.embeds?.[0];
  if (!embed) {
    await interaction.reply({ content: "원본 보고 Embed를 찾지 못했습니다.", ephemeral: true });
    return;
  }

  const fields = embed.fields || [];
  const branch = fields.find(f => f.name === "지점")?.value;
  const bizDate = fields.find(f => f.name === "영업일자")?.value;

  if (!branch || !bizDate) {
    await interaction.reply({ content: "지점/영업일자 값을 읽지 못했습니다.", ephemeral: true });
    return;
  }

  const confirmedAt = DateTime.now().setZone(TZ).toFormat("yyyy-LL-dd HH:mm:ss");
  const status =
    mode === "ok" ? "OK" :
    mode === "review" ? "NEEDS_REVIEW" :
    mode === "reshoot" ? "RESHOOT" : "PENDING";

  const reportId = interaction.customId.split(":")[2];

  await updateStatusAndAmounts({
    sheetId: SHEET_ID,
    sheetName: RAW_SHEET_NAME,
    auth,
    bizDate,
    branch,
    patch: { status, confirmedAt, reportId }
  });

  const newEmbed = EmbedBuilder.from(embed);
  const newFields = fields.map(f => (f.name === "상태" ? { ...f, value: status } : f));
  newEmbed.setFields(newFields);

  await interaction.reply({ content: `✅ 상태 업데이트: ${status}`, ephemeral: true });
  await msg.edit({ embeds: [newEmbed] });
}

async function handleEditButton(interaction) {
  if (!financeOnly(interaction)) {
    await interaction.reply({ content: "재무 권한이 없습니다.", ephemeral: true });
    return;
  }

  const msg = interaction.message;
  const embed = msg.embeds?.[0];
  if (!embed) {
    await interaction.reply({ content: "원본 보고 Embed를 찾지 못했습니다.", ephemeral: true });
    return;
  }

  const fields = embed.fields || [];
  const branch = fields.find(f => f.name === "지점")?.value;
  const bizDate = fields.find(f => f.name === "영업일자")?.value;

  if (!branch || !bizDate) {
    await interaction.reply({ content: "지점/영업일자 값을 읽지 못했습니다.", ephemeral: true });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`rev:modal_edit:${branch}:${bizDate}`)
    .setTitle("금액 수정(숫자만 입력)");

  const salesInput = new TextInputBuilder()
    .setCustomId("salesTotal")
    .setLabel("실매출액 (예: 380000)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const closingInput = new TextInputBuilder()
    .setCustomId("closingCash")
    .setLabel("마감시재 (예: 51000)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const deltaInput = new TextInputBuilder()
    .setCustomId("delta")
    .setLabel("오차금액 (예: -600000)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(salesInput),
    new ActionRowBuilder().addComponents(closingInput),
    new ActionRowBuilder().addComponents(deltaInput)
  );

  await interaction.showModal(modal);
}

function parseIntSafe(s) {
  const cleaned = String(s).replace(/[,\s₩원]/g, "");
  if (!/^[-]?\d+$/.test(cleaned)) return null;
  return Number(cleaned);
}

async function handleEditModalSubmit(interaction) {
  if (!financeOnly(interaction)) {
    await interaction.reply({ content: "재무 권한이 없습니다.", ephemeral: true });
    return;
  }

  const parts = interaction.customId.split(":");
  const branch = parts[2];
  const bizDate = parts[3];

  const salesTotal = parseIntSafe(interaction.fields.getTextInputValue("salesTotal"));
  const closingCash = parseIntSafe(interaction.fields.getTextInputValue("closingCash"));
  const delta = parseIntSafe(interaction.fields.getTextInputValue("delta"));

  if (salesTotal === null || closingCash === null || delta === null) {
    await interaction.reply({ content: "숫자 형식이 올바르지 않습니다. 예: 380000 / -600000", ephemeral: true });
    return;
  }

  const confirmedAt = DateTime.now().setZone(TZ).toFormat("yyyy-LL-dd HH:mm:ss");
  const status = "NEEDS_REVIEW";

  await updateStatusAndAmounts({
    sheetId: SHEET_ID,
    sheetName: RAW_SHEET_NAME,
    auth,
    bizDate,
    branch,
    patch: { salesTotal, closingCash, delta, status, confirmedAt }
  });

  await interaction.reply({
    content: `✏️ 수정 반영 완료: ${branch} / ${bizDate}\n- 실매출: ₩${won(salesTotal)}\n- 시재: ₩${won(closingCash)}\n- 오차: ₩${won(delta)}\n상태: ${status}`,
    ephemeral: true
  });
}

client.on("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === "매출보고") {
      await upsertPendingFromCommand(interaction);
      return;
    }

    if (interaction.isButton()) {
      const id = interaction.customId;
      if (id.startsWith("rev:ok:")) return await handleStatusButton(interaction, "ok");
      if (id.startsWith("rev:review:")) return await handleStatusButton(interaction, "review");
      if (id.startsWith("rev:reshoot:")) return await handleStatusButton(interaction, "reshoot");
      if (id.startsWith("rev:edit:")) return await handleEditButton(interaction);
    }

    if (interaction.type === InteractionType.ModalSubmit) {
      if (interaction.customId.startsWith("rev:modal_edit:")) {
        return await handleEditModalSubmit(interaction);
      }
    }
  } catch (err) {
    console.error(err);
    if (interaction.deferred || interaction.replied) return;
    await interaction.reply({ content: `에러: ${err.message}`, ephemeral: true });
  }
});

client.login(DISCORD_TOKEN);
